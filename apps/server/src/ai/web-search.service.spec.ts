import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { WebSearchService } from './web-search.service.js';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string, fallback?: string) =>
      key in values ? values[key] : fallback,
  } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bochaItem(name: string, url: string) {
  return {
    name,
    url,
    summary: `${name} 摘要`,
    siteName: new URL(url).hostname,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebSearchService · 多提供商降级', () => {
  it('Bocha 成功时不调用 Tavily，并标记 provider=bocha', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        data: {
          webPages: {
            value: [bochaItem('结果 A', 'https://a.example.com/doc')],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: 'bocha-key', TAVILY_API_KEY: 'tvly-key' }),
    );

    const result = await service.search('汇率', 3);

    expect(result.provider).toBe('bocha');
    expect(result.items).toEqual([
      {
        title: '结果 A',
        url: 'https://a.example.com/doc',
        snippet: '结果 A 摘要',
        siteName: 'a.example.com',
      },
    ]);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.bochaai.com/v1/web-search',
    );
  });

  it('Bocha 配额/HTTP 失败时自动切换 Tavily', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"code":403,"message":"quota exhausted"}', {
          status: 403,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              title: 'Tavily 结果',
              url: 'https://tavily.example.com/news',
              content: '美元汇率 7.10',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: 'bocha-key', TAVILY_API_KEY: 'tvly-key' }),
    );

    const result = await service.search('今天美元汇率', 3);

    expect(result.provider).toBe('tavily');
    expect(result.error).toBeUndefined();
    expect(result.items[0]).toMatchObject({
      title: 'Tavily 结果',
      url: 'https://tavily.example.com/news',
      snippet: '美元汇率 7.10',
      siteName: 'tavily.example.com',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tvly-key',
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: '今天美元汇率',
      search_depth: 'basic',
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
    });
  });

  it('Bocha 未配置 Key 时直接使用 Tavily', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        results: [
          { title: 'T', url: 'https://t.example.com', content: 'C' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: '', TAVILY_API_KEY: 'tvly-key' }),
    );

    const result = await service.search('问题', 5);

    expect(result.provider).toBe('tavily');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.tavily.com/search');
  });

  it('Bocha 网络异常时切换 Tavily', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ title: 'T', url: 'https://t.example.com', content: 'C' }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: 'bocha-key', TAVILY_API_KEY: 'tvly-key' }),
    );

    const result = await service.search('问题', 5);

    expect(result.provider).toBe('tavily');
    expect(result.items).toHaveLength(1);
  });

  it('两个提供商都失败时返回合并错误', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bocha down', { status: 500 }))
      .mockResolvedValueOnce(new Response('tavily down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: 'bocha-key', TAVILY_API_KEY: 'tvly-key' }),
    );

    const result = await service.search('问题', 5);

    expect(result.items).toEqual([]);
    expect(result.provider).toBeUndefined();
    expect(result.error).toContain('Bocha');
    expect(result.error).toContain('Tavily');
    expect(result.error).toContain('500');
  });

  it('两个 Key 都未配置时返回配置错误，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: '', TAVILY_API_KEY: '' }),
    );

    const result = await service.search('问题', 5);

    expect(result.items).toEqual([]);
    expect(result.error).toContain('未配置');
    expect(result.error).toContain('TAVILY_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('可通过 WEB_SEARCH_PROVIDERS 反转优先级', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        results: [{ title: 'T', url: 'https://t.example.com', content: 'C' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({
        BOCHA_API_KEY: 'bocha-key',
        TAVILY_API_KEY: 'tvly-key',
        WEB_SEARCH_PROVIDERS: 'tavily,bocha',
      }),
    );

    const result = await service.search('问题', 5);

    expect(result.provider).toBe('tavily');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.tavily.com/search');
  });

  it('首个提供商成功但结果为空时不切第二个', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ code: 200, data: { webPages: { value: [] } } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new WebSearchService(
      makeConfig({ BOCHA_API_KEY: 'bocha-key', TAVILY_API_KEY: 'tvly-key' }),
    );

    const result = await service.search('冷门问题', 5);

    expect(result.items).toEqual([]);
    expect(result.provider).toBe('bocha');
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
