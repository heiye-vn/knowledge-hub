import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AiChatService } from './ai-chat.service.js';
import { RetrievalService } from '../rag/retrieval.service.js';
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

function makeService(
  searchImpl: (params: { query: string; topK?: number }) => Promise<SearchHit[]>,
): AiChatService {
  const retrieval = {
    search: vi.fn(searchImpl),
  } as unknown as RetrievalService;
  return new AiChatService(
    {
      get: (k: string, d?: string) =>
        k === 'LLM_API_KEY' ? 'test-key' : d,
    } as unknown as ConfigService,
    retrieval,
  );
}

describe('AiChatService（mock 检索与 LLM）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('空问题返回固定话术，不调检索与 LLM', async () => {
    const search = vi.fn();
    const retrieval = { search } as unknown as RetrievalService;
    const service = new AiChatService(
      {
        get: (k: string, d?: string) => (k === 'LLM_API_KEY' ? 'k' : d),
      } as unknown as ConfigService,
      retrieval,
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
    const service = new AiChatService(
      {
        get: (k: string, d?: string) => (k === 'LLM_API_KEY' ? 'k' : d),
      } as unknown as ConfigService,
      retrieval,
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
});
