import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { FileParserService } from './parser/file-parser.service.js';
import { MineruError } from './parser/mineru-error.js';
import { rewriteImageUrls } from './parser/image-references.js';
import { StorageService } from '../storage/storage.service.js';
import {
  createResourceKey,
  decryptResource,
  encryptResource,
} from '../storage/resource-crypto.js';
import { DocumentImportEntity } from './entities/document-import.entity.js';
import { DocumentResourceEntity } from './entities/document-resource.entity.js';
import {
  SOURCE_RESOURCE_PATH as SOURCE_PATH,
  readDocumentResource,
} from './document-resource.reader.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentContentEntity } from './entities/document-content.entity.js';
import { DocumentVersionService } from './document-version.service.js';
import { CategoryService } from './category.service.js';
import { DocumentStatus } from './document-status.js';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import type { UploadParseDto } from './dto/upload-parse.dto.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { RoleCode } from '../common/constants/roles.js';
import { accessFromUser, canReadDocument } from './document-access.js';
import {
  decodeUploadFilename,
  getExtension,
  stripNullBytes,
  titleFromFilename,
} from './parser/utils/markdown.util.js';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface ImportTaskView {
  id: string;
  fileName: string;
  state: DocumentImportEntity['state'];
  stage: string;
  documentId: string | null;
  warnings: string[];
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class DocumentImportService {
  private readonly logger = new Logger(DocumentImportService.name);

  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    private readonly parser: FileParserService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly versions: DocumentVersionService,
    private readonly categories: CategoryService,
  ) {}

  async submit(
    file: Express.Multer.File,
    meta: UploadParseDto,
    actor: AuthUser,
  ): Promise<ImportTaskView> {
    if (!file?.buffer?.length) throw new BadRequestException('文件不能为空');
    if (file.buffer.length > MAX_IMPORT_BYTES)
      throw new BadRequestException('文件不能超过 50MB');
    const fileName = decodeUploadFilename(file.originalname).replace(
      /^.*[\\/]/,
      '',
    );
    const hasControlCharacter = [...fileName].some(
      (character) => character.charCodeAt(0) < 32,
    );
    if (!fileName || fileName.length > 255 || hasControlCharacter)
      throw new BadRequestException('文件名无效');
    const extension = getExtension(fileName);
    if (!this.parser.isSupported(extension))
      throw new BadRequestException(
        `不支持的格式，支持 ${this.parser.supportedList()}`,
      );
    if (
      !this.storage.isEnabled() ||
      this.config.get('REDIS_ENABLED', 'true') === 'false'
    ) {
      throw new ServiceUnavailableException(
        '文档导入需要启用对象存储和 Redis 队列',
      );
    }
    if (
      !actor.roles.includes(RoleCode.ADMIN) &&
      (meta.authorId !== undefined || meta.createBy !== undefined)
    ) {
      throw new ForbiddenException('仅管理员可指定审计字段');
    }
    if (
      meta.teamId &&
      !actor.roles.includes(RoleCode.ADMIN) &&
      !actor.teamIds.includes(meta.teamId)
    ) {
      throw new ForbiddenException('只能导入到自己所在的团队');
    }
    for (const id of [
      meta.teamId,
      meta.categoryId,
      meta.authorId,
      meta.createBy,
    ]) {
      if (id !== undefined && !/^\d{1,19}$/.test(id))
        throw new BadRequestException('标识必须为数字字符串');
    }
    // 导入链路绕过 DocumentService.create，分类合法性要在这里单独校验
    const categoryId = await this.categories.normalize(meta.categoryId);
    const requestId = meta.requestId ?? randomUUID();
    const metadata = {
      categoryId: categoryId ?? undefined,
      teamId: meta.teamId,
      authorId: meta.authorId,
      createBy: meta.createBy,
      tags: meta.tags,
      remark: meta.remark,
      isPublic: meta.isPublic ?? false,
    };
    const fingerprint = createHash('sha256')
      .update(file.buffer)
      .update(JSON.stringify({ fileName, metadata }))
      .digest('hex');
    const task = await this.em.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `import-submit:${actor.userId}:${requestId}`,
      ]);
      let row = await tx.findOneBy(DocumentImportEntity, {
        ownerId: actor.userId,
        requestId,
      });
      if (row) {
        if (row.fingerprint !== fingerprint)
          throw new ConflictException('该请求标识已用于其他文件或元数据');
        return row;
      }
      row = tx.create(DocumentImportEntity, {
        id: nextSnowflakeId(),
        documentId: nextSnowflakeId(),
        ownerId: actor.userId,
        requestId,
        fingerprint,
        fileName,
        fileSize: String(file.buffer.length),
        extension,
        metadata,
        state: 'queued',
        stage: 'uploading',
        warnings: [],
        checkpoint: null,
        error: null,
        parser: null,
        attempt: 0,
      });
      await tx.save(row);
      await tx.save(
        tx.create(DocumentResourceEntity, {
          id: nextSnowflakeId(),
          taskId: row.id,
          documentId: null,
          path: SOURCE_PATH,
          driver: this.storage.getActiveDriverName(),
          objectKey: `document-imports/${row.id}/source.bin`,
          encryptionKey: createResourceKey(),
          contentType: sourceContentType(extension),
          byteLength: file.buffer.length,
          ready: false,
        }),
      );
      return row;
    });
    const runner = this.em.connection.createQueryRunner();
    await runner.connect();
    const lockKey = `import-source:${task.id}`;
    try {
      await runner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        lockKey,
      ]);
      const current = await this.em.findOneByOrFail(DocumentImportEntity, {
        id: task.id,
      });
      const source = await this.em.findOneByOrFail(DocumentResourceEntity, {
        taskId: task.id,
        path: SOURCE_PATH,
      });
      if (!source.ready) {
        try {
          await this.storage.uploadBytes(
            encryptResource(file.buffer, source.encryptionKey),
            {
              fileName: 'source.bin',
              contentType: 'application/octet-stream',
              objectKey: source.objectKey,
            },
          );
          await this.em.transaction(async (tx) => {
            await tx.update(DocumentResourceEntity, source.id, { ready: true });
            await tx.update(DocumentImportEntity, task.id, {
              state: 'queued',
              stage: 'queued',
              error: null,
              updatedAt: new Date(),
            });
          });
        } catch {
          await this.em.update(DocumentImportEntity, task.id, {
            state: 'failed',
            error: '原文件保存失败，请重新提交同一文件',
            updatedAt: new Date(),
          });
          throw new ServiceUnavailableException('原文件保存失败，请重试上传');
        }
      } else if (current.stage === 'uploading') {
        await this.em.update(DocumentImportEntity, task.id, {
          stage: 'queued',
          updatedAt: new Date(),
        });
      }
    } finally {
      await runner
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
        .catch(() => undefined);
      await runner.release();
    }
    return this.get(task.id, actor);
  }

  async list(actor: AuthUser): Promise<{ items: ImportTaskView[] }> {
    const rows = await this.em.find(DocumentImportEntity, {
      where: { ownerId: actor.userId, dismissed: false },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    return { items: rows.map((row) => this.view(row)) };
  }

  /**
   * 从列表隐藏一条已结束任务的记录。只做软隐藏：任务、草稿文档与加密资源
   * 保持原样，已完成文档的正文图片链接不会因此失效。进行中的任务不允许隐藏。
   */
  async dismiss(id: string, actor: AuthUser): Promise<{ dismissed: number }> {
    const result = await this.em
      .createQueryBuilder()
      .update(DocumentImportEntity)
      .set({ dismissed: true, updatedAt: new Date() })
      .where('id = :id AND owner_id = :ownerId', {
        id,
        ownerId: actor.userId,
      })
      .andWhere("state IN ('completed', 'failed')")
      .execute();
    if (!result.affected) {
      const task = await this.em.findOneBy(DocumentImportEntity, {
        id,
        ownerId: actor.userId,
      });
      if (!task) throw new NotFoundException('导入任务不存在');
      throw new ConflictException('任务处理中，完成后才能删除记录');
    }
    return { dismissed: 1 };
  }

  /** 隐藏当前用户全部已完成/失败记录，返回隐藏条数。 */
  async dismissFinished(actor: AuthUser): Promise<{ dismissed: number }> {
    const result = await this.em
      .createQueryBuilder()
      .update(DocumentImportEntity)
      .set({ dismissed: true, updatedAt: new Date() })
      .where('owner_id = :ownerId AND dismissed = false', {
        ownerId: actor.userId,
      })
      .andWhere("state IN ('completed', 'failed')")
      .execute();
    return { dismissed: result.affected ?? 0 };
  }

  async get(id: string, actor: AuthUser): Promise<ImportTaskView> {
    return this.view(await this.ownedTask(id, actor));
  }

  async retry(id: string, actor: AuthUser): Promise<ImportTaskView> {
    await this.em.transaction(async (tx) => {
      const task = await tx.findOne(DocumentImportEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!task || task.ownerId !== actor.userId)
        throw new NotFoundException('导入任务不存在');
      if (task.state !== 'failed')
        throw new ConflictException('仅失败任务可以重试');
      const source = await tx.findOneBy(DocumentResourceEntity, {
        taskId: id,
        path: SOURCE_PATH,
        ready: true,
      });
      if (!source) throw new BadRequestException('原文件未保存，请重新上传');
      await tx.update(DocumentImportEntity, id, {
        state: 'queued',
        stage: 'queued',
        error: null,
        attempt: task.attempt + 1,
        updatedAt: new Date(),
      });
    });
    return this.get(id, actor);
  }

  async pending(): Promise<Array<{ id: string; attempt: number }>> {
    return (
      this.em
        .createQueryBuilder(DocumentImportEntity, 'task')
        .select(['task.id', 'task.attempt'])
        .where("task.state IN ('queued', 'processing')")
        // A crash between source upload and the stage update must not strand the task.
        .andWhere(
          "(task.stage <> 'uploading' OR EXISTS (SELECT 1 FROM kh_document_resource r WHERE r.task_id = task.id AND r.path = :source AND r.ready = true))",
          { source: SOURCE_PATH },
        )
        .orderBy('task.createdAt', 'ASC')
        .take(100)
        .getMany()
    );
  }

  async process(id: string): Promise<void> {
    const runner = this.em.connection.createQueryRunner();
    await runner.connect();
    const lockKey = `import-process:${id}`;
    let locked = false;
    try {
      const result = await runner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockKey],
      );
      locked = result[0]?.locked === true;
      if (!locked) return;
      const task = await this.em.findOneBy(DocumentImportEntity, { id });
      if (!task || task.state === 'completed' || task.state === 'failed')
        return;
      await this.updateStage(id, 'parsing');
      try {
        const source = await this.em.findOneByOrFail(DocumentResourceEntity, {
          taskId: id,
          path: SOURCE_PATH,
          ready: true,
        });
        const buffer = decryptResource(
          await this.storage.readBytes(
            source.objectKey,
            MAX_IMPORT_BYTES + 128,
            source.driver,
          ),
          source.encryptionKey,
        );
        const parsed = await this.parser.parse(
          { originalname: task.fileName, buffer, size: buffer.length },
          {
            checkpoint: task.checkpoint ?? undefined,
            onCheckpoint: async (checkpoint) => {
              await this.em.update(DocumentImportEntity, id, {
                checkpoint,
                updatedAt: new Date(),
              });
            },
            onProgress: async (stage) => {
              await this.updateStage(id, stage);
            },
          },
        );
        if (!parsed.markdown.trim())
          throw new BadRequestException('未识别出可用正文');
        await this.updateStage(id, 'storing');
        const urls = new Map<string, string>();
        for (const image of parsed.images) {
          let resource = await this.em.findOneBy(DocumentResourceEntity, {
            taskId: id,
            path: image.path,
          });
          if (!resource) {
            const resourceId = nextSnowflakeId();
            resource = await this.em.save(
              this.em.create(DocumentResourceEntity, {
                id: resourceId,
                taskId: id,
                documentId: null,
                path: image.path,
                driver: this.storage.getActiveDriverName(),
                objectKey: `document-imports/${id}/${resourceId}.bin`,
                encryptionKey: createResourceKey(),
                contentType: image.contentType,
                byteLength: image.bytes.length,
                ready: false,
              }),
            );
          }
          if (!resource.ready) {
            await this.storage.uploadBytes(
              encryptResource(image.bytes, resource.encryptionKey),
              {
                fileName: 'image.bin',
                contentType: 'application/octet-stream',
                objectKey: resource.objectKey,
              },
            );
            await this.em.update(DocumentResourceEntity, resource.id, {
              ready: true,
            });
          }
          urls.set(
            image.path,
            `/documents/${task.documentId}/assets/${resource.id}`,
          );
        }
        // NUL 会 PG 整条落库事务失败；在唯一的写入源头上过滤一次，
        // 下游正文、摘要、字数、v1 快照全部干净
        const markdown = stripNullBytes(
          rewriteImageUrls(parsed.markdown, urls),
        );
        await this.updateStage(id, 'saving');
        await this.em.transaction(async (tx) => {
          const current = await tx.findOne(DocumentImportEntity, {
            where: { id },
            lock: { mode: 'pessimistic_write' },
          });
          if (!current || current.state === 'completed') return;
          const metadata = task.metadata;
          const title = titleFromFilename(task.fileName);
          await tx.save(
            tx.create(DocumentEntity, {
              id: task.documentId,
              title,
              categoryId: metadata.categoryId,
              teamId: metadata.teamId,
              authorId: metadata.authorId ?? task.ownerId,
              createBy: metadata.createBy ?? task.ownerId,
              updateBy: metadata.createBy ?? task.ownerId,
              tags: metadata.tags,
              remark: metadata.remark,
              status: DocumentStatus.Draft,
              isPublic: metadata.isPublic ?? false,
              deleted: false,
              wordCount:
                (markdown.match(/[\u4e00-\u9fff]/g) ?? []).length +
                markdown
                  .replace(/[\u4e00-\u9fff]/g, ' ')
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean).length,
              fileName: task.fileName,
              fileSize: task.fileSize,
              fileExtension: task.extension,
              objectKey: source.objectKey,
              fileUrl: `/documents/${task.documentId}/source`,
            }),
          );
          await tx.save(
            tx.create(DocumentContentEntity, {
              documentId: task.documentId,
              content: markdown,
              contentLength: markdown.length,
              contentSummary: markdown.replace(/\s+/g, ' ').slice(0, 200),
              version: 1,
              deleted: false,
            }),
          );
          // 导入完成即 v1 快照，与文档、正文同事务落库
          await this.versions.recordInitial(
            {
              documentId: task.documentId,
              version: 1,
              title,
              content: markdown,
              summary: null,
              userId: metadata.createBy ?? task.ownerId,
            },
            tx,
          );
          await tx.update(
            DocumentResourceEntity,
            { taskId: id },
            { documentId: task.documentId },
          );
          await tx.update(DocumentImportEntity, id, {
            state: 'completed',
            stage: 'completed',
            parser: parsed.parser,
            warnings: parsed.warnings,
            checkpoint: null,
            error: null,
            updatedAt: new Date(),
          });
        });
      } catch (error) {
        const code =
          error instanceof MineruError
            ? error.code
            : error instanceof BadRequestException
              ? 'PARSE_REJECTED'
              : 'UNEXPECTED';
        this.logger.warn(
          `导入失败：task=${id}, code=${code}, detail=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.em.update(DocumentImportEntity, id, {
          state: 'failed',
          error: importErrorMessage(error),
          updatedAt: new Date(),
        });
      }
    } finally {
      if (locked)
        await runner
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            lockKey,
          ])
          .catch(() => undefined);
      await runner.release();
    }
  }

  async readResource(
    documentId: string,
    assetId: string | null,
    actor: AuthUser,
  ): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    const doc = await this.em.findOneBy(DocumentEntity, {
      id: documentId,
      deleted: false,
    });
    if (!doc || !canReadDocument(doc, accessFromUser(actor)))
      throw new NotFoundException('文档资源不存在');
    const resource = await readDocumentResource(
      this.em,
      this.storage,
      documentId,
      assetId,
      MAX_IMPORT_BYTES,
    );
    return {
      bytes: resource.bytes,
      contentType: resource.contentType,
      fileName: assetId
        ? resource.path.split('/').pop()!
        : (doc.fileName ?? 'document'),
    };
  }

  private async updateStage(id: string, stage: string): Promise<void> {
    await this.em.update(DocumentImportEntity, id, {
      state: 'processing',
      stage: stage.slice(0, 32),
      updatedAt: new Date(),
    });
  }

  private async ownedTask(
    id: string,
    actor: AuthUser,
  ): Promise<DocumentImportEntity> {
    const task = await this.em.findOneBy(DocumentImportEntity, {
      id,
      ownerId: actor.userId,
    });
    if (!task) throw new NotFoundException('导入任务不存在');
    return task;
  }

  private view(task: DocumentImportEntity): ImportTaskView {
    return {
      id: task.id,
      fileName: task.fileName,
      state: task.state,
      stage: task.stage,
      documentId: task.state === 'completed' ? task.documentId : null,
      warnings: task.warnings,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }
}

export function importErrorMessage(error: unknown): string {
  if (error instanceof MineruError) {
    switch (error.code) {
      case 'MINERU_NOT_CONFIGURED':
        return '未配置 MinerU 解析服务，请联系管理员配置 MINERU_API_TOKEN';
      case 'MINERU_PARSE_FAILED':
        return '文件解析失败：未识别出可用文字，请检查扫描件清晰度或文件内容';
      case 'MINERU_TIMEOUT':
      case 'MINERU_DEADLINE':
      case 'MINERU_POLL_LIMIT':
        return 'MinerU 解析超时，请稍后重试';
      case 'MINERU_SIZE_LIMIT':
        return '文件超出解析大小限制';
      case 'MINERU_SUBMISSION_UNCERTAIN':
        return '无法确认 MinerU 任务是否提交，请稍后重试并避免重复上传';
      default:
        return 'MinerU 解析失败，请稍后重试';
    }
  }
  if (error instanceof BadRequestException) {
    const message = error.message;
    if (
      /^(未配置|不支持|文件格式|文件内容为空|文件不能超过|文件超出)/.test(
        message,
      )
    ) {
      return message;
    }
    return '文件无法解析，请检查文件格式或扫描清晰度';
  }
  return '解析服务暂时不可用，请稍后重试';
}

function sourceContentType(extension: string): string {
  const types: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[extension] ?? 'application/octet-stream';
}
