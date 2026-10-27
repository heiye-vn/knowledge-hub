import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AiStreamService } from './ai-stream.service.js';
import type { ChatRoutePlan } from './chat-query-rewrite.service.js';
import type { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import type { RetrievalService } from '../rag/retrieval.service.js';
import type { WebSearchService } from './web-search.service.js';
import type { ChatSessionService } from './chat-session.service.js';
import type { ChatShortMemoryService } from './chat-short-memory.service.js';
import type { ChatLongMemoryService } from './chat-long-memory.service.js';
import type { GraphBuildService } from '../kg/graph-build.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import type { SearchHit } from '../rag/types/rag.types.js';

const mocks = vi.hoisted(() => ({
  agentInvoke: vi.fn(),
  lastAgent: undefined as
    | {
        opts: {
          tools: Array<{
            name: string;
            handler: (input: Record<string, unknown>) => unknown;
          }>;
        };
      }
    | undefined,
  callbackCtor: vi.fn(),
  langfuseEnabled: false,
}));

vi.mock('langchain', () => ({
  tool: vi.fn((handler: unknown, config: Record<string, unknown>) => ({
    handler,
    ...config,
  })),
  createAgent: vi.fn((opts: unknown) => {
    const agent = {
      opts: opts as {
        tools: Array<{
          name: string;
          handler: (input: Record<string, unknown>) => unknown;
        }>;
      },
      invoke: mocks.agentInvoke,
    };
    mocks.lastAgent = agent;
    return agent;
  }),
  modelCallLimitMiddleware: vi.fn(() => 'model-limit'),
  summarizationMiddleware: vi.fn(() => 'summarization'),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@langfuse/langchain', () => ({
  CallbackHandler: class {
    constructor(options: unknown) {
      mocks.callbackCtor(options);
    }
  },
}));

vi.mock('../observability/langfuse.js', () => ({
  createLangfuseCallbackHandler: (attrs: unknown) => {
    if (!mocks.langfuseEnabled) return undefined;
    mocks.callbackCtor(attrs);
    return { fake: true };
  },
  withTraceAttrs: (_attrs: unknown, run: () => Promise<unknown>) => run(),
  withObservation: (
    _name: string,
    run: (update: () => void) => Promise<unknown>,
  ) => run(() => undefined),
}));

const USER = {
  userId: '1001',
  username: 'user',
  roles: [],
  permissions: [],
  teamIds: ['team-1'],
} as AuthUser;

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

function kbPlan(): ChatRoutePlan {
  return {
    intent: 'kb',
    label: '知识库',
    query: '首轮词',
    graphQueries: ['发票'],
    allowRetrieve: true,
    allowGraph: true,
    allowWeb: false,
  };
}

function makeService(withKey = true) {
  const retrieval = {
    search: vi
      .fn()
      .mockResolvedValueOnce([hit('first')])
      .mockResolvedValueOnce([hit('second')]),
  } as unknown as RetrievalService;
  const queryRewrite = {
    classify: vi.fn(async () => kbPlan()),
    gradeHits: vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'irrelevant', text: '不切题' })
      .mockResolvedValueOnce({ ok: true, reason: 'relevant', text: '切题' }),
    rewriteAfterRetrieve: vi.fn(async () => '改写词'),
  } as unknown as ChatQueryRewriteService;
  const sessions = {
    create: vi.fn(),
    appendTurn: vi.fn(),
    touchTitle: vi.fn(),
    listRecentMessages: vi.fn(),
  } as unknown as ChatSessionService;
  const shortMemory = {
    appendTurn: vi.fn(),
    tryLoad: vi.fn(),
    save: vi.fn(),
    windowSize: 20,
  } as unknown as ChatShortMemoryService;
  const longMemory = {
    search: vi.fn(),
    buildSystemMessage: vi.fn(() => null),
    rememberTurn: vi.fn(),
  } as unknown as ChatLongMemoryService;
  const webSearch = { search: vi.fn() } as unknown as WebSearchService;
  const graph = {
    retrieveForChat: vi.fn(async () => ({
      query: '发票',
      entities: [{ name: '发票', type: 'CONCEPT', description: null }],
      relations: [],
      documents: [],
    })),
  } as unknown as GraphBuildService;

  const service = new AiStreamService(
    {
      get: (key: string, fallback?: string) =>
        key === 'LLM_API_KEY' && withKey ? 'test-key' : fallback,
    } as unknown as ConfigService,
    retrieval,
    sessions,
    webSearch,
    shortMemory,
    longMemory,
    queryRewrite,
    graph,
  );
  return {
    service,
    retrieval,
    queryRewrite,
    sessions,
    shortMemory,
    longMemory,
    graph,
  };
}

describe('AiStreamService.runForEval', () => {
  beforeEach(() => {
    mocks.agentInvoke.mockReset();
    mocks.callbackCtor.mockReset();
    mocks.lastAgent = undefined;
    mocks.langfuseEnabled = false;
  });

  it('复用真实 Agent，保留全轮次检索、改写和图谱状态，且不写持久化', async () => {
    const fake = makeService();
    mocks.agentInvoke.mockImplementation(async () => {
      const tools = mocks.lastAgent!.opts.tools;
      const retrieve = tools.find((item) => item.name === 'retrieve_knowledge')!;
      const rewrite = tools.find((item) => item.name === 'rewrite_query')!;
      const graphTool = tools.find((item) => item.name === 'retrieve_graph')!;

      await retrieve.handler({ query: '首轮词' });
      const rewritten = (await rewrite.handler({})) as { query: string };
      await retrieve.handler({ query: rewritten.query });
      await graphTool.handler({ query: '发票' });
      return {
        messages: [{ type: 'ai', content: '最终回答 [1]' }],
      };
    });

    const snapshot = await fake.service.runForEval('用户问题', 5, USER);

    expect(mocks.lastAgent?.opts.tools.map((item) => item.name)).toEqual([
      'retrieve_knowledge',
      'rewrite_query',
      'retrieve_graph',
    ]);
    expect(snapshot.answer).toBe('最终回答 [1]');
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.attempts[0].query).toBe('首轮词');
    expect(snapshot.attempts[0].rawHits[0].documentId).toBe('doc-first');
    expect(snapshot.attempts[0].gradedHits).toEqual([]);
    expect(snapshot.attempts[1].query).toBe('改写词');
    expect(snapshot.attempts[1].gradedHits).toHaveLength(1);
    expect(snapshot.rewrites).toEqual([
      { previousQuery: '首轮词', query: '改写词' },
    ]);
    expect(snapshot.graphRuns).toEqual([{ success: true, useful: true }]);
    expect(snapshot.retrieveCount).toBe(2);
    expect(fake.retrieval.search).toHaveBeenCalledWith(
      { query: '首轮词', topK: 5, mode: 'hybrid' },
      expect.objectContaining({ userId: '1001', unrestricted: false }),
    );
    expect(fake.sessions.create).not.toHaveBeenCalled();
    expect(fake.sessions.appendTurn).not.toHaveBeenCalled();
    expect(fake.shortMemory.appendTurn).not.toHaveBeenCalled();
    expect(fake.longMemory.search).not.toHaveBeenCalled();
    expect(fake.longMemory.rememberTurn).not.toHaveBeenCalled();
    expect(mocks.agentInvoke.mock.calls[0][1]).toBeUndefined();
  });

  it('配置 LangFuse 时给 Agent 注入回调，用户只传哈希值', async () => {
    mocks.langfuseEnabled = true;
    const fake = makeService();
    mocks.agentInvoke.mockResolvedValue({
      messages: [{ type: 'ai', content: '回答' }],
    });

    await fake.service.runForEval('问题', 5, USER);

    expect(mocks.callbackCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '1001',
        tags: ['agentic-rag', 'eval', 'kb'],
      }),
    );
    expect(mocks.agentInvoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callbacks: [expect.anything()] }),
    );
  });

  it('未配置 LLM 时返回空快照，不创建 Agent', async () => {
    const fake = makeService(false);

    const snapshot = await fake.service.runForEval('问题', 5, USER);

    expect(snapshot.answer).toContain('未配置 LLM Key');
    expect(snapshot.attempts).toEqual([]);
    expect(snapshot.graphRuns).toEqual([]);
    expect(mocks.lastAgent).toBeUndefined();
  });
});
