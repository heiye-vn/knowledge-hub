import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatQueryRewriteService } from './chat-query-rewrite.service.js';

const invokeMock = vi.fn();
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    withStructuredOutput() {
      return { invoke: invokeMock };
    }
    constructor(_opts: unknown) {}
  },
}));

function makeConfig(withKey = true) {
  return {
    get: (key: string, fallback?: unknown) => {
      if (key === 'LLM_API_KEY') return withKey ? 'test-key' : '';
      return fallback;
    },
  } as unknown as ConfigService;
}

const HISTORY = [new HumanMessage('出差加签谁批？'), new AIMessage('总监。')];

describe('ChatQueryRewriteService（mock LLM）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('未配置 LLM Key 时回退原问题，不调用改写器', async () => {
    const service = new ChatQueryRewriteService(makeConfig(false));
    const plan = await service.rewrite('那这个找谁？', HISTORY);
    expect(plan).toEqual({ query: '那这个找谁？', needRetrieve: true });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('无历史时回退原问题（首问不需要改写）', async () => {
    const service = new ChatQueryRewriteService(makeConfig());
    const plan = await service.rewrite('报销流程是什么？', []);
    expect(plan).toEqual({ query: '报销流程是什么？', needRetrieve: true });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('改写成功时返回独立短查询与检索意图', async () => {
    invokeMock.mockResolvedValue({
      standalone_query: '出差费用超五千 加签 审批人',
      need_retrieve: true,
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.rewrite('那这个找谁？', HISTORY);
    expect(plan).toEqual({
      query: '出差费用超五千 加签 审批人',
      needRetrieve: true,
    });
  });

  it('寒暄时 needRetrieve=false，query 仍给原问题', async () => {
    invokeMock.mockResolvedValue({
      standalone_query: '好的谢谢',
      need_retrieve: false,
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.rewrite('好的谢谢', HISTORY);
    expect(plan).toEqual({ query: '好的谢谢', needRetrieve: false });
  });

  it('改写抛错时回退原问题（不阻断问答）', async () => {
    invokeMock.mockRejectedValue(new Error('llm timeout'));
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.rewrite('那这个找谁？', HISTORY);
    expect(plan).toEqual({ query: '那这个找谁？', needRetrieve: true });
  });

  it('改写结果为空串时回退原问题', async () => {
    invokeMock.mockResolvedValue({ standalone_query: '   ', need_retrieve: true });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.rewrite('原问题', HISTORY);
    expect(plan.query).toBe('原问题');
  });
});
