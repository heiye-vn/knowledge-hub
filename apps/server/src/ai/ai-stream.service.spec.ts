import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  AiStreamService,
  packRetrieveResult,
  systemForPlan,
} from './ai-stream.service.js';
import type { ChatRoutePlan } from './chat-query-rewrite.service.js';
import type { RetrievalService } from '../rag/retrieval.service.js';
import type { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import type { WebSearchService } from './web-search.service.js';
import type { ChatSessionService } from './chat-session.service.js';
import type { ChatShortMemoryService } from './chat-short-memory.service.js';
import type { ChatLongMemoryService } from './chat-long-memory.service.js';
import type { GraphBuildService } from '../kg/graph-build.service.js';
import type { GraphChatHit } from '../kg/types/kg.types.js';
import type { SearchHit } from '../rag/types/rag.types.js';
import type { ChatSource } from './chat.types.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

const langchainMocks = vi.hoisted(() => ({
  tool: vi.fn((handler: unknown, config: Record<string, unknown>) => ({
    handler,
    ...config,
  })),
  createAgent: vi.fn((opts: unknown) => ({ opts })),
}));

vi.mock('langchain', () => ({
  createAgent: langchainMocks.createAgent,
  tool: langchainMocks.tool,
  modelCallLimitMiddleware: vi.fn(() => 'model-limit'),
  summarizationMiddleware: vi.fn(() => 'summarization'),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    constructor(_opts: unknown) {}
  },
}));

function hit(id: string): SearchHit {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `文档 ${id}`,
    content: `内容 ${id}`,
    heading: null,
    chunkIndex: 0,
    totalChunks: 1,
    score: 0.9,
    scores: { vector: null, keyword: 0.9 },
  };
}

const USER = {
  userId: '1001',
  username: 'user',
  roles: [],
  permissions: [],
  teamIds: ['team-1'],
} as AuthUser;

const GRADE_RELEVANT = { ok: true, reason: 'relevant' as const, text: '资料切题' };
const GRADE_IRRELEVANT = {
  ok: false,
  reason: 'irrelevant' as const,
  text: '只是词沾边',
};

function plan(overrides: Partial<ChatRoutePlan>): ChatRoutePlan {
  const allowRetrieve = overrides.allowRetrieve ?? true;
  return {
    intent: 'kb',
    label: '知识库',
    query: '问题',
    graphQueries: [],
    allowRetrieve,
    allowGraph: allowRetrieve,
    allowWeb: false,
    ...overrides,
  };
}

function emptyGraphHit(query = ''): GraphChatHit {
  return { query, entities: [], relations: [], documents: [] };
}

function makeService(options?: {
  hits?: SearchHit[];
  grade?: typeof GRADE_RELEVANT | typeof GRADE_IRRELEVANT;
  searchError?: Error;
}) {
  const hits = options?.hits ?? [hit('a')];
  const retrieval = {
    search: options?.searchError
      ? vi.fn(async () => {
          throw options.searchError;
        })
      : vi.fn(async () => hits),
  } as unknown as RetrievalService;
  const queryRewrite = {
    gradeHits: vi.fn(async () => options?.grade ?? GRADE_RELEVANT),
    rewriteAfterRetrieve: vi.fn(async () => '新检索词'),
  } as unknown as ChatQueryRewriteService;
  const webSearch = {
    search: vi.fn(async (query: string) => ({
      query,
      items: [
        {
          title: '公开结果',
          url: 'https://example.com/a',
          snippet: '摘要',
        },
      ],
    })),
  } as unknown as WebSearchService;
  const graph = {
    retrieveForChat: vi.fn(async (keyword: string | string[]) => ({
      query: Array.isArray(keyword) ? keyword.join(' / ') : keyword,
      entities: [
        { name: '发票', type: 'CONCEPT', description: null },
        { name: '报销', type: 'PROCESS', description: null },
      ],
      relations: [{ source: '发票', relation: 'REQUIRES', target: '报销' }],
      documents: [{ documentId: 'doc-1', title: '差旅报销办法' }],
    })),
  } as unknown as GraphBuildService;
  const service = new AiStreamService(
    {
      get: (k: string, d?: string) => (k === 'LLM_API_KEY' ? 'test-key' : d),
    } as unknown as ConfigService,
    retrieval,
    {} as ChatSessionService,
    webSearch,
    {} as ChatShortMemoryService,
    {} as ChatLongMemoryService,
    queryRewrite,
    graph,
  );

  return { service, retrieval, queryRewrite, webSearch, graph };
}

function makeAgent(
  service: AiStreamService,
  routePlan: ChatRoutePlan,
  question = '问题',
) {
  const writer = { write: vi.fn() };
  const sources: ChatSource[] = [];
  const agent = (
    service as unknown as {
      createTurnAgent: (
        user: AuthUser,
        topK: number,
        mode: string,
        persistSources: ChatSource[],
        writer: { write: (chunk: unknown) => void },
        plan: ChatRoutePlan,
        question: string,
      ) => { opts: { tools: Array<{ name: string; handler: (input: unknown) => unknown }> } };
    }
  ).createTurnAgent(USER, 5, 'hybrid', sources, writer, routePlan, question);
  expect(agent).toBeTruthy();
  return { agent, writer, sources };
}

function toolNamed(
  tools: Array<{ name: string; handler: (input: unknown) => unknown }>,
  name: string,
) {
  const found = tools.find((item) => item.name === name);
  expect(found, `缺少工具 ${name}`).toBeTruthy();
  return found!;
}

describe('AiStreamService · 按意图挂载工具', () => {
  beforeEach(() => {
    langchainMocks.tool.mockClear();
    langchainMocks.createAgent.mockClear();
    vi.clearAllMocks();
  });

  it('闲聊与个人偏好不挂任何检索工具', () => {
    for (const [intent, label] of [
      ['chitchat', '闲聊'],
      ['profile', '个人偏好'],
    ] as const) {
      const { service } = makeService();
      const { agent } = makeAgent(
        service,
        plan({
          intent,
          label,
          allowRetrieve: false,
          allowWeb: false,
        }),
      );
      expect(agent.opts.tools).toEqual([]);
    }
  });

  it('纯联网只挂 web_search', () => {
    const { service } = makeService();
    const { agent } = makeAgent(
      service,
      plan({
        intent: 'web',
        label: '联网搜索',
        allowRetrieve: false,
        allowWeb: true,
      }),
    );
    expect(agent.opts.tools.map((t) => t.name)).toEqual(['web_search']);
  });

  it('知识库只挂检索、改写与图谱，不挂联网', () => {
    const { service } = makeService();
    const { agent } = makeAgent(service, plan({}));
    expect(agent.opts.tools.map((t) => t.name)).toEqual([
      'retrieve_knowledge',
      'rewrite_query',
      'retrieve_graph',
    ]);
  });

  it('知识库不足再联网挂四套工具', () => {
    const { service } = makeService();
    const { agent } = makeAgent(
      service,
      plan({
        intent: 'kb_then_web',
        label: '知识库，不足则联网',
        allowWeb: true,
      }),
    );
    expect(agent.opts.tools.map((t) => t.name)).toEqual([
      'retrieve_knowledge',
      'rewrite_query',
      'retrieve_graph',
      'web_search',
    ]);
  });
});

describe('AiStreamService · retrieve_graph', () => {
  beforeEach(() => {
    langchainMocks.tool.mockClear();
    langchainMocks.createAgent.mockClear();
    vi.clearAllMocks();
  });

  it('合并路由图谱词与工具入参，带当前用户范围检索并写 data-graph', async () => {
    const { service, graph } = makeService();
    const { agent, writer } = makeAgent(
      service,
      plan({ graphQueries: ['发票', '报销'] }),
    );
    const graphTool = toolNamed(agent.opts.tools, 'retrieve_graph');

    const result = (await graphTool.handler({
      query: '差旅 / 住宿',
    })) as {
      context: string;
      insufficient: boolean;
    };

    expect(graph.retrieveForChat).toHaveBeenCalledWith(
      ['发票', '报销', '差旅 / 住宿'],
      8,
      { unrestricted: false, userId: '1001', teamIds: ['team-1'] },
    );
    expect(writer.write).toHaveBeenCalledWith({
      type: 'data-graph',
      data: expect.objectContaining({
        query: '发票 / 报销 / 差旅 / 住宿',
      }),
    });
    expect(result.context).toContain('关系：');
    expect(result.insufficient).toBe(false);
  });

  it('图谱无命中时返回 insufficient，并仍写空 data-graph 供前端提示', async () => {
    const { service, graph } = makeService();
    const empty = emptyGraphHit('发票 / 报销');
    (
      graph.retrieveForChat as unknown as {
        mockResolvedValueOnce: (value: GraphChatHit) => void;
      }
    ).mockResolvedValueOnce(empty);
    const { agent, writer } = makeAgent(
      service,
      plan({ graphQueries: ['发票', '报销'] }),
    );
    const graphTool = toolNamed(agent.opts.tools, 'retrieve_graph');

    const result = (await graphTool.handler({ query: '发票' })) as {
      insufficient: boolean;
    };

    expect(result.insufficient).toBe(true);
    expect(writer.write).toHaveBeenCalledWith({
      type: 'data-graph',
      data: empty,
    });
  });

  it('图谱查询失败时不中断 Agent，返回 error 与 insufficient', async () => {
    const { service, graph } = makeService();
    (
      graph.retrieveForChat as unknown as {
        mockRejectedValueOnce: (error: Error) => void;
      }
    ).mockRejectedValueOnce(new Error('neo4j down'));
    const { agent, writer } = makeAgent(
      service,
      plan({ graphQueries: ['发票'] }),
    );
    const graphTool = toolNamed(agent.opts.tools, 'retrieve_graph');

    const result = (await graphTool.handler({ query: '发票' })) as {
      error: string;
      insufficient: boolean;
    };

    expect(result.error).toBe('neo4j down');
    expect(result.insufficient).toBe(true);
    expect(writer.write).toHaveBeenCalledWith({
      type: 'data-graph',
      data: expect.objectContaining({ error: 'neo4j down' }),
    });
  });

  it('allowGraph=false 时不挂图谱工具', () => {
    const { service } = makeService();
    const { agent } = makeAgent(
      service,
      plan({ allowRetrieve: true, allowGraph: false }),
    );

    expect(agent.opts.tools.map((t) => t.name)).toEqual([
      'retrieve_knowledge',
      'rewrite_query',
    ]);
  });
});

describe('AiStreamService · retrieve_knowledge', () => {
  beforeEach(() => {
    langchainMocks.tool.mockClear();
    langchainMocks.createAgent.mockClear();
    vi.clearAllMocks();
  });

  it('最多检索两次，第三次直接返回错误', async () => {
    const { service, retrieval } = makeService();
    const { agent, writer, sources } = makeAgent(service, plan({}));
    const retrieve = toolNamed(agent.opts.tools, 'retrieve_knowledge');

    await retrieve.handler({ query: '第一次' });
    await retrieve.handler({ query: '第二次' });
    const third = (await retrieve.handler({ query: '第三次' })) as {
      error?: string;
      insufficient?: boolean;
    };

    expect(retrieval.search).toHaveBeenCalledTimes(2);
    expect(third.insufficient).toBe(true);
    expect(third.error).toContain('最多检索两次');
    expect(sources.map((s) => s.index)).toEqual([1, 2]);
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'data-eval' }),
    );
  });

  it('检索时透传 topK、mode、可见范围与用户问题', async () => {
    const { service, retrieval } = makeService();
    const { agent } = makeAgent(service, plan({}), '加班餐补怎么报');
    const retrieve = toolNamed(agent.opts.tools, 'retrieve_knowledge');

    await retrieve.handler({ query: '加班餐补', topK: 3 });

    expect(retrieval.search).toHaveBeenCalledWith(
      { query: '加班餐补', topK: 3, mode: 'hybrid' },
      expect.objectContaining({
        unrestricted: false,
        userId: '1001',
        teamIds: ['team-1'],
      }),
    );
  });

  it('检索失败时返回 insufficient 与错误文案', async () => {
    const { service, queryRewrite } = makeService({
      searchError: new Error('ES timeout'),
    });
    const { agent } = makeAgent(service, plan({}));
    const retrieve = toolNamed(agent.opts.tools, 'retrieve_knowledge');

    const result = (await retrieve.handler({ query: '问题' })) as {
      error?: string;
      insufficient?: boolean;
    };

    expect(result.insufficient).toBe(true);
    expect(result.error).toContain('ES timeout');
    expect(queryRewrite.gradeHits).not.toHaveBeenCalled();
  });

  it('不切题时不把命中内容交给模型，但保留原始命中给改写器', async () => {
    const { service, queryRewrite } = makeService({
      grade: GRADE_IRRELEVANT,
    });
    const { agent, sources } = makeAgent(service, plan({}));
    const retrieve = toolNamed(agent.opts.tools, 'retrieve_knowledge');

    const result = (await retrieve.handler({ query: '加班餐补' })) as {
      items: unknown[];
      context: string;
      insufficient?: boolean;
      eval: { ok: boolean };
    };
    const rewrite = toolNamed(agent.opts.tools, 'rewrite_query');
    await rewrite.handler({});

    expect(result.items).toEqual([]);
    expect(result.context).toBe('');
    expect(result.insufficient).toBe(true);
    expect(sources).toEqual([]);
    expect(queryRewrite.rewriteAfterRetrieve).toHaveBeenCalledWith(
      '问题',
      '加班餐补',
      GRADE_IRRELEVANT,
      [hit('a')],
    );
  });
});

describe('AiStreamService · rewrite_query / web_search', () => {
  beforeEach(() => {
    langchainMocks.tool.mockClear();
    langchainMocks.createAgent.mockClear();
    vi.clearAllMocks();
  });

  it('未检索前调用改写直接报错', async () => {
    const { service } = makeService();
    const { agent } = makeAgent(service, plan({}));
    const rewrite = toolNamed(agent.opts.tools, 'rewrite_query');

    const result = (await rewrite.handler({})) as { error?: string };
    expect(result.error).toContain('请先调用 retrieve_knowledge');
  });

  it('已切题时拒绝改写', async () => {
    const { service } = makeService();
    const { agent } = makeAgent(service, plan({}));
    const retrieve = toolNamed(agent.opts.tools, 'retrieve_knowledge');
    const rewrite = toolNamed(agent.opts.tools, 'rewrite_query');

    await retrieve.handler({ query: '问题' });
    const result = (await rewrite.handler({})) as { error?: string };

    expect(result.error).toContain('无需改写');
  });

  it('不足后改写返回新词与上次词', async () => {
    const { service } = makeService({ grade: GRADE_IRRELEVANT });
    const { agent } = makeAgent(service, plan({}));
    const retrieve = toolNamed(agent.opts.tools, 'retrieve_knowledge');
    const rewrite = toolNamed(agent.opts.tools, 'rewrite_query');

    await retrieve.handler({ query: '旧词' });
    const result = (await rewrite.handler({ focus: '餐补' })) as {
      query: string;
      previousQuery: string;
      focus?: string;
    };

    expect(result.query).toBe('新检索词');
    expect(result.previousQuery).toBe('旧词');
    expect(result.focus).toBe('餐补');
  });

  it('web_search 工具透传查询与条数', async () => {
    const { service, webSearch } = makeService();
    const { agent } = makeAgent(
      service,
      plan({
        intent: 'web',
        label: '联网搜索',
        allowRetrieve: false,
        allowWeb: true,
      }),
    );
    const web = toolNamed(agent.opts.tools, 'web_search');

    await web.handler({ query: '汇率', count: 3 });
    expect(webSearch.search).toHaveBeenCalledWith('汇率', 3);
  });
});

describe('systemForPlan', () => {
  it('知识库提示词要求最多两次、禁止编造且不得联网', () => {
    const prompt = systemForPlan(
      plan({ intent: 'kb', label: '知识库', allowWeb: false }),
    );
    expect(prompt).toContain('retrieve_knowledge');
    expect(prompt).toContain('rewrite_query');
    expect(prompt).toContain('最多两次');
    expect(prompt).toContain('禁止编造');
    expect(prompt).toContain('不要调用 web_search');
  });

  it('先库后网提示词要求走完知识库循环再联网', () => {
    const prompt = systemForPlan(
      plan({
        intent: 'kb_then_web',
        label: '知识库，不足则联网',
        allowWeb: true,
      }),
    );
    expect(prompt).toContain('先走完知识库循环');
    expect(prompt).toContain('web_search');
  });

  it('闲聊与偏好明确禁止调用工具', () => {
    expect(
      systemForPlan(
        plan({
          intent: 'chitchat',
          label: '闲聊',
          allowRetrieve: false,
          allowWeb: false,
        }),
      ),
    ).toContain('不要调用任何工具');
    expect(
      systemForPlan(
        plan({
          intent: 'profile',
          label: '个人偏好',
          allowRetrieve: false,
          allowWeb: false,
        }),
      ),
    ).toContain('不要检索知识库');
  });

  it('知识库提示词要求首轮并行调用两个检索工具，并限定图谱边界', () => {
    const prompt = systemForPlan(
      plan({
        graphQueries: ['发票', '报销'],
      }),
    );

    expect(prompt).toContain('并行调用 retrieve_knowledge 和 retrieve_graph');
    expect(prompt).toContain('图谱建议检索词「发票 / 报销」');
    expect(prompt).toContain('不能当制度原文');
    expect(prompt).toContain('图谱为空不要编造关系');
  });

  it('非知识库意图明确禁止调用图谱工具', () => {
    const prompt = systemForPlan(
      plan({
        intent: 'web',
        label: '联网搜索',
        allowRetrieve: false,
        allowGraph: false,
        allowWeb: true,
      }),
    );

    expect(prompt).toContain('不要调用 retrieve_graph');
  });
});

describe('packRetrieveResult', () => {
  it('多次检索累计编号，并写出来源事件', () => {
    const writer = { write: vi.fn() };
    const sources: ChatSource[] = [];

    const first = packRetrieveResult(
      [hit('a'), hit('b')],
      '第一次',
      sources,
      writer as never,
    );
    expect(first.items.map((item) => item.index)).toEqual([1, 2]);
    expect(first.context).toContain('[1] 文档 a');
    expect(first.context).toContain('[2] 文档 b');
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'data-sources' }),
    );
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'source-document' }),
    );

    const second = packRetrieveResult(
      [hit('c')],
      '第二次',
      sources,
      writer as never,
    );
    expect(second.items.map((item) => item.index)).toEqual([3]);
    expect(second.context).toContain('[3] 文档 c');
    expect(sources.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('空命中不写空的 data-sources 事件', () => {
    const writer = { write: vi.fn() };
    const sources: ChatSource[] = [];

    const result = packRetrieveResult([], '无结果', sources, writer as never);

    expect(result.items).toEqual([]);
    expect(result.context).toBe('');
    expect(writer.write).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'data-sources' }),
    );
  });
});
