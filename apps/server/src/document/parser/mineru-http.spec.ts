import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestBytes } from './mineru-http.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
const options = () => ({
  method: 'GET' as const,
  deadline: Date.now() + 5000,
  timeoutMs: 1000,
  maxBytes: 100,
  trustedHosts: ['aliyuncs.com', 'mineru.net'],
});
function respond(
  status: number,
  headers: Record<string, string>,
  body: string,
) {
  vi.mocked(request).mockImplementationOnce(((
    url: URL,
    opts: object,
    callback: (res: PassThrough) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    req.destroy = vi.fn();
    req.end = () =>
      queueMicrotask(() => {
        const res = Object.assign(new PassThrough(), {
          statusCode: status,
          headers,
        });
        callback(res);
        res.end(body);
      });
    return req;
  }) as unknown as typeof request);
}

describe('MinerU DNS-pinned HTTPS transport (offline)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(lookup).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ] as never);
  });

  it.each([
    'http://oss.aliyuncs.com/a',
    'https://u:p@oss.aliyuncs.com/a',
    'https://oss.aliyuncs.com:8443/a',
    'https://oss.aliyuncs.com/a#x',
    'https://oss.aliyuncs.com/a#',
    'https://oss.aliyuncs.com\\path',
    'https://evil.test/a',
    'https://aliyuncs.com.evil.test/a',
    'https://127.0.0.1/a',
    'https://localhost/a',
  ])('rejects unauthorized URL before DNS/network: %s', async (url) => {
    await expect(requestBytes(url, options())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])('rejects private DNS address %s', async (address) => {
    vi.mocked(lookup).mockResolvedValue([
      { address, family: address.includes(':') ? 6 : 4 },
    ] as never);
    await expect(
      requestBytes('https://oss.aliyuncs.com/a', options()),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['198.18.0.30', '2001:2::19'])(
    'allows proxy fake-IP/benchmark address %s only after the host allowlist',
    async (address) => {
      vi.mocked(lookup).mockResolvedValue([
        { address, family: address.includes(':') ? 6 : 4 },
      ] as never);
      respond(200, {}, 'ok');
      await expect(
        requestBytes('https://oss.aliyuncs.com/a', options()),
      ).resolves.toMatchObject({ status: 200 });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('pins the validated public DNS address rather than resolving again on connect', async () => {
    respond(200, {}, 'ok');
    expect(
      (
        await requestBytes('https://oss.aliyuncs.com/a', options())
      ).body.toString(),
    ).toBe('ok');
    const requestOptions = vi.mocked(request).mock.calls[0][1] as {
      lookup: (
        host: string,
        options: unknown,
        callback: (...args: unknown[]) => void,
      ) => void;
    };
    const callback = vi.fn();
    requestOptions.lookup('oss.aliyuncs.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('validates redirect destinations and never forwards API credentials', async () => {
    respond(302, { location: 'https://evil.test/a' }, '');
    await expect(
      requestBytes('https://oss.aliyuncs.com/a', options()),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    respond(302, { location: 'https://oss.aliyuncs.com/b' }, '');
    await expect(
      requestBytes('https://mineru.net/api', {
        ...options(),
        headers: { Authorization: 'Bearer secret' },
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('follows a bounded validated asset redirect with no bearer', async () => {
    respond(307, { location: 'https://oss.aliyuncs.com/b' }, '');
    respond(200, {}, 'ok');
    expect(
      (
        await requestBytes('https://oss.aliyuncs.com/a', options())
      ).body.toString(),
    ).toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds declared and actual response bytes', async () => {
    respond(200, { 'content-length': '1000' }, '');
    await expect(
      requestBytes('https://oss.aliyuncs.com/a', options()),
    ).rejects.toThrow(/limit/i);
    respond(200, {}, 'a'.repeat(101));
    await expect(
      requestBytes('https://oss.aliyuncs.com/a', options()),
    ).rejects.toThrow(/limit/i);
  });

  it('stops a redirect loop after four requests', async () => {
    for (let i = 0; i < 4; i++)
      respond(307, { location: 'https://oss.aliyuncs.com/a' }, '');
    await expect(
      requestBytes('https://oss.aliyuncs.com/a', options()),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('rejects mixed public/private DNS answers rather than selecting just the public answer', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ] as never);
    await expect(
      requestBytes('https://oss.aliyuncs.com/a', options()),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('treats malformed redirect targets as permanent security failures', async () => {
    respond(302, { location: 'https://[' }, '');
    const error = await requestBytes(
      'https://oss.aliyuncs.com/a',
      options(),
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ retryable: false });
  });

  it('bounds stalled DNS resolution and sanitizes network errors', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    await expect(
      requestBytes('https://oss.aliyuncs.com/a?private', {
        ...options(),
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/timeout|deadline/i);
    vi.mocked(lookup).mockRejectedValue(
      new Error('credentials https://secret.test'),
    );
    const error = await requestBytes(
      'https://oss.aliyuncs.com/a',
      options(),
    ).catch((value: unknown) => value);
    expect(String(error)).not.toMatch(/credentials|secret.test/);
  });
});
