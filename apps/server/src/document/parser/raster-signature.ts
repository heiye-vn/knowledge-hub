/** Verify extension and structural magic together; do not infer MIME from provider filenames. */
export function rasterContentType(
  buffer: Buffer,
  extension: string,
): string | undefined {
  switch (extension.toLowerCase()) {
    case 'png':
      return buffer.length >= 24 &&
        buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        buffer.readUInt32BE(8) === 13 &&
        buffer.toString('ascii', 12, 16) === 'IHDR' &&
        buffer.readUInt32BE(16) > 0 &&
        buffer.readUInt32BE(20) > 0
        ? 'image/png'
        : undefined;
    case 'jpg':
    case 'jpeg':
      return buffer.length >= 4 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff &&
        buffer[3] !== 0 &&
        buffer[3] !== 0xff
        ? 'image/jpeg'
        : undefined;
    case 'webp':
      return buffer.length >= 20 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP' &&
        ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16)) &&
        buffer.readUInt32LE(4) + 8 === buffer.length
        ? 'image/webp'
        : undefined;
    default:
      return undefined;
  }
}
