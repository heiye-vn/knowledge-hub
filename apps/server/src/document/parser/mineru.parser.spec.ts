import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MineruParser } from './mineru.parser.js';
import { requestBytes } from './mineru-http.js';
import type { MineruCheckpoint } from './parse-result.js';

vi.mock('./mineru-http.js', () => ({ requestBytes: vi.fn() }));
const uploadUrl = 'https://bucket.aliyuncs.com/input?signature=secret';
const downloadUrl = 'https://cdn-mineru.openxlab.org.cn/output.zip';
const file = {
  originalname: 'test.pdf',
  buffer: Buffer.from('%PDF-1.7\n%%EOF'),
};
const response = (data: unknown, status = 200, headers = {}) => ({
  status,
  headers,
  body: Buffer.from(JSON.stringify(data)),
});
const created = () =>
  response({ code: 0, data: { batch_id: 'batch-1', file_urls: [uploadUrl] } });
const done = (name = file.originalname) =>
  response({
    code: 0,
    data: {
      extract_result: [
        {
          file_name: 'unrelated.pdf',
          state: 'done',
          full_zip_url: 'https://evil.test/a',
        },
        { file_name: name, state: 'done', full_zip_url: downloadUrl },
      ],
    },
  });
const checkpoint = (uploaded: boolean): MineruCheckpoint => ({
  batchId: 'batch-1',
  uploadUrl,
  uploaded,
});
const config = (extra: Record<string, unknown> = {}) =>
  new ConfigService({
    MINERU_API_TOKEN: 'offline-token',
    MINERU_RETRY_BASE_MS: 1,
    MINERU_POLL_INTERVAL_MS: 1,
    ...extra,
  });

async function archive() {
  const zip = new JSZip();
  zip.file('full.md', '# Extracted text');
  return {
    status: 200,
    headers: {},
    body: await zip.generateAsync({ type: 'nodebuffer' }),
  };
}

describe('MinerU offline workflow', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it('requires a dedicated token and makes no network request without one', async () => {
    await expect(
      new MineruParser(new ConfigService()).parse(file),
    ).rejects.toThrow(/MINERU_API_TOKEN/);
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('persists checkpoint before upload and after upload, matches the requested result, never sends bearer to assets', async () => {
    const snapshots: MineruCheckpoint[] = [];
    const events: string[] = [];
    vi.mocked(requestBytes).mockImplementation(async (url, request) => {
      events.push(request.method);
      if (request.method === 'POST') {
        expect(JSON.parse(request.body!.toString())).toMatchObject({
          files: [
            { name: 'test.pdf', data_id: expect.any(String), is_ocr: true },
          ],
          model_version: 'vlm',
          language: 'ch',
          enable_formula: true,
          enable_table: true,
        });
        expect(request.headers?.Authorization).toBe('Bearer offline-token');
        return created();
      }
      if (request.method === 'PUT') {
        expect(snapshots).toEqual([checkpoint(false)]);
        expect(request.headers?.Authorization).toBeUndefined();
        return { status: 200, headers: {}, body: Buffer.alloc(0) };
      }
      if (String(url).includes('/extract-results/')) return done();
      expect(url).toBe(downloadUrl);
      expect(request.headers?.Authorization).toBeUndefined();
      return archive();
    });
    const stages: string[] = [];
    expect(
      await new MineruParser(config()).parse(file, {
        onCheckpoint: async (value) => {
          snapshots.push({ ...value });
          events.push('checkpoint');
        },
        onProgress: async (stage) => {
          stages.push(stage);
        },
      }),
    ).toEqual({
      markdown: '# Extracted text',
      images: [],
      warnings: [],
      parser: 'mineru',
    });
    expect(snapshots).toEqual([checkpoint(false), checkpoint(true)]);
    expect(events).toEqual([
      'POST',
      'checkpoint',
      'PUT',
      'checkpoint',
      'GET',
      'GET',
    ]);
    expect(stages).toEqual(['parsing', 'downloading']);
  });

  it('uses the documented base/model env names and only requests OCR for scanned-capable inputs', async () => {
    const body = Buffer.from('PK\u0003\u0004fake-docx');
    const docx = { originalname: 'report.docx', buffer: body };
    vi.mocked(requestBytes).mockImplementation(async (url, request) => {
      if (request.method === 'POST') {
        expect(String(url)).toBe('https://mineru.net/api/v4/file-urls/batch');
        const payload = JSON.parse(request.body!.toString());
        expect(payload.files[0]).toMatchObject({ name: 'report.docx', is_ocr: false });
        expect(payload).toMatchObject({ model_version: 'vlm', language: 'en' });
        return created();
      }
      if (request.method === 'PUT') return { status: 200, headers: {}, body: Buffer.alloc(0) };
      if (String(url).includes('/extract-results/')) return done('report.docx');
      return archive();
    });
    await expect(new MineruParser(config({
      MINERU_API_BASE: 'https://mineru.net',
      MINERU_MODEL_VERSION: 'vlm',
      MINERU_LANGUAGE: 'en',
    })).parse(docx)).resolves.toMatchObject({ parser: 'mineru' });
  });

  it.each([false, true])(
    'resumes an existing batch (uploaded=%s) without POST',
    async (uploaded) => {
      vi.mocked(requestBytes).mockImplementation(async (url, request) => {
        if (request.method === 'PUT')
          return { status: 200, headers: {}, body: Buffer.alloc(0) };
        if (String(url).includes('/extract-results/')) return done();
        return archive();
      });
      expect(
        (
          await new MineruParser(config()).parse(file, {
            checkpoint: checkpoint(uploaded),
          })
        ).markdown,
      ).toBe('# Extracted text');
      expect(
        vi
          .mocked(requestBytes)
          .mock.calls.some(([, request]) => request.method === 'POST'),
      ).toBe(false);
      expect(
        vi
          .mocked(requestBytes)
          .mock.calls.filter(([, request]) => request.method === 'PUT'),
      ).toHaveLength(uploaded ? 0 : 1);
    },
  );

  it('does not upload if durable checkpoint persistence fails', async () => {
    vi.mocked(requestBytes).mockResolvedValue(created());
    await expect(
      new MineruParser(config()).parse(file, {
        onCheckpoint: async () => {
          throw new Error('private database details');
        },
      }),
    ).rejects.toThrow(/checkpoint/i);
    expect(requestBytes).toHaveBeenCalledTimes(1);
  });

  it('never retries ambiguous POST failures and exposes a terminal safe error', async () => {
    vi.mocked(requestBytes).mockRejectedValue(
      new Error('offline-token https://secret.test/raw'),
    );
    const error = await new MineruParser(config())
      .parse(file)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      retryable: false,
      code: 'MINERU_SUBMISSION_UNCERTAIN',
    });
    expect(String(error)).not.toMatch(/offline-token|secret.test/);
    expect(requestBytes).toHaveBeenCalledTimes(1);
  });

  it('retries transient upload, query and download within a bounded budget', async () => {
    vi.mocked(requestBytes)
      .mockResolvedValueOnce(response({}, 503, { 'retry-after': '0' }))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: Buffer.alloc(0),
      })
      .mockResolvedValueOnce(response({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(done())
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(await archive());
    expect(
      (
        await new MineruParser(config()).parse(file, {
          checkpoint: checkpoint(false),
        })
      ).parser,
    ).toBe('mineru');
    expect(requestBytes).toHaveBeenCalledTimes(6);
  });

  it.each([401, 403, 400, 422])(
    'does not retry permanent HTTP %s errors or expose raw responses',
    async (status) => {
      vi.mocked(requestBytes).mockResolvedValue(
        response({ secret: 'offline-token raw body' }, status),
      );
      const error = await new MineruParser(config())
        .parse(file, { checkpoint: checkpoint(true) })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ retryable: false });
      expect(String(error)).not.toMatch(/offline-token|raw body/);
      expect(requestBytes).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects failed or mismatched batch results without using provider error text', async () => {
    for (const item of [
      { file_name: 'wrong.pdf', state: 'done', full_zip_url: downloadUrl },
      {
        file_name: file.originalname,
        state: 'failed',
        err_msg: 'secret-provider-details',
      },
    ]) {
      vi.mocked(requestBytes).mockResolvedValue(
        response({ code: 0, data: { extract_result: [item] } }),
      );
      const error = await new MineruParser(config())
        .parse(file, { checkpoint: checkpoint(true) })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('secret-provider-details');
    }
  });

  it('caps retries and polling even when a remote service never completes', async () => {
    vi.mocked(requestBytes).mockResolvedValue(response({}, 503));
    await expect(
      new MineruParser(config({ MINERU_MAX_RETRIES: 2 })).parse(file, {
        checkpoint: checkpoint(true),
      }),
    ).rejects.toThrow();
    expect(requestBytes).toHaveBeenCalledTimes(3);
    vi.mocked(requestBytes)
      .mockClear()
      .mockResolvedValue(
        response({
          code: 0,
          data: {
            extract_result: [
              { file_name: file.originalname, state: 'running' },
            ],
          },
        }),
      );
    await expect(
      new MineruParser(config({ MINERU_MAX_POLLS: 2 })).parse(file, {
        checkpoint: checkpoint(true),
      }),
    ).rejects.toThrow(/limit|deadline/i);
    expect(requestBytes).toHaveBeenCalledTimes(2);
  });

  it('matches data_id when the provider omits the original file name', async () => {
    let dataId = '';
    vi.mocked(requestBytes).mockImplementation(async (url, request) => {
      if (request.method === 'POST') {
        dataId = (JSON.parse(request.body!.toString()) as { files: { data_id: string }[] }).files[0].data_id;
        return created();
      }
      if (request.method === 'PUT') return { status: 200, headers: {}, body: Buffer.alloc(0) };
      if (url.includes('/extract-results/')) return response({ code: 0, data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: downloadUrl }] } });
      return archive();
    });
    expect((await new MineruParser(config()).parse(file)).markdown).toBe('# Extracted text');
  });

  it.each(['seconds', 'date'])('honors Retry-After %s without retrying early', async (format) => {
    const downloaded = await archive();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.mocked(requestBytes)
      .mockResolvedValueOnce(response({}, 429, { 'retry-after': format === 'seconds' ? '2' : new Date(Date.now() + 2000).toUTCString() }))
      .mockResolvedValueOnce(done())
      .mockResolvedValueOnce(downloaded);
    const result = new MineruParser(config()).parse(file, { checkpoint: checkpoint(true) });
    await vi.advanceTimersByTimeAsync(1999);
    expect(requestBytes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).parser).toBe('mineru');
    expect(requestBytes).toHaveBeenCalledTimes(3);
  });

  it('does not wait past the deadline for a Retry-After header', async () => {
    vi.mocked(requestBytes).mockResolvedValue(response({}, 429, { 'retry-after': '3600' }));
    await expect(new MineruParser(config({ MINERU_TIMEOUT_MS: 100 })).parse(file, { checkpoint: checkpoint(true) })).rejects.toThrow(/deadline/i);
    expect(requestBytes).toHaveBeenCalledTimes(1);
  });

  it('includes stalled requests in the global deadline', async () => {
    vi.mocked(requestBytes).mockImplementation(() => new Promise(() => {}));
    await expect(
      new MineruParser(config({ MINERU_TIMEOUT_MS: 20 })).parse(file, {
        checkpoint: checkpoint(true),
      }),
    ).rejects.toThrow(/deadline/i);
  });

  it('never makes an ambiguous POST globally retryable when its deadline expires', async () => {
    vi.mocked(requestBytes).mockImplementation(() => new Promise(() => {}));
    const error = await new MineruParser(config({ MINERU_TIMEOUT_MS: 20 }))
      .parse(file)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      retryable: false,
      code: 'MINERU_SUBMISSION_UNCERTAIN',
    });
  });

  it('never times out checkpoint persistence as a safely replayable submission', async () => {
    vi.mocked(requestBytes).mockResolvedValue(created());
    const error = await new MineruParser(config({ MINERU_TIMEOUT_MS: 20 }))
      .parse(file, { onCheckpoint: () => new Promise(() => {}) })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ retryable: false });
    expect(requestBytes).toHaveBeenCalledTimes(1);
  });
});
