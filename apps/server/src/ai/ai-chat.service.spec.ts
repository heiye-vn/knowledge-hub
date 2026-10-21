import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AiChatService } from './ai-chat.service.js';
import { RetrievalService } from '../rag/retrieval.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import type { SearchHit } from '../rag/types/rag.types.js';

// ChatOpenAI 由构造函数内部创建，直接 mock 整个模块，
// invoke 的返回值在各用例里通过 mockReturnValue 切换
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

const USER = { userId: '1001', username: 'user', roles: [], permissions: [], teamIds: [] };

/** 会话服务 fake：appendTurn 可按用例覆盖行为 */
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

/** 记忆与改写 fake：默认空历史、直检、无长期记忆命中 */
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
    rewrite: vi.fn(async (question: string) => ({
      query: question,
      needRetrieve: true,
    })),
  } as unknown as ChatQueryRewriteService;
  return { shortMemory, longMemory, queryRewrite };
}

function makeService(
  searchImpl: (params: { query: string; topK?: number }) => Promise<SearchHit[]>,
  sessionsImpl?: Parameters<typeof makeSessions>[0],
): AiChatService & {
  appendTurn: ReturnType<typeof vi.fn>;
  fakes: ReturnType<typeof makeMemoryFakes>;
  retrievalSearch: ReturnType<typeof vi.fn>;
} {
  const retrieval = {
    search: vi.fn(searchImpl),
  } as unknown as RetrievalService;
  const { sessions, appendTurn } = makeSessions(sessionsImpl);
  const fakes = makeMemoryFakes();
  const service = new AiChatService(
    {
      get: (k: string, d?: string) =>
        k === 'LLM_API_KEY' ? 'test-key' : d,
    } as unknown as ConfigService,
    retrieval,
    sessions,
    fakes.shortMemory,
    fakes.longMemory,
    fakes.queryRewrite,
  ) as AiChatService & {
    appendTurn: ReturnType<typeof vi.fn>;
    fakes: ReturnType<typeof makeMemoryFakes>;
    retrievalSearch: ReturnType<typeof vi.fn>;
  };
  service.appendTurn = appendTurn;
  service.fakes = fakes;
  service.retrievalSearch = retrieval.search as unknown as ReturnType<
    typeof vi.fn
  >;
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
    );

    const res = await service.chat('   ');
    expect(res.answer).toBe('请输入问题。');
    expect(res.sources).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('检索无命中返回固定话术，不调 LLM', async () => {
    const service = makeService(async () => []);
    const res = await service.chat('任意问题');
    expect(res.answer).toBe('知识库里没有相关内容。');
    expect(res.sources).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
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
    // [2] 与 [1] 被引用，[3] 未引用不返回
    expect(res.sources.map((s) => s.index)).toEqual([1, 2]);
    expect(res.sources[0].documentId).toBe('doc-a');
    expect(res.sources[1].documentId).toBe('doc-b');
    // 溯源条目是摘录不是整块正文
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
    service.fakes.queryRewrite.rewrite = vi.fn(async () => ({
      query: '差旅费超五千 加签 审批人',
      needRetrieve: true,
    })) as never;

    await service.chat('那这个找谁？', 5, USER, '8001');
    expect(service.retrievalSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '差旅费超五千 加签 审批人' }),
      expect.anything(),
    );
  });

  it('寒暄 needRetrieve=false 时跳过检索，仍正常生成回答', async () => {
    invokeMock.mockResolvedValue({ content: '不客气。' });
    const service = makeService(async () => []);
    service.fakes.queryRewrite.rewrite = vi.fn(async () => ({
      query: '好的谢谢',
      needRetrieve: false,
    })) as never;

    const res = await service.chat('好的谢谢', 5, USER, '8001');
    expect(service.retrievalSearch).not.toHaveBeenCalled();
    expect(res.answer).toBe('不客气。');
    expect(res.answer).not.toBe('知识库里没有相关内容。');
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
});
