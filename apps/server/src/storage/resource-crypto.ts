import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Envelope: KHRE magic + version 1 (authenticated), IV (12), tag (16), ciphertext.
// This protects stored blob bytes, not the confidentiality of the key in a database.
const HEADER = Buffer.from([0x4b, 0x48, 0x52, 0x45, 1]);
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const CIPHERTEXT_OFFSET = HEADER.length + IV_LENGTH + TAG_LENGTH;

function parseKey(keyHex: string): Buffer {
  if (
    typeof keyHex !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(keyHex) ||
    keyHex.length !== 64
  ) {
    throw new Error(
      'Resource encryption key must be exactly 32 bytes encoded as hex',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export function createResourceKey(): string {
  return randomBytes(32).toString('hex');
}

export function encryptResource(bytes: Buffer, keyHex: string): Buffer {
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(HEADER);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([HEADER, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptResource(bytes: Buffer, keyHex: string): Buffer {
  const key = parseKey(keyHex);
  if (
    bytes.length < CIPHERTEXT_OFFSET ||
    !bytes.subarray(0, HEADER.length).equals(HEADER)
  ) {
    throw new Error('Invalid or unsupported encrypted resource envelope');
  }
  const ivEnd = HEADER.length + IV_LENGTH;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    bytes.subarray(HEADER.length, ivEnd),
    {
      authTagLength: TAG_LENGTH,
    },
  );
  decipher.setAAD(bytes.subarray(0, HEADER.length));
  decipher.setAuthTag(bytes.subarray(ivEnd, CIPHERTEXT_OFFSET));
  // Never return unauthenticated plaintext from update() before final() succeeds.
  return Buffer.concat([
    decipher.update(bytes.subarray(CIPHERTEXT_OFFSET)),
    decipher.final(),
  ]);
}
