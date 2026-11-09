import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  compactRewriteContext,
  dbRowsToMessages,
  fitMessagesToBudget,
  isWorkingMessage,
  messageText,
} from './chat-memory.util.js';

describe('chat-memory.util（工作窗口与改写上下文）', () => {
  it('isWorkingMessage 只认 user / assistant，系统与工具消息都不进窗口', () => {
    expect(isWorkingMessage(new HumanMessage('问'))).toBe(true);
    expect(isWorkingMessage(new AIMessage('答'))).toBe(true);
    expect(isWorkingMessage(new SystemMessage('系统'))).toBe(false);
  });

  it('messageText 兼容字符串与多段 content', () => {
    expect(messageText(new HumanMessage('  文本  '))).toBe('文本');
    expect(
      messageText(
        new AIMessage({
          content: [
            { type: 'text', text: '第一段' },
            { type: 'text', text: '第二段' },
          ],
        } as never),
      ),
    ).toBe('第一段第二段');
  });

  it('dbRowsToMessages 跳过空内容并按 role 还原消息', () => {
    const messages = dbRowsToMessages([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: '答' },
    ] as never);
    expect(messages).toHaveLength(2);
    expect(HumanMessage.isInstance(messages[0])).toBe(true);
    expect(AIMessage.isInstance(messages[1])).toBe(true);
  });

  it('compactRewriteContext 只取最近 4 条，助手内容截 120 字', () => {
    const history = [
      new HumanMessage('最早的问题'),
      new HumanMessage('很早的问题'),
      new AIMessage('很早的回答'),
      new HumanMessage('上一问'),
      new AIMessage('长'.repeat(200)),
    ];
    const context = compactRewriteContext(history);
    // 超过 4 条时丢弃最早的
    expect(context).not.toContain('最早的问题');
    expect(context).toContain('用户：上一问');
    expect(context).toContain(`助手：${'长'.repeat(120)}`);
    expect(context).not.toContain('长'.repeat(121));
  });

  it('空历史返回空上下文（改写器据此回退原问题）', () => {
    expect(compactRewriteContext([])).toBe('');
  });
});

describe('fitMessagesToBudget（token 预算闸）', () => {
  /** 每条 10 个汉字 = 30 个 UTF-8 字节（估算单位与检索侧一致） */
  const chunk = '字'.repeat(10);
  const makeFour = () => [
    new HumanMessage(`一${chunk}`),
    new AIMessage(`二${chunk}`),
    new HumanMessage(`三${chunk}`),
    new AIMessage(`四${chunk}`),
  ];

  it('预算充足时原样返回', () => {
    const messages = makeFour();
    expect(fitMessagesToBudget(messages, 1000)).toHaveLength(4);
  });

  it('超预算时从最早一条开始丢弃，保留时间上连续的尾部', () => {
    const messages = makeFour();
    // 每条 33 字节，预算 100 → 只能容纳最近 3 条
    const kept = fitMessagesToBudget(messages, 100);
    expect(kept).toHaveLength(3);
    expect(kept.map((m) => m.content)).toEqual([
      messages[1].content,
      messages[2].content,
      messages[3].content,
    ]);
  });

  it('最后一条即使单条超预算也必须保留（本轮问题不能丢）', () => {
    const messages = [new HumanMessage('旧问'), new AIMessage(`${'长'.repeat(500)}`)];
    const kept = fitMessagesToBudget(messages, 10);
    expect(kept).toHaveLength(1);
    expect(kept[0].content).toBe(messages[1].content);
  });

  it('空数组与非正预算的边界', () => {
    expect(fitMessagesToBudget([], 100)).toEqual([]);
    const single = [new HumanMessage('唯一一条')];
    expect(fitMessagesToBudget(single, 100)).toEqual(single);
    expect(fitMessagesToBudget(single, 0)).toEqual(single);
    expect(fitMessagesToBudget(single, Number.NaN)).toEqual(single);
  });
});
