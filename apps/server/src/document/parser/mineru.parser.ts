import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ARCHIVE_LIMITS, extractMineruArchive } from './mineru-archive.js';
import { MineruError } from './mineru-error.js';
import { requestBytes } from './mineru-http.js';
import type { MineruRequest, MineruResponse } from './mineru-http.js';
import type { ParseInput } from './file-parser.service.js';
import { getExtension } from './utils/markdown.util.js';
import type {
  MineruCheckpoint,
  ParsedDocument,
  ParseOptions,
} from './parse-result.js';

interface BatchResult {
  file_name?: string;
  data_id?: string;
  state?: string;
  full_zip_url?: string;
}
interface Envelope {
  code: number;
  data?: {
    batch_id?: string;
    file_urls?: string[];
    extract_result?: BatchResult[];
  };
}
const deadlineError = () =>
  new MineruError('MinerU global deadline exceeded', 'MINERU_DEADLINE', true);

@Injectable()
export class MineruParser {
  private readonly logger = new Logger(MineruParser.name);

  constructor(private readonly config: ConfigService) {}

  async parse(
    file: ParseInput,
    options: ParseOptions = {},
  ): Promise<ParsedDocument> {
    const token = this.config.get<string>('MINERU_API_TOKEN')?.trim();
    if (!token)
      throw new MineruError(
        'MINERU_API_TOKEN is required',
        'MINERU_NOT_CONFIGURED',
      );
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length)
      throw new MineruError('Empty MinerU input');
    if (file.buffer.length > ARCHIVE_LIMITS.maxCompressedBytes)
      throw new MineruError(
        'MinerU input size limit exceeded',
        'MINERU_SIZE_LIMIT',
      );
    const deadline =
      Date.now() + this.number('MINERU_TIMEOUT_MS', 10 * 60_000, 30 * 60_000);
    const controller = new AbortController();
    const state = { resumable: !!options.checkpoint };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(deadlineError());
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      return await Promise.race([
        expired,
        this.run(file, options, token, deadline, controller.signal, state),
      ]);
    } catch (error) {
      const safe =
        error instanceof MineruError
          ? error
          : new MineruError('MinerU parsing failed');
      if (safe.retryable && !state.resumable)
        throw new MineruError(
          'MinerU submission outcome is uncertain; automatic resubmission is disabled',
          'MINERU_SUBMISSION_UNCERTAIN',
        );
      throw safe;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private number(
    key: string,
    fallback: number,
    maximum: number,
    minimum = 1,
  ): number {
    const value = Number(this.config.get(key, fallback));
    return Number.isFinite(value) && value >= minimum
      ? Math.min(Math.floor(value), maximum)
      : fallback;
  }

  private async run(
    file: ParseInput,
    options: ParseOptions,
    token: string,
    deadline: number,
    signal: AbortSignal,
    state: { resumable: boolean },
  ): Promise<ParsedDocument> {
    const base = (
      this.config.get<string>('MINERU_API_BASE') ??
      this.config.get<string>('MINERU_BASE_URL') ??
      'https://mineru.net'
    ).replace(/\/+$/, '');
    const extension = getExtension(file.originalname);
    let api: URL;
    try {
      api = new URL(base);
    } catch {
      throw new MineruError(
        'Invalid MinerU API configuration',
        'MINERU_NOT_CONFIGURED',
      );
    }
    if (
      api.protocol !== 'https:' ||
      api.username ||
      api.password ||
      api.hash ||
      api.search ||
      api.pathname !== '/' ||
      (api.port && api.port !== '443')
    )
      throw new MineruError(
        'Invalid MinerU API configuration',
        'MINERU_NOT_CONFIGURED',
      );
    const configuredHosts = this.config.get<string | string[]>(
      'MINERU_ASSET_HOST_SUFFIXES',
    );
    const assetHosts = Array.isArray(configuredHosts)
      ? configuredHosts
      : configuredHosts
        ? configuredHosts
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean)
        : ['aliyuncs.com', 'mineru.net', 'cdn-mineru.openxlab.org.cn'];
    const timeoutMs = this.number('MINERU_REQUEST_TIMEOUT_MS', 60_000, 120_000);
    const common = { deadline, timeoutMs, signal };
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const dataId = createHash('sha256')
      .update(file.originalname)
      .update('\0')
      .update(file.buffer)
      .digest('hex');
    const check = () => {
      if (signal.aborted || Date.now() >= deadline) throw deadlineError();
    };
    const persist = async (checkpoint: MineruCheckpoint) => {
      check();
      try {
        await options.onCheckpoint?.({ ...checkpoint });
      } catch {
        throw new MineruError(
          'MinerU checkpoint persistence failed; do not resubmit automatically',
          'MINERU_CHECKPOINT_FAILED',
        );
      }
      check();
      if (options.onCheckpoint) state.resumable = true;
    };
    const progress = async (stage: string) => {
      check();
      try {
        await options.onProgress?.(stage);
      } catch {
        throw new MineruError(
          'MinerU progress persistence failed',
          'MINERU_PROGRESS_FAILED',
          true,
        );
      }
      check();
    };
    let checkpoint: MineruCheckpoint;
    if (options.checkpoint) {
      checkpoint = { ...options.checkpoint };
      if (
        !/^[a-zA-Z0-9_-]{1,200}$/.test(checkpoint.batchId) ||
        typeof checkpoint.uploadUrl !== 'string' ||
        typeof checkpoint.uploaded !== 'boolean'
      )
        throw new MineruError('Invalid MinerU checkpoint');
    } else {
      let response: MineruResponse;
      try {
        response = await requestBytes(`${base}/api/v4/file-urls/batch`, {
          ...common,
          method: 'POST',
          headers,
          trustedHosts: [api.hostname],
          maxBytes: 1024 * 1024,
          body: Buffer.from(
            JSON.stringify({
              files: [
                {
                  name: file.originalname,
                  data_id: dataId,
                  // 扫描件与图片依赖 OCR；Office 文档交给 MinerU 的结构化解析。
                  is_ocr: ['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(
                    extension,
                  ),
                },
              ],
              model_version:
                this.config.get<string>('MINERU_MODEL_VERSION') ??
                this.config.get<string>('MINERU_MODEL') ??
                'vlm',
              language: this.config.get<string>('MINERU_LANGUAGE', 'ch'),
              enable_formula: true,
              enable_table: true,
            }),
          ),
        });
        if (response.status >= 500 || response.status === 408)
          throw new Error('uncertain');
      } catch (error) {
        if (error instanceof MineruError && error.code === 'MINERU_UNSAFE_URL') {
          this.logger.warn(
            `MinerU API 地址未通过安全校验: ${this.safeUrlDiagnostic(
              `${base}/api/v4/file-urls/batch`,
            )}; ${error.message}`,
          );
        }
        if (error instanceof MineruError && !error.retryable) throw error;
        // POST has no documented idempotency key. Replaying it can create a second cloud job.
        throw new MineruError(
          'MinerU submission outcome is uncertain; automatic resubmission is disabled',
          'MINERU_SUBMISSION_UNCERTAIN',
        );
      }
      let data: Envelope['data'];
      try {
        data = this.envelope(response).data;
      } catch (error) {
        if (response.status >= 200 && response.status < 300)
          throw new MineruError(
            'MinerU submission could not be checkpointed; automatic resubmission is disabled',
            'MINERU_SUBMISSION_UNCERTAIN',
          );
        throw error;
      }
      if (
        !data?.batch_id ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(data.batch_id) ||
        data.file_urls?.length !== 1 ||
        typeof data.file_urls[0] !== 'string'
      )
        throw new MineruError(
          'MinerU submission could not be checkpointed; automatic resubmission is disabled',
          'MINERU_SUBMISSION_UNCERTAIN',
        );
      checkpoint = {
        batchId: data.batch_id,
        uploadUrl: data.file_urls[0],
        uploaded: false,
      };
      await persist(checkpoint);
    }
    if (!checkpoint.uploaded) {
      check();
      try {
        await this.retry(checkpoint.uploadUrl, {
          ...common,
          method: 'PUT',
          // Signed upload URLs bind the object bytes; an explicit Content-Type can be rejected.
          headers: { 'Content-Length': String(file.buffer.length) },
          body: file.buffer,
          trustedHosts: assetHosts,
          maxBytes: 1024 * 1024,
        });
      } catch (error) {
        if (error instanceof MineruError && error.code === 'MINERU_UNSAFE_URL') {
          this.logger.warn(
            `MinerU 上传地址未通过安全校验: ${this.safeUrlDiagnostic(checkpoint.uploadUrl)}`,
          );
        }
        throw error;
      }
      checkpoint = { ...checkpoint, uploaded: true };
      await persist(checkpoint);
    }
    await progress('parsing');
    const maxPolls = this.number('MINERU_MAX_POLLS', 300, 600);
    for (let poll = 0; poll < maxPolls; poll++) {
      check();
      const response = await this.retry(
        `${base}/api/v4/extract-results/batch/${encodeURIComponent(checkpoint.batchId)}`,
        {
          ...common,
          method: 'GET',
          headers,
          trustedHosts: [api.hostname],
          maxBytes: 1024 * 1024,
        },
      );
      const results = this.envelope(response).data?.extract_result;
      if (!Array.isArray(results))
        throw new MineruError('Invalid MinerU batch result');
      const matches = results.filter(
        (result) =>
          result &&
          (result.data_id === dataId || result.file_name === file.originalname),
      );
      if (matches.length !== 1)
        throw new MineruError(
          'MinerU result does not uniquely match the requested file',
        );
      const result = matches[0];
      if (result.state === 'failed')
        throw new MineruError(
          'MinerU could not parse this file',
          'MINERU_PARSE_FAILED',
        );
      if (result.state === 'done') {
        if (typeof result.full_zip_url !== 'string' || !result.full_zip_url)
          throw new MineruError('MinerU result archive is missing');
        await progress('downloading');
        const downloaded = await this.retry(result.full_zip_url, {
          ...common,
          method: 'GET',
          trustedHosts: assetHosts,
          maxBytes: ARCHIVE_LIMITS.maxCompressedBytes,
        });
        check();
        const parsed = extractMineruArchive(downloaded.body);
        check();
        return parsed;
      }
      if (
        !['waiting-file', 'pending', 'running', 'converting'].includes(
          result.state ?? '',
        )
      )
        throw new MineruError('Invalid MinerU result state');
      if (poll + 1 < maxPolls)
        await this.pause(
          this.number('MINERU_POLL_INTERVAL_MS', 2000, 30_000),
          deadline,
          signal,
        );
    }
    throw new MineruError(
      'MinerU polling limit exceeded',
      'MINERU_POLL_LIMIT',
      true,
    );
  }

  private safeUrlDiagnostic(raw: string): string {
    try {
      const url = new URL(raw);
      return `protocol=${url.protocol}, host=${url.hostname}, port=${url.port || '-'}, hash=${Boolean(url.hash)}, user=${Boolean(url.username)}, slash=${raw.includes('\\')}, space=${/\s/.test(raw)}, trimmed=${raw === raw.trim()}, length=${raw.length}`;
    } catch {
      return 'unparseable';
    }
  }

  private envelope(response: MineruResponse): Envelope {
    this.checkStatus(response);
    let value: Envelope;
    try {
      value = JSON.parse(response.body.toString('utf8')) as Envelope;
    } catch {
      throw new MineruError('Invalid MinerU JSON response');
    }
    if (!value || typeof value !== 'object' || value.code !== 0)
      throw new MineruError(
        'MinerU rejected the parsing request',
        'MINERU_API_REJECTED',
      );
    return value;
  }

  private checkStatus(response: MineruResponse): void {
    if (response.status >= 200 && response.status < 300) return;
    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(
      response.status,
    );
    throw new MineruError(
      `MinerU request failed (HTTP ${response.status})`,
      'MINERU_HTTP_ERROR',
      retryable,
    );
  }

  private async retry(
    url: string,
    options: MineruRequest,
  ): Promise<MineruResponse> {
    const maximum = this.number('MINERU_MAX_RETRIES', 3, 5, 0);
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted || Date.now() >= options.deadline)
        throw deadlineError();
      let response: MineruResponse | undefined;
      try {
        response = await requestBytes(url, options);
        this.checkStatus(response);
        return response;
      } catch (error) {
        const safe =
          error instanceof MineruError
            ? error
            : new MineruError(
                'MinerU network request failed',
                'MINERU_NETWORK',
                true,
              );
        if (!safe.retryable || attempt >= maximum) throw safe;
        const retryAfter = response?.headers['retry-after'];
        const header = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
        const requestedDelay = header
          ? /^\d+(?:\.\d+)?$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : 0;
        const backoff = Math.min(
          30_000,
          this.number('MINERU_RETRY_BASE_MS', 500, 10_000) * 2 ** attempt,
        );
        const delay = Math.max(
          Number.isFinite(requestedDelay) ? requestedDelay : 0,
          backoff + Math.random() * backoff * 0.25,
        );
        await this.pause(delay, options.deadline, options.signal);
      }
    }
  }

  private async pause(
    delay: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted || Date.now() + delay >= deadline)
      throw deadlineError();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(deadlineError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, delay);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
