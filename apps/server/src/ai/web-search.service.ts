import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
}

export interface WebSearchResult {
  query: string;
  items: WebSearchHit[];
  error?: string;
}

/**
 * Bocha 联网搜索封装，作为 Agent 的 web_search 工具后端。
 *
 * 降级设计：未配置 BOCHA_API_KEY 或接口失败时不抛错，返回带 error
 * 说明的空结果——由模型向用户转述原因，不阻断知识库问答主链路。
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly config: ConfigService) {}

  async search(query: string, count = 5): Promise<WebSearchResult> {
    const apiKey = this.config.get<string>('BOCHA_API_KEY');
    if (!apiKey) {
      return {
        query,
        items: [],
        error: '未配置 BOCHA_API_KEY，无法联网搜索',
      };
    }

    const response = await fetch('https://api.bochaai.com/v1/web-search', {
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
      this.logger.warn(`Bocha 搜索失败：status=${response.status}`);
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
  }
}
