import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import {
  collectImageReferences,
  hasMeaningfulText,
  rewriteImageUrls,
} from './image-references.js';
import { MineruError } from './mineru-error.js';
import { rasterContentType } from './raster-signature.js';
import type { ParsedDocument, ParsedImage } from './parse-result.js';

export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxMarkdownBytes: number;
  maxImageBytes: number;
}
export const ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
  maxCompressedBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxEntries: 2000,
  maxMarkdownBytes: 10 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
};
export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  dataOffset: number;
  method: number;
  crc: number;
}
function invalid(message = 'Invalid ZIP format'): never {
  throw new MineruError(message);
}
function limitsFor(overrides: Partial<ArchiveLimits>): ArchiveLimits {
  const result = { ...ARCHIVE_LIMITS };
  for (const key of Object.keys(result) as (keyof ArchiveLimits)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0)
        invalid('Invalid ZIP limit');
      result[key] = Math.min(value, result[key]);
    }
  }
  return result;
}
export function safeArchivePath(name: string): boolean {
  return (
    !!name &&
    // Control characters are deliberately forbidden in archive paths.
    // eslint-disable-next-line no-control-regex
    !/[\\\x00-\x1f\x7f:]/.test(name) &&
    !name.startsWith('/') &&
    name
      .replace(/\/$/, '')
      .split('/')
      .every((part) => !!part && part !== '.' && part !== '..')
  );
}

/** Inspect the central directory and local headers before any inflation. ZIP64 is intentionally unsupported. */
export function inspectZip(
  buffer: Buffer,
  overrides: Partial<ArchiveLimits> = {},
): ZipEntry[] {
  const limits = limitsFor(overrides);
  if (buffer.length > limits.maxCompressedBytes)
    invalid('ZIP compressed size limit exceeded');
  if (buffer.length < 22) invalid();
  let eocd = -1;
  for (
    let cursor = buffer.length - 22;
    cursor >= Math.max(0, buffer.length - 65557);
    cursor--
  ) {
    if (
      buffer.readUInt32LE(cursor) === 0x06054b50 &&
      cursor + 22 + buffer.readUInt16LE(cursor + 20) === buffer.length
    ) {
      eocd = cursor;
      break;
    }
  }
  if (
    eocd < 0 ||
    buffer.readUInt16LE(eocd + 4) !== 0 ||
    buffer.readUInt16LE(eocd + 6) !== 0
  )
    invalid();
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralStart = buffer.readUInt32LE(eocd + 16);
  if (
    count === 0xffff ||
    count !== buffer.readUInt16LE(eocd + 8) ||
    centralStart + centralSize !== eocd
  )
    invalid();
  if (count > limits.maxEntries) invalid('ZIP entry count limit exceeded');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = centralStart;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50)
      invalid();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      entryEnd > eocd ||
      (flags & 0x2041) !== 0 ||
      ![0, 8].includes(method) ||
      buffer.readUInt16LE(cursor + 34) !== 0 ||
      [size, compressedSize, local].includes(0xffffffff)
    )
      invalid();
    if (((buffer.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000)
      invalid('ZIP symlinks are not allowed');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(cursor + 46, cursor + 46 + nameLength),
      );
    } catch {
      return invalid();
    }
    if (!safeArchivePath(name)) invalid('Unsafe ZIP entry path');
    if (names.has(name)) invalid('Duplicate ZIP entry');
    names.add(name);
    total += size;
    if (total > limits.maxUncompressedBytes)
      invalid('ZIP uncompressed size limit exceeded');
    if (local + 30 > centralStart || buffer.readUInt32LE(local) !== 0x04034b50)
      invalid();
    const localNameLength = buffer.readUInt16LE(local + 26);
    const dataOffset =
      local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    if (
      buffer.readUInt16LE(local + 6) !== flags ||
      buffer.readUInt16LE(local + 8) !== method ||
      localNameLength !== nameLength ||
      dataOffset + compressedSize > centralStart ||
      !buffer
        .subarray(local + 30, local + 30 + localNameLength)
        .equals(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    )
      invalid();
    if (
      !(flags & 8) &&
      (buffer.readUInt32LE(local + 18) !== compressedSize ||
        buffer.readUInt32LE(local + 22) !== size ||
        buffer.readUInt32LE(local + 14) !== crc)
    )
      invalid();
    if (method === 0 && compressedSize !== size) invalid();
    if (name.endsWith('/') && size !== 0) invalid();
    ranges.push([local, dataOffset + compressedSize]);
    entries.push({ name, size, compressedSize, dataOffset, method, crc });
    cursor = entryEnd;
  }
  if (cursor !== eocd) invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++)
    if (ranges[index][0] < ranges[index - 1][1]) invalid();
  return entries;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let index = 0; index < 8; index++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** zlib enforces the actual output allocation limit, even if ZIP metadata lies. */
export function readZipEntry(
  buffer: Buffer,
  entry: ZipEntry,
  maxBytes: number,
): Buffer {
  if (entry.size > maxBytes) invalid('ZIP extraction size limit exceeded');
  const compressed = buffer.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let bytes: Buffer;
  try {
    bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, Math.min(maxBytes, entry.size) + 1),
          });
  } catch {
    return invalid('ZIP extraction failed or size limit exceeded');
  }
  if (
    bytes.length > maxBytes ||
    bytes.length !== entry.size ||
    crc32(bytes) !== entry.crc
  )
    invalid('ZIP extraction size or integrity check failed');
  return bytes;
}

export function extractMineruArchive(
  buffer: Buffer,
  overrides: Partial<ArchiveLimits> = {},
): ParsedDocument {
  const limits = limitsFor(overrides);
  const entries = inspectZip(buffer, limits);
  const markdownEntries = entries.filter(
    (entry) => posix.basename(entry.name) === 'full.md',
  );
  if (markdownEntries.length !== 1)
    invalid('MinerU archive must contain one full.md');
  const markdownEntry = markdownEntries[0];
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(
      readZipEntry(buffer, markdownEntry, limits.maxMarkdownBytes),
    );
  } catch (error) {
    if (error instanceof MineruError) throw error;
    return invalid('Invalid Markdown encoding');
  }
  if (!hasMeaningfulText(markdown))
    invalid('MinerU returned no meaningful OCR text');
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const images: ParsedImage[] = [];
  const seen = new Set<string>();
  const replacements = new Map<string, string>();
  let extractedBytes = markdownEntry.size;
  for (const reference of collectImageReferences(markdown)) {
    // No external images are fetched, and no dangerous/data URI is passed through to the editor.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference))
      invalid('External image references are not allowed');
    let relative: string;
    try {
      relative = decodeURIComponent(reference);
    } catch {
      return invalid('Invalid image reference');
    }
    relative = relative.replace(/^(?:\.\/)+/, '');
    if (!safeArchivePath(relative) || /[?#]/.test(relative))
      invalid('Unsafe image reference');
    const path = posix.join(posix.dirname(markdownEntry.name), relative);
    const entry = byName.get(path);
    if (!entry || entry.name.endsWith('/'))
      invalid('Missing local image in MinerU archive');
    replacements.set(reference, path);
    if (seen.has(path)) continue;
    const bytes = readZipEntry(buffer, entry, limits.maxImageBytes);
    const contentType = rasterContentType(bytes, posix.extname(path).slice(1));
    if (!contentType) invalid('Invalid or unsupported raster image format');
    extractedBytes += bytes.length;
    if (extractedBytes > limits.maxUncompressedBytes)
      invalid('ZIP actual extraction limit exceeded');
    images.push({ path, bytes, contentType });
    seen.add(path);
  }
  return {
    markdown: rewriteImageUrls(markdown, replacements),
    images,
    warnings: [],
    parser: 'mineru',
  };
}
