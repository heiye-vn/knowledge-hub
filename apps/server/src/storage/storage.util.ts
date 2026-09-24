import { randomUUID } from 'crypto';
import { extname } from 'path';

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
