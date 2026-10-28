import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { MineruError } from './mineru-error.js';

export interface MineruRequest {
  method: 'POST' | 'PUT' | 'GET';
  headers?: Record<string, string>;
  body?: Buffer;
  deadline: number;
  timeoutMs: number;
  maxBytes: number;
  trustedHosts: readonly string[];
  signal?: AbortSignal;
}
export interface MineruResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
const securityError = () =>
  new MineruError(
    'MinerU rejected an unsafe remote destination',
    'MINERU_UNSAFE_URL',
  );

function validatedUrl(raw: string, trustedHosts: readonly string[]): URL {
  let url: URL;
  try {
    // Reject ambiguous raw forms the WHATWG parser silently normalizes.
    if (/[\\#\s\x00-\x1f]/.test(raw)) throw securityError();
    url = new URL(raw);
  } catch {
    throw securityError();
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(hostname.replace(/^\[|\]$/g, '')) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.') ||
    !/^[a-z0-9.-]+$/.test(hostname)
  )
    throw securityError();
  const trusted = trustedHosts.some((suffix) => {
    const normalized = suffix.trim().toLowerCase().replace(/^\./, '');
    return (
      normalized.includes('.') &&
      /^[a-z0-9.-]+$/.test(normalized) &&
      (hostname === normalized || hostname.endsWith(`.${normalized}`))
    );
  });
  if (!trusted) throw securityError();
  return url;
}

/** Conservative global-unicast allow policy, including IPv4-mapped IPv6 rejection. */
function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      // 198.18.0.0/15 and 2001:2::/48 are benchmark ranges used by local
      // TUN/proxy fake-IP DNS. Only allowlisted hostnames reach this check.
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(':')[0], 16);
  // Exclude transition/documentation/special networks, not only link-local and ULA.
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !/^2001:(?:0*:|0*10:|0*20:|db8:)/i.test(address) &&
    !address.startsWith('2002:') &&
    !address.toLowerCase().startsWith('3fff:')
  );
}

/** DNS answers are validated once and pinned into https.request's lookup callback. */
export async function requestBytes(
  rawUrl: string,
  options: MineruRequest,
): Promise<MineruResponse> {
  const expires = Math.min(options.deadline, Date.now() + options.timeoutMs);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeoutError = () =>
    new MineruError(
      'MinerU request timeout or deadline exceeded',
      'MINERU_TIMEOUT',
      true,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(timeoutError());
      },
      Math.max(0, expires - Date.now()),
    );
  });
  try {
    return await Promise.race([
      timedOut,
      (async () => {
        let url = validatedUrl(rawUrl, options.trustedHosts);
        for (let hop = 0; hop <= 3; hop++) {
          if (controller.signal.aborted || Date.now() >= expires)
            throw timeoutError();
          const addresses = await lookup(url.hostname, {
            all: true,
            verbatim: true,
          });
          if (
            !addresses.length ||
            addresses.length > 32 ||
            addresses.some(({ address }) => !isPublicAddress(address))
          )
            throw securityError();
          if (controller.signal.aborted) throw timeoutError();
          const pinned = addresses[0];
          const response = await new Promise<MineruResponse>(
            (resolve, reject) => {
              const req = request(
                url,
                {
                  method: options.method,
                  headers: options.headers,
                  agent: false,
                  signal: controller.signal,
                  // Preserve hostname/SNI and certificate verification, pin only the connection address.
                  lookup: (_hostname, lookupOptions, callback) => {
                    if (lookupOptions.all) callback(null, [pinned]);
                    else callback(null, pinned.address, pinned.family);
                  },
                },
                (res) => {
                  const status = res.statusCode ?? 0;
                  if (status >= 300 && status < 400) {
                    res.destroy();
                    resolve({
                      status,
                      headers: res.headers,
                      body: Buffer.alloc(0),
                    });
                    return;
                  }
                  const declared = res.headers['content-length'];
                  if (
                    declared &&
                    (!/^\d+$/.test(declared) ||
                      Number(declared) > options.maxBytes)
                  ) {
                    res.destroy();
                    reject(
                      new MineruError(
                        'MinerU response size limit exceeded',
                        'MINERU_SIZE_LIMIT',
                      ),
                    );
                    return;
                  }
                  let length = 0;
                  const chunks: Buffer[] = [];
                  res.on('data', (chunk: Buffer) => {
                    length += chunk.length;
                    if (length > options.maxBytes) {
                      res.destroy();
                      reject(
                        new MineruError(
                          'MinerU response size limit exceeded',
                          'MINERU_SIZE_LIMIT',
                        ),
                      );
                    } else chunks.push(chunk);
                  });
                  res.on('end', () =>
                    resolve({
                      status,
                      headers: res.headers,
                      body: Buffer.concat(chunks, length),
                    }),
                  );
                  res.on('error', () =>
                    reject(
                      new MineruError(
                        'MinerU response interrupted',
                        'MINERU_NETWORK',
                        true,
                      ),
                    ),
                  );
                  res.on('aborted', () =>
                    reject(
                      new MineruError(
                        'MinerU response interrupted',
                        'MINERU_NETWORK',
                        true,
                      ),
                    ),
                  );
                },
              );
              req.on('error', () =>
                reject(
                  controller.signal.aborted
                    ? timeoutError()
                    : new MineruError(
                        'MinerU network request failed',
                        'MINERU_NETWORK',
                        true,
                      ),
                ),
              );
              req.end(options.body);
            },
          );
          if (response.status < 300 || response.status >= 400) return response;
          if (
            options.headers &&
            Object.keys(options.headers).some(
              (key) => key.toLowerCase() === 'authorization',
            )
          ) {
            let locationHost = 'unknown';
            try {
              locationHost = new URL(response.headers.location ?? '').hostname;
            } catch {
              /* Keep the diagnostic host opaque. */
            }
            throw new MineruError(
              `MinerU API redirect rejected (status=${response.status}, host=${locationHost})`,
              'MINERU_UNSAFE_URL',
            );
          }
          if (
            !response.headers.location ||
            hop === 3 ||
            ![301, 302, 303, 307, 308].includes(response.status) ||
            (options.method !== 'GET' && ![307, 308].includes(response.status))
          )
            throw securityError();
          // Redirects are validated before DNS and before any subsequent request.
          try {
            url = validatedUrl(
              new URL(response.headers.location, url).href,
              options.trustedHosts,
            );
          } catch {
            throw securityError();
          }
        }
        throw securityError();
      })(),
    ]);
  } catch (error) {
    if (error instanceof MineruError) throw error;
    throw new MineruError(
      'MinerU network request failed',
      'MINERU_NETWORK',
      true,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
