import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createResourceKey,
  decryptResource,
  encryptResource,
} from './resource-crypto.js';

describe('resource encryption', () => {
  it('creates independent random 32-byte hex keys', () => {
    const keys = Array.from({ length: 20 }, createResourceKey);
    expect(keys.every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(20);
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from('private document'),
    Buffer.from([0, 255, 128]),
  ])('round trips bytes without mutating the input', (bytes) => {
    const original = Buffer.from(bytes);
    const key = createResourceKey();
    const encrypted = encryptResource(bytes, key);
    expect(decryptResource(encrypted, key)).toEqual(original);
    expect(bytes).toEqual(original);
    expect(encrypted.equals(original)).toBe(false);
  });

  it('uses a versioned AES-256-GCM envelope with a random 12-byte IV', () => {
    const key = 'ab'.repeat(32);
    const bytes = Buffer.from(
      'a private original that must not appear in a public bucket',
    );
    const first = encryptResource(bytes, key);
    const second = encryptResource(bytes, key);
    // KHRE magic, version 1, 12-byte IV, 16-byte tag, ciphertext.
    expect(first.subarray(0, 5)).toEqual(
      Buffer.from([0x4b, 0x48, 0x52, 0x45, 1]),
    );
    expect(first.length).toBe(bytes.length + 33);
    expect(first.subarray(5, 17)).not.toEqual(second.subarray(5, 17));
    expect(first.includes(bytes)).toBe(false);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      first.subarray(5, 17),
    );
    decipher.setAAD(first.subarray(0, 5));
    decipher.setAuthTag(first.subarray(17, 33));
    expect(
      Buffer.concat([decipher.update(first.subarray(33)), decipher.final()]),
    ).toEqual(bytes);
  });

  it.each([0, 4, 5, 16, 17, 32, 33, 39])(
    'rejects tampering at envelope offset %i',
    (offset) => {
      const key = createResourceKey();
      const encrypted = encryptResource(Buffer.from('private bytes'), key);
      encrypted[offset] ^= 1;
      expect(() => decryptResource(encrypted, key)).toThrow();
    },
  );

  it('rejects a wrong key without exposing it', () => {
    const wrongKey = createResourceKey();
    const encrypted = encryptResource(
      Buffer.from('secret'),
      createResourceKey(),
    );
    expect(() => decryptResource(encrypted, wrongKey)).toThrow();
    try {
      decryptResource(encrypted, wrongKey);
    } catch (error) {
      expect(String(error)).not.toContain(wrongKey);
    }
  });

  it.each([
    '',
    'ab'.repeat(31),
    'ab'.repeat(33),
    'gg'.repeat(32),
    `${'ab'.repeat(32)}\n`,
  ])('rejects invalid key encoding or length', (key) => {
    expect(() => encryptResource(Buffer.from('private'), key)).toThrow(/key/i);
    expect(() => decryptResource(Buffer.alloc(33), key)).toThrow(/key/i);
  });

  it('accepts uppercase hex keys', () => {
    const encrypted = encryptResource(Buffer.from('private'), 'AB'.repeat(32));
    expect(decryptResource(encrypted, 'ab'.repeat(32))).toEqual(
      Buffer.from('private'),
    );
  });

  it.each([Buffer.alloc(0), Buffer.alloc(32), Buffer.from('plain original')])(
    'rejects truncated envelopes and plaintext',
    (bytes) =>
      expect(() => decryptResource(bytes, createResourceKey())).toThrow(),
  );

  it('rejects ciphertext truncation and appended bytes', () => {
    const key = createResourceKey();
    const encrypted = encryptResource(Buffer.from('private'), key);
    expect(() => decryptResource(encrypted.subarray(0, -1), key)).toThrow();
    expect(() =>
      decryptResource(Buffer.concat([encrypted, Buffer.from([0])]), key),
    ).toThrow();
  });
});
