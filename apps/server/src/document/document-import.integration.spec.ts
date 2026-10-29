import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { buildTypeOrmOptions } from '../database/typeorm.options.js';
import { DocumentImportService } from './document-import.service.js';
import { DocumentVersionService } from './document-version.service.js';
import { CategoryService } from './category.service.js';
import { DocumentImportEntity } from './entities/document-import.entity.js';
import { DocumentResourceEntity } from './entities/document-resource.entity.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentContentEntity } from './entities/document-content.entity.js';
import { DocumentImports1790000002000 } from '../database/migrations/1790000002000-document-imports.js';
import { DocumentImportDismiss1790000003000 } from '../database/migrations/1790000003000-document-import-dismiss.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

const enabled = process.env.RUN_IMPORT_INTEGRATION === 'true';
const actor: AuthUser = { userId: '100', username: 'import-test', roles: [], permissions: ['document:create'], teamIds: [] };
const outsider: AuthUser = { ...actor, userId: '101' };
const schema = `import_test_${randomUUID().replaceAll('-', '')}`;
let ds: DataSource;
let admin: DataSource;
let service: DocumentImportService;
let parseCount = 0;
let parseFailure = false;
const objects = new Map<string, Buffer>();
const file = { originalname: 'sample.txt', buffer: Buffer.from('hello scanned document'), size: 22, mimetype: 'text/plain' } as Express.Multer.File;

const storage = {
  isEnabled: () => true,
  getActiveDriverName: () => 'rustfs',
  async uploadBytes(bytes: Buffer, opts: { objectKey: string }) {
    objects.set(opts.objectKey, Buffer.from(bytes));
    return { key: opts.objectKey, url: `https://storage.invalid/${opts.objectKey}` };
  },
  async readBytes(key: string) {
    const bytes = objects.get(key);
    if (!bytes) throw new Error('missing object');
    return Buffer.from(bytes);
  },
  async deleteObject(key: string) { objects.delete(key); },
};
const parser = {
  isSupported: (ext: string) => ext === 'txt', supportedList: () => 'txt',
  async parse(input: { buffer: Buffer }, options: { onCheckpoint?: (checkpoint: unknown) => Promise<void> }) {
    parseCount++;
    expect(input.buffer.toString()).toBe('hello scanned document');
    await options.onCheckpoint?.({ batchId: 'batch-1', uploadUrl: 'https://private.invalid/signed', uploaded: true });
    if (parseFailure) throw new Error('external URL with secret must not escape');
    return { markdown: '# Scanned text\n\nhello world\n\n![](images/chart.png)', images: [{ path: 'images/chart.png', bytes: Buffer.from('fake image bytes'), contentType: 'image/png' }], warnings: [], parser: 'fixture' };
  },
};

describe.skipIf(!enabled)('Document imports with PostgreSQL transactions', () => {
  beforeAll(async () => {
    admin = new DataSource({ ...buildTypeOrmOptions(), entities: [], migrations: [] });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.kh_document (LIKE public.kh_document INCLUDING ALL)`);
    await admin.query(`CREATE TABLE ${schema}.kh_document_content (LIKE public.kh_document_content INCLUDING ALL)`);
    ds = new DataSource({ ...buildTypeOrmOptions(), schema, entities: [DocumentImportEntity, DocumentResourceEntity, DocumentEntity, DocumentContentEntity], migrations: [], extra: { options: `-c search_path=${schema},public` } } as DataSourceOptions);
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await runner.connect();
    await new DocumentImports1790000002000().up(runner);
    await new DocumentImportDismiss1790000003000().up(runner);
    await runner.release();
  });
  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE kh_document_resource, kh_document_import, kh_document_content, kh_document CASCADE');
    objects.clear(); parseCount = 0; parseFailure = false;
    service = new DocumentImportService(ds.manager, parser as never, storage as never, new ConfigService({ REDIS_ENABLED: 'true' }), new DocumentVersionService(ds.manager), new CategoryService(ds.manager));
  });
  it('persists encrypted source, completes one private draft and never exposes checkpoint or keys', async () => {
    const submitted = await service.submit(file, { requestId: randomUUID() }, actor);
    expect(submitted.state).toBe('queued');
    expect(submitted.documentId).toBeNull();
    expect([...objects.values()][0].includes(file.buffer)).toBe(false);
    await service.process(submitted.id);
    const result = await service.get(submitted.id, actor);
    expect(result.state).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('private.invalid');
    expect(JSON.stringify(result)).not.toContain('encryptionKey');
    const docs = await ds.manager.find(DocumentEntity);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ authorId: '100', isPublic: false, status: 0 });
    const content = await ds.manager.findOneByOrFail(DocumentContentEntity, { documentId: docs[0].id });
    expect(content.content).toContain(`/documents/${docs[0].id}/assets/`);
    expect(content.content).not.toContain('images/chart.png');
    const source = await service.readResource(docs[0].id, null, actor);
    expect(source.bytes.toString()).toBe('hello scanned document');
    await expect(service.readResource(docs[0].id, null, outsider)).rejects.toThrow();
    await service.process(submitted.id);
    expect(parseCount).toBe(1);
    expect(await ds.manager.count(DocumentEntity)).toBe(1);
  });
  it('explains a missing MinerU token without leaking internal details', async () => {
    const original = parser.parse;
    const task = await service.submit(file, {}, actor);
    parser.parse = async () => {
      const { MineruError } = await import('./parser/mineru-error.js');
      throw new MineruError('token missing at https://secret.invalid', 'MINERU_NOT_CONFIGURED');
    };
    try {
      await service.process(task.id);
      const view = await service.get(task.id, actor);
      expect(view.error).toContain('MINERU_API_TOKEN');
      expect(view.error).not.toContain('secret.invalid');
    } finally {
      parser.parse = original;
    }
  });
  it('recovers a queued task left in uploading after source persistence', async () => {
    const task = await service.submit(file, { requestId: randomUUID() }, actor);
    await ds.manager.update(DocumentImportEntity, { id: task.id }, { stage: 'uploading' });
    expect((await service.pending()).map((item) => item.id)).toContain(task.id);
    await service.process(task.id);
    expect((await service.get(task.id, actor)).state).toBe('completed');
  });
  it('deduplicates repeated and concurrent submissions and rejects requestId reused for different content', async () => {
    const meta = { requestId: randomUUID() };
    const [first, second] = await Promise.all([service.submit(file, meta, actor), service.submit(file, meta, actor)]);
    expect(first.id).toBe(second.id);
    expect(await ds.manager.count(DocumentImportEntity)).toBe(1);
    await expect(service.submit({ ...file, buffer: Buffer.from('different') }, meta, actor)).rejects.toThrow();
    await Promise.all([service.process(first.id), service.process(first.id)]);
    expect(await ds.manager.count(DocumentEntity)).toBe(1);
  });
  it('restricts task lookup and retry to its owner and keeps failures out of document tables', async () => {
    const submitted = await service.submit(file, { requestId: randomUUID() }, actor);
    await expect(service.get(submitted.id, outsider)).rejects.toThrow();
    await expect(service.retry(submitted.id, outsider)).rejects.toThrow();
    parseFailure = true;
    await service.process(submitted.id);
    const failed = await service.get(submitted.id, actor);
    expect(failed.state).toBe('failed');
    expect(failed.error).not.toContain('secret');
    expect(await ds.manager.count(DocumentEntity)).toBe(0);
    parseFailure = false;
    await service.retry(submitted.id, actor);
    await service.process(submitted.id);
    expect((await service.get(submitted.id, actor)).state).toBe('completed');
  });
  it('rejects spoofed ownership and unsupported/oversized uploads before writing objects', async () => {
    await expect(service.submit(file, { authorId: '101' }, actor)).rejects.toThrow();
    await expect(service.submit({ ...file, originalname: 'payload.exe' }, {}, actor)).rejects.toThrow();
    expect(objects.size).toBe(0);
  });
  it('hides finished records without touching documents, and refuses to hide active tasks', async () => {
    const done = await service.submit(file, { requestId: randomUUID() }, actor);
    await service.process(done.id);
    const active = await service.submit({ ...file, originalname: 'second.txt' }, { requestId: randomUUID() }, actor);
    await expect(service.dismiss(active.id, actor)).rejects.toThrow();
    await service.dismiss(done.id, actor);
    expect((await service.list(actor)).items.map((item) => item.id)).toEqual([active.id]);
    const result = await service.get(done.id, actor);
    expect(result.state).toBe('completed');
    const source = await service.readResource(result.documentId!, null, actor);
    expect(source.bytes.toString()).toBe('hello scanned document');
    await service.dismissFinished(actor);
    expect((await service.list(actor)).items.map((item) => item.id)).toEqual([active.id]);
    await expect(service.dismiss(done.id, outsider)).rejects.toThrow();
  });
  it('revokes asset access immediately after soft deletion', async () => {
    const task = await service.submit(file, {}, actor);
    await service.process(task.id);
    const result = await service.get(task.id, actor);
    await ds.manager.update(DocumentEntity, { id: result.documentId! }, { deleted: true });
    await expect(service.readResource(result.documentId!, null, actor)).rejects.toThrow();
  });
});
