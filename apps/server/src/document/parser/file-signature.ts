import { BadRequestException } from '@nestjs/common';
import { ARCHIVE_LIMITS, inspectZip, readZipEntry } from './mineru-archive.js';
import { rasterContentType } from './raster-signature.js';

export function validateFileSignature(buffer: Buffer, extension: string): void {
  if (extension === 'txt' || extension === 'md') return;
  let valid = false;
  if (extension === 'pdf') {
    valid =
      buffer.length >= 8 && /^%PDF-\d\.\d/.test(buffer.toString('ascii', 0, 8));
  } else if (['docx', 'pptx', 'xlsx'].includes(extension)) {
    try {
      const entries = inspectZip(buffer);
      const main = {
        docx: 'word/document.xml',
        pptx: 'ppt/presentation.xml',
        xlsx: 'xl/workbook.xml',
      }[extension];
      valid =
        entries.some(
          (entry) => entry.name === '[Content_Types].xml' && entry.size > 0,
        ) && entries.some((entry) => entry.name === main && entry.size > 0);
      if (valid) {
        // Check actual output before handing XLSX to an unbounded third-party ZIP reader.
        for (const entry of entries)
          readZipEntry(buffer, entry, ARCHIVE_LIMITS.maxUncompressedBytes);
      }
    } catch {
      valid = false;
    }
  } else {
    valid = !!rasterContentType(buffer, extension);
  }
  if (!valid)
    throw new BadRequestException(
      '文件格式与扩展名不匹配或文件已损坏 (invalid signature)',
    );
}
