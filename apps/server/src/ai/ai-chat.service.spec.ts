import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AiChatService } from './ai-chat.service.js';
import { RetrievalService } from '../rag/retrieval.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import { WebSearchService } from './web-search.service.js';
import type { GraphBuildService } from '../kg/graph-build.service.js';
import type { GraphChatHit } from '../kg/types/kg.types.js';
import type { SearchHit } from '../rag/types/rag.types.js';

const invokeMock = vi.fn();
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    invoke = invokeMock;
    constructor(_opts: unknown) {}
  },
}));
vi.mock('@langchain/core/messages', async () => ({
  ...(await vi.importActual('@langchain/core/messages')),
}));

function hit(id: string, score: number): SearchHit {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `文档 ${id}`,
    content: `内容 ${id}`,
    heading: null,
    chunkIndex: 0,
    totalChunks: 1,
    score,
    scores: { vector: null, keyword: score },
  };
}

const USER = {
  userId: '1001',
  username: 'user',
  roles: [],
  permissions: [],
  teamIds: [],
};

function kbPlan(query: string) {
  return {
    intent: 'kb' as const,
    label: '知识库',
    query,
    graphQueries: [] as string[],
    allowRetrieve: true,
    allowGraph: true,
    allowWeb: false,
  };
}

function makeSessions(
  appendTurn?: ChatSessionService['appendTurn'],
): { sessions: ChatSessionService; appendTurn: ReturnType<typeof vi.fn> } {
  const appendTurnFn =
    appendTurn ??
    (vi.fn(async () => ({
      id: '9001',
      userId: USER.userId,
      title: '问题',
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as unknown as ChatSessionService['appendTurn']);
  return {
    sessions: {
      appendTurn: appendTurnFn,
      listRecentMessages: vi.fn(async () => []),
    } as unknown as ChatSessionService,
    appendTurn: appendTurnFn as unknown as ReturnType<typeof vi.fn>,
  };
}

function makeMemoryFakes() {
  const shortMemory = {
    windowSize: 20,
    tryLoad: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    appendTurn: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } as unknown as ChatShortMemoryService;
  const longMemory = {
    search: vi.fn(async () => ({ user: [], session: [] })),
    buildSystemMessage: vi.fn(() => null),
    rememberTurn: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
  } as unknown as ChatLongMemoryService;
  const queryRewrite = {
    classify: vi.fn(async (question: string) => kbPlan(question)),
    gradeHits: vi.fn(async (_question: string, hits: SearchHit[]) =>
      hits.length
        ? { ok: true, reason: 'relevant', text: '资料切题' }
        : { ok: false, reason: 'empty', text: '未检索到资料' },
    ),
    rewriteAfterRetrieve: vi.fn(
      async (question: string, previousQuery: string) =>
        question === previousQuery ? '' : question,
    ),
  } as unknown as ChatQueryRewriteService;
  return { shortMemory, longMemory, queryRewrite };
}

function makeWebSearch() {
  const webSearch = {
    search: vi.fn(async (query: string) => ({
      query,
      items: [
        {
          title: `网页：${query}`,
          url: 'https://example.com/doc',
          snippet: '公开信息摘要',
        },
      ],
    })),
  } as unknown as WebSearchService;
  return webSearch;
}

function emptyGraphHit(query = ''): GraphChatHit {
  return { query, entities: [], relations: [], documents: [] };
}

function makeGraph() {
  return {
    retrieveForChat: vi.fn(async (keyword: string | string[]) => {
      const query = Array.isArray(keyword) ? keyword.join(' / ') : keyword;
      return emptyGraphHit(query);
    }),
  } as unknown as GraphBuildService;
}

function makeService(
  searchImpl: (params: { query: string; topK?: number }) => Promise<SearchHit[]>,
  sessionsImpl?: Parameters<typeof makeSessions>[0],
): AiChatService & {
  appendTurn: ReturnType<typeof vi.fn>;
  fakes: ReturnType<typeof makeMemoryFakes>;
  retrievalSearch: ReturnType<typeof vi.fn>;
  webSearchFake: WebSearchService;
  graphFake: GraphBuildService;
} {
  const retrieval = {
    search: vi.fn(searchImpl),
  } as unknown as RetrievalService;
  const { sessions, appendTurn } = makeSessions(sessionsImpl);
  const fakes = makeMemoryFakes();
  const webSearch = makeWebSearch();
  const graph = makeGraph();
  const service = new AiChatService(
    {
      get: (k: string, d?: string) => (k === 'LLM_API_KEY' ? 'test-key' : d),
    } as unknown as ConfigService,
    retrieval,
    sessions,
    fakes.shortMemory,
    fakes.longMemory,
    fakes.queryRewrite,
    webSearch,
    graph,
  ) as AiChatService & {
    appendTurn: ReturnType<typeof vi.fn>;
    fakes: ReturnType<typeof makeMemoryFakes>;
    retrievalSearch: ReturnType<typeof vi.fn>;
    webSearchFake: WebSearchService;
    graphFake: GraphBuildService;
  };
  service.appendTurn = appendTurn;
  service.fakes = fakes;
  service.retrievalSearch = retrieval.search as unknown as ReturnType<
    typeof vi.fn
  >;
  service.webSearchFake = webSearch;
  service.graphFake = graph;
  return service;
}

describe('AiChatService（mock 检索与 LLM）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('空问题返回固定话术，不调检索与 LLM', async () => {
    const search = vi.fn();
    const retrieval = { search } as unknown as RetrievalService;
    const { shortMemory, longMemory, queryRewrite } = makeMemoryFakes();
    const service = new AiChatService(
      {
        get: (k: string, d?: string) => (k === 'LLM_API_KEY' ? 'k' : d),
      } as unknown as ConfigService,
      retrieval,
      makeSessions().sessions,
      shortMemory,
      longMemory,
      queryRewrite,
      makeWebSearch(),
      makeGraph(),
    );

    const res = await service.chat('   ');
    expect(res.answer).toBe('请输入问题。');
    expect(res.sources).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('知识库检索无命中返回固定话术，不调 LLM', async () => {
    const service = makeService(async () => []);
    const res = await service.chat('任意问题');
    expect(res.answer).toBe('知识库里没有相关内容。');
    expect(res.sources).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(service.webSearchFake.search).not.toHaveBeenCalled();
  });

  it('知识库与图谱并行检索，图谱上下文进入 system 消息', async () => {
    invokeMock.mockResolvedValue({ content: '按报销流程 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      ...kbPlan('发票报销流程'),
      graphQueries: ['发票', '报销'],
    })) as never;
    (
      service.graphFake.retrieveForChat as unknown as {
        mockResolvedValueOnce: (value: GraphChatHit) => void;
      }
    ).mockResolvedValueOnce({
      query: '发票 / 报销',
      entities: [
        { name: '发票', type: 'CONCEPT', description: null },
        { name: '报销', type: 'PROCESS', description: null },
      ],
      relations: [{ source: '发票', relation: 'REQUIRES', target: '报销' }],
      documents: [{ documentId: 'doc-1', title: '差旅报销办法' }],
    });

    const res = await service.chat('发票怎么报销', 5, USER, '8001');

    expect(service.graphFake.retrieveForChat).toHaveBeenCalledWith(
      ['发票', '报销'],
      8,
      { unrestricted: false, userId: '1001', teamIds: [] },
    );
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    expect(
      messages.some((m) => String(m.content).includes('【本轮知识图谱】')),
    ).toBe(true);
    expect(res.answer).toBe('按报销流程 [1]。');
  });

  it('知识库不切题但图谱有命中时继续生成，不返回固定空话术', async () => {
    invokeMock.mockResolvedValue({ content: '图谱显示发票与报销相关。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      ...kbPlan('发票报销'),
      graphQueries: ['发票', '报销'],
    })) as never;
    (
      service.graphFake.retrieveForChat as unknown as {
        mockResolvedValueOnce: (value: GraphChatHit) => void;
      }
    ).mockResolvedValueOnce({
      query: '发票 / 报销',
      entities: [{ name: '发票', type: 'CONCEPT', description: null }],
      relations: [],
      documents: [],
    });

    const res = await service.chat('发票怎么报销', 5, USER, '8001');

    expect(res.answer).not.toBe('知识库里没有相关内容。');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('知识库不切题且图谱为空时仍返回固定空话术', async () => {
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      ...kbPlan('发票报销'),
      graphQueries: ['发票', '报销'],
    })) as never;

    const res = await service.chat('发票怎么报销', 5, USER, '8001');

    expect(res.answer).toBe('知识库里没有相关内容。');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('图谱查询失败不阻断非流式回答', async () => {
    invokeMock.mockResolvedValue({ content: '按知识库回答 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      ...kbPlan('发票报销'),
      graphQueries: ['发票', '报销'],
    })) as never;
    (
      service.graphFake.retrieveForChat as unknown as {
        mockRejectedValueOnce: (error: Error) => void;
      }
    ).mockRejectedValueOnce(new Error('neo4j down'));

    const res = await service.chat('发票怎么报销', 5, USER, '8001');

    expect(res.answer).toBe('按知识库回答 [1]。');
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    expect(
      messages.some((m) => String(m.content).includes('【本轮知识图谱】')),
    ).toBe(false);
  });

  it('纯联网意图不查图谱', async () => {
    invokeMock.mockResolvedValue({ content: '汇率 7.1。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      intent: 'web' as const,
      label: '联网搜索',
      query: '今天人民币兑美元汇率',
      graphQueries: ['汇率'],
      allowRetrieve: false,
      allowGraph: false,
      allowWeb: true,
    })) as never;

    await service.chat('今天人民币兑美元汇率', 5, USER, '8001');

    expect(service.graphFake.retrieveForChat).not.toHaveBeenCalled();
  });

  it('生成带 [n] 标注时只返回被引用的资料（按编号排序）', async () => {
    invokeMock.mockResolvedValue({
      content: '报销流程如下 [2]，另有规定 [1]。',
    });
    const service = makeService(async () => [
      hit('a', 0.9),
      hit('b', 0.8),
      hit('c', 0.7),
    ]);

    const res = await service.chat('报销流程');
    expect(res.sources.map((s) => s.index)).toEqual([1, 2]);
    expect(res.sources[0].documentId).toBe('doc-a');
    expect(res.sources[1].documentId).toBe('doc-b');
    expect(res.sources[0].excerpt).toBe('内容 a');
  });

  it('回答未标注 [n] 时回退为全部召回条目', async () => {
    invokeMock.mockResolvedValue({ content: '知识库中没有直接答案。' });
    const service = makeService(async () => [hit('a', 0.9), hit('b', 0.8)]);

    const res = await service.chat('问题');
    expect(res.sources.map((s) => s.index)).toEqual([1, 2]);
  });

  it('越界的 [n] 被忽略（防御编号超出资料范围）', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [9] 与 [1]。' });
    const service = makeService(async () => [hit('a', 0.9), hit('b', 0.8)]);

    const res = await service.chat('问题');
    expect(res.sources.map((s) => s.index)).toEqual([1]);
  });

  it('excerpt 超过 200 字截断并带省略号', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const longContent = '长'.repeat(300);
    const retrieval = {
      search: vi.fn().mockResolvedValue([
        { ...hit('a', 0.9), content: longContent },
      ]),
    } as unknown as RetrievalService;
    const { shortMemory, longMemory, queryRewrite } = makeMemoryFakes();
    const service = new AiChatService(
      {
        get: (k: string, d?: string) => (k === 'LLM_API_KEY' ? 'k' : d),
      } as unknown as ConfigService,
      retrieval,
      makeSessions().sessions,
      shortMemory,
      longMemory,
      queryRewrite,
      makeWebSearch(),
      makeGraph(),
    );

    const res = await service.chat('问题');
    expect(res.sources[0].excerpt.length).toBe(203);
    expect(res.sources[0].excerpt.endsWith('...')).toBe(true);
  });

  it('LLM content 非字符串时 JSON 序列化兜底', async () => {
    invokeMock.mockResolvedValue({ content: [{ text: '数组型 content' }] });
    const service = makeService(async () => [hit('a', 0.9)]);

    const res = await service.chat('问题');
    expect(typeof res.answer).toBe('string');
    expect(res.answer).toContain('数组型 content');
  });

  it('带用户且传 sessionId 时落库并回传原 sessionId（续聊）', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);

    const res = await service.chat('问题', 5, USER, '8001');
    expect(res.sessionId).toBe('9001');
    expect(service.appendTurn).toHaveBeenCalledWith(
      USER.userId,
      '8001',
      '问题',
      '结论 [1]。',
      expect.any(Array),
    );
  });

  it('带用户未传 sessionId 时新建会话，问题照原文落库', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);

    const res = await service.chat('  知识库是什么  ', 5, USER);
    expect(res.sessionId).toBe('9001');
    expect(service.appendTurn).toHaveBeenCalledWith(
      USER.userId,
      undefined,
      '知识库是什么',
      '结论 [1]。',
      expect.any(Array),
    );
  });

  it('不传用户时不落库（兼容未登录调用）', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);

    const res = await service.chat('问题');
    expect(res.sessionId).toBeNull();
    expect(service.appendTurn).not.toHaveBeenCalled();
  });

  it('落库失败不影响回答返回（尽力而为语义）', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)], async () => {
      throw new Error('db down');
    });

    const res = await service.chat('问题', 5, USER);
    expect(res.answer).toBe('结论 [1]。');
    expect(res.sessionId).toBeNull();
  });

  it('改写后的独立查询用于检索，而不是原问题', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);
    service.fakes.queryRewrite.classify = vi.fn(async () =>
      kbPlan('差旅费超五千 加签 审批人'),
    ) as never;

    await service.chat('那这个找谁？', 5, USER, '8001');
    expect(service.retrievalSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '差旅费超五千 加签 审批人' }),
      expect.anything(),
    );
  });

  it('闲聊意图不查知识库，仍正常生成回答', async () => {
    invokeMock.mockResolvedValue({ content: '不客气。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      intent: 'chitchat' as const,
      label: '闲聊',
      query: '好的谢谢',
      allowRetrieve: false,
      allowWeb: false,
    })) as never;

    const res = await service.chat('好的谢谢', 5, USER, '8001');
    expect(service.retrievalSearch).not.toHaveBeenCalled();
    expect(service.webSearchFake.search).not.toHaveBeenCalled();
    expect(res.answer).toBe('不客气。');
    expect(res.answer).not.toBe('知识库里没有相关内容。');
  });

  it('个人偏好意图不挂任何检索工具', async () => {
    invokeMock.mockResolvedValue({ content: '你在研发中心。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      intent: 'profile' as const,
      label: '个人偏好',
      query: '我是哪个部门',
      allowRetrieve: false,
      allowWeb: false,
    })) as never;

    await service.chat('我是哪个部门', 5, USER, '8001');
    expect(service.retrievalSearch).not.toHaveBeenCalled();
    expect(service.webSearchFake.search).not.toHaveBeenCalled();
  });

  it('纯联网意图不查库，直接联网并把结果放进上下文', async () => {
    invokeMock.mockResolvedValue({ content: '汇率 7.1 [网页]。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      intent: 'web' as const,
      label: '联网搜索',
      query: '今天人民币兑美元汇率',
      allowRetrieve: false,
      allowWeb: true,
    })) as never;

    await service.chat('今天人民币兑美元汇率', 5, USER, '8001');

    expect(service.retrievalSearch).not.toHaveBeenCalled();
    expect(service.webSearchFake.search).toHaveBeenCalledWith(
      '今天人民币兑美元汇率',
    );
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    expect(String(messages.at(-1)?.content)).toContain('联网结果');
    expect(String(messages.at(-1)?.content)).toContain('example.com');
  });

  it('知识库不足再联网意图：库空后走联网', async () => {
    invokeMock.mockResolvedValue({ content: '结合网页信息回答。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      intent: 'kb_then_web' as const,
      label: '知识库，不足则联网',
      query: '请假制度 国务院放假安排',
      allowRetrieve: true,
      allowWeb: true,
    })) as never;

    await service.chat('请假和法定假期什么关系？', 5, USER, '8001');

    expect(service.retrievalSearch).toHaveBeenCalled();
    expect(service.webSearchFake.search).toHaveBeenCalled();
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    expect(String(messages.at(-1)?.content)).toContain('联网结果');
  });

  it('知识库不足再联网意图：库切题时不联网', async () => {
    invokeMock.mockResolvedValue({ content: '按考勤制度 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);
    service.fakes.queryRewrite.classify = vi.fn(async () => ({
      intent: 'kb_then_web' as const,
      label: '知识库，不足则联网',
      query: '请假审批流程',
      allowRetrieve: true,
      allowWeb: true,
    })) as never;

    await service.chat('请假审批流程', 5, USER, '8001');

    expect(service.retrievalSearch).toHaveBeenCalledTimes(1);
    expect(service.webSearchFake.search).not.toHaveBeenCalled();
  });

  it('首轮不切题时改写并再查一次，使用同样的 mode', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const firstHit = hit('a', 0.6);
    const secondHit = hit('b', 0.9);
    const service = makeService(
      vi
        .fn()
        .mockResolvedValueOnce([firstHit])
        .mockResolvedValueOnce([secondHit]) as never,
    );
    service.fakes.queryRewrite.gradeHits = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'irrelevant', text: '词沾边' })
      .mockResolvedValueOnce({ ok: true, reason: 'relevant', text: '切题' }) as never;
    service.fakes.queryRewrite.rewriteAfterRetrieve = vi.fn(
      async () => '新检索词',
    ) as never;

    const res = await service.chat('加班餐补怎么报', 3, USER, '8001', 'keyword');

    expect(service.retrievalSearch).toHaveBeenNthCalledWith(
      1,
      { query: '加班餐补怎么报', topK: 3, mode: 'keyword' },
      expect.anything(),
    );
    expect(service.retrievalSearch).toHaveBeenNthCalledWith(
      2,
      { query: '新检索词', topK: 3, mode: 'keyword' },
      expect.anything(),
    );
    expect(res.answer).toBe('结论 [1]。');
  });

  it('长期记忆命中时作为系统消息注入上下文', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const { SystemMessage } = await import('@langchain/core/messages');
    const service = makeService(async () => [hit('a', 0.9)]);
    service.fakes.longMemory.search = vi.fn(async () => ({
      user: ['用户是成都研发中心后端'],
      session: [],
    })) as never;
    service.fakes.longMemory.buildSystemMessage = vi.fn(
      (hits: { user: string[] }) =>
        new SystemMessage(`【用户长期记忆】\n${hits.user.join('\n')}`),
    ) as never;

    await service.chat('问题', 5, USER, '8001');
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    expect(messages.some((m) => String(m.content).includes('【用户长期记忆】'))).toBe(
      true,
    );
  });

  it('检索无命中时也写短期窗口与长期记忆（空结果同样是一轮对话）', async () => {
    const service = makeService(async () => []);
    const res = await service.chat('问题', 5, USER, '8001');

    expect(res.answer).toBe('知识库里没有相关内容。');
    expect(service.fakes.shortMemory.appendTurn).toHaveBeenCalledWith(
      USER.userId,
      '9001',
      expect.any(Array),
      '问题',
      '知识库里没有相关内容。',
    );
    expect(service.fakes.longMemory.rememberTurn).toHaveBeenCalledWith(
      USER.userId,
      '9001',
      '问题',
      '知识库里没有相关内容。',
    );
  });

  it('正常回答后回写短期窗口并异步写长期记忆', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);

    await service.chat('问题', 5, USER, '8001');
    expect(service.fakes.shortMemory.appendTurn).toHaveBeenCalledWith(
      USER.userId,
      '9001',
      expect.any(Array),
      '问题',
      '结论 [1]。',
    );
    expect(service.fakes.longMemory.rememberTurn).toHaveBeenCalledWith(
      USER.userId,
      '9001',
      '问题',
      '结论 [1]。',
    );
  });

  it('mode 透传到检索服务', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);

    await service.chat('问题', 3, undefined, undefined, 'keyword');

    expect(service.retrievalSearch).toHaveBeenCalledWith(
      { query: '问题', topK: 3, mode: 'keyword' },
      undefined,
    );
  });

  it('includeEval 保留全轮次检索与改写痕迹，且不写任何持久化', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const firstHit = hit('a', 0.6);
    const secondHit = hit('b', 0.9);
    const service = makeService(
      vi
        .fn()
        .mockResolvedValueOnce([firstHit])
        .mockResolvedValueOnce([secondHit]) as never,
    );
    service.fakes.queryRewrite.gradeHits = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'irrelevant', text: '词沾边' })
      .mockResolvedValueOnce({ ok: true, reason: 'relevant', text: '切题' }) as never;
    service.fakes.queryRewrite.rewriteAfterRetrieve = vi.fn(
      async () => '新检索词',
    ) as never;

    const res = await service.chat(
      '加班餐补怎么报',
      3,
      USER,
      '8001',
      'keyword',
      { persist: false, includeEval: true },
    );

    expect(service.retrievalSearch).toHaveBeenNthCalledWith(
      1,
      { query: '加班餐补怎么报', topK: 3, mode: 'keyword' },
      expect.anything(),
    );
    expect(service.retrievalSearch).toHaveBeenNthCalledWith(
      2,
      { query: '新检索词', topK: 3, mode: 'keyword' },
      expect.anything(),
    );
    expect(res.eval?.attempts).toHaveLength(2);
    expect(res.eval?.attempts[0].rawHits.map((item) => item.documentId)).toEqual([
      'doc-a',
    ]);
    expect(res.eval?.attempts[1].rawHits.map((item) => item.documentId)).toEqual([
      'doc-b',
    ]);
    expect(res.eval?.attempts[1].gradedHits).toHaveLength(1);
    expect(res.eval?.rewrites).toEqual([
      { previousQuery: '加班餐补怎么报', query: '新检索词' },
    ]);
    expect(service.appendTurn).not.toHaveBeenCalled();
    expect(service.fakes.shortMemory.appendTurn).not.toHaveBeenCalled();
    expect(service.fakes.longMemory.rememberTurn).not.toHaveBeenCalled();
  });

  it('库空路径在 persist=false 时同样不写会话与记忆', async () => {
    const service = makeService(async () => []);

    const res = await service.chat(
      '任意问题',
      5,
      USER,
      undefined,
      undefined,
      { persist: false, includeEval: true },
    );

    expect(res.answer).toBe('知识库里没有相关内容。');
    expect(res.eval?.attempts).toHaveLength(1);
    expect(res.eval?.attempts[0].rawHits).toEqual([]);
    expect(service.appendTurn).not.toHaveBeenCalled();
    expect(service.fakes.shortMemory.appendTurn).not.toHaveBeenCalled();
    expect(service.fakes.longMemory.rememberTurn).not.toHaveBeenCalled();
  });

  it('默认响应不暴露 eval 快照', async () => {
    invokeMock.mockResolvedValue({ content: '结论 [1]。' });
    const service = makeService(async () => [hit('a', 0.9)]);

    const res = await service.chat('问题');
    expect(res.eval).toBeUndefined();
  });
});
