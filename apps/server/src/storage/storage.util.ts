import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { Readable } from 'node:stream';

/**
 * 格式化当前日期路径：YYYY/MM/DD
 */
export function formatDatePath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

/**
 * 清理文件名并限制安全长度
 */
export function sanitizeBaseName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '') || 'file';
  return base.replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 64);
}

/**
 * 根据常见 MIME 类型推断扩展名
 */
export function guessExt(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

/**
 * 生成规范化的对象存储 Key
 */
export function generateObjectKey(
  fileName: string,
  contentType: string,
  prefix = 'documents',
): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const ext = extname(fileName) || guessExt(contentType);
  const safeBase = sanitizeBaseName(fileName);
  return `${cleanPrefix}/${formatDatePath()}/${safeBase}-${randomUUID()}${ext}`;
}

/** Only server-controlled relative keys, never paths or encoded URLs. */
export function validateObjectKey(key: string): string {
  if (
    typeof key !== 'string' ||
    !/^[\p{L}\p{N}._/-]+$/u.test(key) ||
    key.includes('..') ||
    key.split('/').some((segment) => segment === '' || segment === '.')
  ) {
    throw new Error('Invalid object key: expected a safe relative key');
  }
  return key;
}

/** Bound both the entire GET lifetime and the bytes retained from its stream. */
export async function readObjectBytes(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  validateObjectKey(key);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  const controller = new AbortController();
  let body: Readable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Object storage read timed out'));
      controller.abort();
      body?.destroy();
    }, 30_000);
  });

  const read = async (): Promise<Buffer> => {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: controller.signal },
    );
    body = response.Body instanceof Readable ? response.Body : undefined;
    // A transport may finish after the deadline despite cancellation.
    if (controller.signal.aborted) {
      body?.destroy();
      throw new Error('Object storage read timed out');
    }
    if (!body) throw new Error('Object storage response has no readable body');
    if (
      response.ContentLength !== undefined &&
      (!Number.isSafeInteger(response.ContentLength) ||
        response.ContentLength < 0 ||
        response.ContentLength > maxBytes)
    ) {
      throw new RangeError(
        'Object ContentLength exceeds maxBytes or is invalid',
      );
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        throw new Error('Object storage body returned a non-byte chunk');
      }
      const size =
        typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (size > maxBytes - total) {
        throw new RangeError('Object body exceeds maxBytes');
      }
      total += size;
      if (size > 0) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  };

  try {
    return await Promise.race([read(), timeout]);
  } catch (error) {
    controller.abort();
    body?.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
