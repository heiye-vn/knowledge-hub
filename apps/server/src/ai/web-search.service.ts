import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
}

export type WebSearchProvider = 'bocha' | 'tavily';

export interface WebSearchResult {
  query: string;
  items: WebSearchHit[];
  error?: string;
  /** 实际返回结果的提供商，便于前端/日志确认降级是否发生 */
  provider?: WebSearchProvider;
}

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search';
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

const PROVIDER_LABEL: Record<WebSearchProvider, string> = {
  bocha: 'Bocha',
  tavily: 'Tavily',
};

const DEFAULT_PROVIDERS: WebSearchProvider[] = ['bocha', 'tavily'];

/**
 * 多提供商联网搜索：按 WEB_SEARCH_PROVIDERS 顺序逐个尝试，失败自动切换。
 *
 * - 只有配置了 Key 的提供商参与链路；
 * - HTTP/网络/接口错误会切下一个；成功但结果为空不切，避免双份计费；
 * - 全部失败时返回合并错误，由模型/前端转述，不阻断知识库主链路。
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly config: ConfigService) {}

  async search(query: string, count = 5): Promise<WebSearchResult> {
    const providers = this.resolveProviders();
    if (!providers.length) {
      return {
        query,
        items: [],
        error: '未配置 BOCHA_API_KEY 或 TAVILY_API_KEY，无法联网搜索',
      };
    }

    const failures: string[] = [];
    for (const provider of providers) {
      const result =
        provider === 'bocha'
          ? await this.searchBocha(query, count)
          : await this.searchTavily(query, count);

      if (!result.error) {
        this.logger.log(
          `联网搜索成功：provider=${provider}, items=${result.items.length}`,
        );
        return { ...result, provider };
      }

      failures.push(`${PROVIDER_LABEL[provider]}：${result.error}`);
      this.logger.warn(
        `联网搜索失败：provider=${provider}, error=${result.error}`,
      );
    }

    return { query, items: [], error: failures.join('；') };
  }

  /** 配置顺序 → 有效提供商；只保留已配置 Key 的项 */
  private resolveProviders(): WebSearchProvider[] {
    const raw = this.config.get<string>(
      'WEB_SEARCH_PROVIDERS',
      'bocha,tavily',
    );
    const ordered = (raw || 'bocha,tavily')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(
        (item): item is WebSearchProvider =>
          item === 'bocha' || item === 'tavily',
      );
    const unique = [...new Set(ordered)];
    const candidates = unique.length ? unique : DEFAULT_PROVIDERS;
    return candidates.filter((provider) => Boolean(this.keyFor(provider)));
  }

  private keyFor(provider: WebSearchProvider): string {
    const keyName =
      provider === 'bocha' ? 'BOCHA_API_KEY' : 'TAVILY_API_KEY';
    return this.config.get<string>(keyName)?.trim() || '';
  }

  private async searchBocha(
    query: string,
    count: number,
  ): Promise<WebSearchResult> {
    const apiKey = this.keyFor('bocha');
    if (!apiKey) {
      return { query, items: [], error: '未配置 BOCHA_API_KEY' };
    }

    try {
      const response = await fetch(BOCHA_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          freshness: 'noLimit',
          summary: true,
          count: Math.min(Math.max(count, 1), 10),
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        return {
          query,
          items: [],
          error: `搜索失败（${response.status}）${detail.slice(0, 120)}`,
        };
      }

      const json = (await response.json()) as {
        code?: number;
        msg?: string;
        data?: {
          webPages?: {
            value?: Array<{
              name?: string;
              url?: string;
              summary?: string;
              snippet?: string;
              siteName?: string;
            }>;
          };
        };
      };

      if (json.code !== 200 || !json.data) {
        return {
          query,
          items: [],
          error: json.msg ?? '搜索接口返回异常',
        };
      }

      const items = (json.data.webPages?.value ?? [])
        .filter((page) => page.url && page.name)
        .map((page) => ({
          title: page.name as string,
          url: page.url as string,
          snippet: (page.summary || page.snippet || '').trim(),
          siteName: page.siteName,
        }));

      return { query, items };
    } catch (error) {
      return {
        query,
        items: [],
        error: `请求失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async searchTavily(
    query: string,
    count: number,
  ): Promise<WebSearchResult> {
    const apiKey = this.keyFor('tavily');
    if (!apiKey) {
      return { query, items: [], error: '未配置 TAVILY_API_KEY' };
    }

    try {
      const response = await fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          topic: 'general',
          search_depth: 'basic',
          max_results: Math.min(Math.max(count, 1), 10),
          include_answer: false,
          include_raw_content: false,
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        return {
          query,
          items: [],
          error: `搜索失败（${response.status}）${detail.slice(0, 120)}`,
        };
      }

      const json = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          score?: number;
        }>;
        detail?: string | { error?: string };
      };
      const detail =
        typeof json.detail === 'string' ? json.detail : json.detail?.error;
      if (detail) {
        return { query, items: [], error: detail };
      }

      const items = (json.results ?? [])
        .filter((item) => item.url && item.title)
        .map((item) => ({
          title: item.title as string,
          url: item.url as string,
          snippet: (item.content ?? '').trim(),
          siteName: hostOf(item.url as string),
        }));

      return { query, items };
    } catch (error) {
      return {
        query,
        items: [],
        error: `请求失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
