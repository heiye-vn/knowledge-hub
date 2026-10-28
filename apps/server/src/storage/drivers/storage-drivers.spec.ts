import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { AliyunOssDriver } from './aliyun-oss.driver.js';
import { RustfsDriver } from './rustfs.driver.js';

const key = 'resources/123/original.enc';
const options = {
  fileName: 'original.pdf',
  contentType: 'application/octet-stream',
};

for (const Driver of [AliyunOssDriver, RustfsDriver]) {
  describe(Driver.name, () => {
    let send: MockInstance<S3Client['send']>;

    function createDriver(enabled = true, initialize = true) {
      const values: Record<string, string> = {
        OSS_ENABLED: String(enabled),
        OSS_ACCESS_KEY_ID: 'test-id',
        OSS_ACCESS_KEY_SECRET: 'test-secret',
        OSS_BUCKET: 'test-bucket',
        RUSTFS_ENABLED: String(enabled),
        RUSTFS_BUCKET: 'test-bucket',
      };
      const config = {
        get: (name: string, fallback?: string) => values[name] ?? fallback,
      } as ConfigService;
      const driver = new Driver(config);
      if (initialize) driver.onModuleInit();
      send.mockClear();
      return driver;
    }

    beforeEach(() => {
      send = vi
        .spyOn(S3Client.prototype, 'send')
        .mockResolvedValue({} as never);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('uploads the exact preallocated key and bytes without changing bucket permissions', async () => {
      const driver = createDriver();
      const bytes = Buffer.from('encrypted envelope');
      const result = await driver.uploadBytes(bytes, {
        ...options,
        objectKey: key,
      });
      const put = send.mock.calls.find(
        ([command]) => command instanceof PutObjectCommand,
      )?.[0];
      expect(put).toBeInstanceOf(PutObjectCommand);
      expect(put?.input).toEqual({
        Bucket: 'test-bucket',
        Key: key,
        Body: bytes,
        ContentType: 'application/octet-stream',
        ContentLength: 18,
      });
      expect(result.key).toBe(key);
      expect(result.url.endsWith(`/${key}`)).toBe(true);
      expect(
        send.mock.calls.every(
          ([command]) =>
            command instanceof PutObjectCommand ||
            command instanceof HeadBucketCommand,
        ),
      ).toBe(true);
    });

    it('preserves legacy default generated keys and converts Uint8Array bytes', async () => {
      const driver = createDriver();
      const result = await driver.uploadBytes(new Uint8Array([1, 2]), options);
      expect(result.key).toMatch(
        /^documents\/\d{4}\/\d{2}\/\d{2}\/original-[a-f0-9-]+\.pdf$/,
      );
      const put = send.mock.calls.find(
        ([command]) => command instanceof PutObjectCommand,
      )?.[0];
      expect(put?.input).toMatchObject({
        Key: result.key,
        Body: Buffer.from([1, 2]),
        ContentLength: 2,
      });
      const prefixed = await driver.uploadBytes(Buffer.alloc(0), {
        ...options,
        prefix: '/legacy/',
      });
      expect(prefixed.key).toMatch(/^legacy\//);
    });

    it.each([
      '',
      '../private',
      'a/../b',
      'a..b',
      '/absolute',
      'a\\b',
      'a\0b',
      'a//b',
      './a',
      'a/',
      'https://bucket/key',
      'a%2fb',
      'a?b',
      'a#b',
      'a\n',
      'a\r',
      'a\u2028',
    ])(
      'rejects unsafe server-controlled key %j before any request',
      async (unsafe) => {
        const driver = createDriver();
        await expect(
          driver.uploadBytes(Buffer.alloc(0), {
            ...options,
            objectKey: unsafe,
          }),
        ).rejects.toThrow(/key/i);
        await expect(driver.readBytes(unsafe, 10)).rejects.toThrow(/key/i);
        await expect(driver.deleteObject(unsafe)).rejects.toThrow(/key/i);
        expect(send).not.toHaveBeenCalled();
      },
    );

    it.each([0, -1, NaN, Infinity, 1.5])(
      'rejects invalid maxBytes %s',
      async (limit) => {
        const driver = createDriver();
        await expect(driver.readBytes(key, limit)).rejects.toThrow(/maxBytes/i);
        expect(send).not.toHaveBeenCalled();
      },
    );

    it.each([5, undefined])(
      'reads at the byte limit with ContentLength %s',
      async (length) => {
        const driver = createDriver();
        send.mockResolvedValueOnce({
          ContentLength: length,
          Body: Readable.from([Buffer.from('he'), Buffer.from('llo')]),
        } as never);
        expect(await driver.readBytes(key, 5)).toEqual(Buffer.from('hello'));
        expect(send).toHaveBeenCalledOnce();
        const [command, request] = send.mock.calls[0];
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toEqual({ Bucket: 'test-bucket', Key: key });
        expect(request).toMatchObject({ abortSignal: expect.any(AbortSignal) });
        expect(
          (request as { abortSignal: AbortSignal }).abortSignal.aborted,
        ).toBe(false);
      },
    );

    it('returns empty object bytes', async () => {
      const driver = createDriver();
      send.mockResolvedValueOnce({
        ContentLength: 0,
        Body: Readable.from([]),
      } as never);
      expect(await driver.readBytes(key, 1)).toEqual(Buffer.alloc(0));
    });

    it('rejects oversized ContentLength without consuming the body and aborts', async () => {
      const driver = createDriver();
      const read = vi.fn();
      const body = new Readable({ read });
      send.mockResolvedValueOnce({ ContentLength: 6, Body: body } as never);
      await expect(driver.readBytes(key, 5)).rejects.toThrow(
        /maxBytes|limit|size/i,
      );
      expect(read).not.toHaveBeenCalled();
      expect(body.destroyed).toBe(true);
      expect(
        (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal
          .aborted,
      ).toBe(true);
    });

    it.each([undefined, 1])(
      'bounds actual bytes when ContentLength is %s',
      async (length) => {
        const driver = createDriver();
        const body = Readable.from([Buffer.from('123'), Buffer.from('456')]);
        send.mockResolvedValueOnce({
          ContentLength: length,
          Body: body,
        } as never);
        await expect(driver.readBytes(key, 5)).rejects.toThrow(
          /maxBytes|limit|size/i,
        );
        expect(body.destroyed).toBe(true);
        expect(
          (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal
            .aborted,
        ).toBe(true);
      },
    );

    it('propagates stream errors and aborts the request', async () => {
      const driver = createDriver();
      const body = new Readable({
        read() {
          this.destroy(new Error('stream failed'));
        },
      });
      send.mockResolvedValueOnce({ Body: body } as never);
      await expect(driver.readBytes(key, 5)).rejects.toThrow('stream failed');
      expect(body.destroyed).toBe(true);
      expect(
        (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal
          .aborted,
      ).toBe(true);
    });

    it('rejects a missing body instead of silently returning empty data', async () => {
      const driver = createDriver();
      send.mockResolvedValueOnce({} as never);
      await expect(driver.readBytes(key, 5)).rejects.toThrow(/body/i);
    });

    it('propagates GET failure', async () => {
      const driver = createDriver();
      send.mockRejectedValueOnce(new Error('NoSuchKey'));
      await expect(driver.readBytes(key, 5)).rejects.toThrow('NoSuchKey');
    });

    it('times out and aborts a request stalled before headers, disposing a late body', async () => {
      vi.useFakeTimers();
      const driver = createDriver();
      let resolve!: (value: never) => void;
      send.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = driver.readBytes(key, 5);
      const rejected = expect(pending).rejects.toThrow(/timed? out|timeout/i);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(
        (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal
          .aborted,
      ).toBe(true);
      const body = new Readable({ read() {} });
      resolve({ Body: body } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(body.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('times out a stalled response stream, destroys it and clears its deadline', async () => {
      vi.useFakeTimers();
      const driver = createDriver();
      const body = new Readable({ read() {} });
      send.mockResolvedValueOnce({ Body: body } as never);
      const rejected = expect(driver.readBytes(key, 5)).rejects.toThrow(
        /timed? out|timeout/i,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(body.destroyed).toBe(true);
      expect(
        (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal
          .aborted,
      ).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the read deadline after success', async () => {
      vi.useFakeTimers();
      const driver = createDriver();
      send.mockResolvedValueOnce({
        Body: Readable.from([Buffer.from('a')]),
      } as never);
      await driver.readBytes(key, 1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('deletes the exact key without checking or creating a bucket', async () => {
      const driver = createDriver();
      await driver.deleteObject(key);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
      expect(send.mock.calls[0][0].input).toEqual({
        Bucket: 'test-bucket',
        Key: key,
      });
    });

    it('propagates deletion failure', async () => {
      const driver = createDriver();
      send.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(driver.deleteObject(key)).rejects.toThrow('AccessDenied');
    });

    it.each([
      [false, true],
      [true, false],
    ])(
      'rejects operations when unavailable (enabled=%s, initialized=%s)',
      async (enabled, initialized) => {
        const driver = createDriver(enabled, initialized);
        expect(driver.isEnabled()).toBe(false);
        await expect(
          driver.uploadBytes(Buffer.alloc(0), options),
        ).rejects.toThrow(ServiceUnavailableException);
        await expect(driver.readBytes(key, 5)).rejects.toThrow(
          ServiceUnavailableException,
        );
        await expect(driver.deleteObject(key)).rejects.toThrow(
          ServiceUnavailableException,
        );
        expect(send).not.toHaveBeenCalled();
      },
    );
  });
}
