import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatHistoryCompressor } from './chat-history-compressor.service.js';

const invokeMock = vi.fn();
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    invoke = invokeMock;
    constructor(_opts: unknown) {}
  },
}));

function makeConfig(values: Record<string, unknown> = {}, withKey = true) {
  return {
    get: (key: string, fallback?: unknown) => {
      if (key in values) return values[key];
      if (key === 'LLM_API_KEY') return withKey ? 'test-key' : '';
      return fallback;
    },
  } as unknown as ConfigService;
}

function makeHistory(count: number) {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? new HumanMessage(`问${index}`)
      : new AIMessage(`答${index}`),
  );
}

describe('ChatHistoryCompressor（历史上下文压缩）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('未超过 trigger 条时不调模型，原样返回', async () => {
    const service = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 12,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 6,
      }),
    );
    const history = makeHistory(12);
    expect(await service.maybeCompress(history)).toBe(history);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('超过 trigger 时折叠较早消息，保留最近 keep 条原文', async () => {
    invokeMock.mockResolvedValue({ content: '  已确认差旅住宿上限 600 元  ' });
    const service = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 12,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 6,
      }),
    );
    const history = makeHistory(14);

    const out = await service.maybeCompress(history);
    expect(out).toHaveLength(7);
    expect(SystemMessage.isInstance(out[0])).toBe(true);
    expect(String(out[0].content)).toContain('【历史对话摘要】');
    expect(String(out[0].content)).toContain('已确认差旅住宿上限 600 元');
    expect(out.slice(1).map((m) => m.content)).toEqual([
      '问8',
      '答9',
      '问10',
      '答11',
      '问12',
      '答13',
    ]);
  });

  it('压缩失败退回原始窗口（上下文变长可接受，问答失败不可接受）', async () => {
    invokeMock.mockRejectedValue(new Error('llm timeout'));
    const service = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 4,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 2,
      }),
    );
    const history = makeHistory(6);
    expect(await service.maybeCompress(history)).toBe(history);
  });

  it('摘要返回空内容时退回原始窗口', async () => {
    invokeMock.mockResolvedValue({ content: '   ' });
    const service = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 4,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 2,
      }),
    );
    const history = makeHistory(6);
    expect(await service.maybeCompress(history)).toBe(history);
  });

  it('关闭开关或缺 LLM Key 时不压缩', async () => {
    const disabled = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_ENABLED: 'false',
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 2,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 1,
      }),
    );
    const history = makeHistory(6);
    expect(await disabled.maybeCompress(history)).toBe(history);

    const noKey = new ChatHistoryCompressor(
      makeConfig({ CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 2 }, false),
    );
    expect(await noKey.maybeCompress(history)).toBe(history);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('摘要输入从最近往前累加，超长时丢弃更早的消息', async () => {
    invokeMock.mockResolvedValue({ content: '摘要' });
    const service = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 2,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 1,
      }),
    );
    // 每条截断到 800 字（≈2400 字节），6000 字节只能容纳最近两条
    const history = [
      new HumanMessage(`最早${'甲'.repeat(3000)}`),
      new HumanMessage(`第二${'丙'.repeat(3000)}`),
      new HumanMessage(`中间${'乙'.repeat(3000)}`),
      new HumanMessage(`第四${'丁'.repeat(3000)}`),
      new HumanMessage('最新'),
    ];
    await service.maybeCompress(history);

    const rendered = String(invokeMock.mock.calls[0][0][1].content);
    expect(rendered).toContain('第四');
    expect(rendered).toContain('中间');
    expect(rendered).not.toContain('最早');
    expect(rendered).not.toContain('第二');
  });

  it('触发阈值与保留条数对外暴露，供流式 middleware 复用', () => {
    const service = new ChatHistoryCompressor(
      makeConfig({
        CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES: 16,
        CHAT_HISTORY_SUMMARY_KEEP_MESSAGES: 8,
      }),
    );
    expect(service.trigger).toEqual({ messages: 16 });
    expect(service.keep).toEqual({ messages: 8 });
  });
});
