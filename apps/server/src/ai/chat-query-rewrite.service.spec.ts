import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import type { SearchHit } from '../rag/types/rag.types.js';

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

const HISTORY = [new HumanMessage('出差加签谁批？'), new AIMessage('总监。')];

describe('ChatQueryRewriteService · classify（意图路由）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('首轮无历史也调用路由，闲聊不挂检索工具', async () => {
    invokeMock.mockResolvedValue({
      intent: 'chitchat',
      standalone_query: '你好',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('你好', []);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(plan).toEqual({
      intent: 'chitchat',
      label: '闲聊',
      query: '你好',
      graphQueries: [],
      allowRetrieve: false,
      allowGraph: false,
      allowWeb: false,
    });
  });

  it('知识库意图只挂检索，不挂联网', async () => {
    invokeMock.mockResolvedValue({
      intent: 'kb',
      standalone_query: '出差费用超五千 加签 审批人',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('那这个找谁？', HISTORY);

    expect(plan).toMatchObject({
      intent: 'kb',
      label: '知识库',
      allowRetrieve: true,
      allowWeb: false,
    });
  });

  it('知识库不足再联网意图两套工具都挂', async () => {
    invokeMock.mockResolvedValue({
      intent: 'kb_then_web',
      standalone_query: '请假制度 国务院放假安排',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('请假和法定假期什么关系？', HISTORY);

    expect(plan).toMatchObject({
      intent: 'kb_then_web',
      label: '知识库，不足则联网',
      allowRetrieve: true,
      allowWeb: true,
    });
  });

  it('纯联网意图不挂知识库检索', async () => {
    invokeMock.mockResolvedValue({
      intent: 'web',
      standalone_query: '今天人民币兑美元汇率',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('今天人民币兑美元汇率', HISTORY);

    expect(plan).toMatchObject({
      intent: 'web',
      allowRetrieve: false,
      allowWeb: true,
    });
  });

  it('个人偏好不挂任何检索工具', async () => {
    invokeMock.mockResolvedValue({
      intent: 'profile',
      standalone_query: '我是哪个部门',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('我是哪个部门', HISTORY);

    expect(plan).toMatchObject({
      intent: 'profile',
      allowRetrieve: false,
      allowWeb: false,
    });
  });

  it('路由失败时兜底知识库，并用原问题检索', async () => {
    invokeMock.mockRejectedValue(new Error('llm timeout'));
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('预算审核员属于哪个部门', HISTORY);

    expect(plan).toEqual({
      intent: 'kb',
      label: '知识库',
      query: '预算审核员属于哪个部门',
      graphQueries: [],
      allowRetrieve: true,
      allowGraph: true,
      allowWeb: false,
    });
  });

  it('standalone_query 为空时回退原问题', async () => {
    invokeMock.mockResolvedValue({ intent: 'kb', standalone_query: '   ' });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('原问题', HISTORY);

    expect(plan.query).toBe('原问题');
  });

  it('未配置 LLM Key 时按知识库兜底，不调用模型', async () => {
    const service = new ChatQueryRewriteService(makeConfig(false));

    const plan = await service.classify('你好', HISTORY);

    expect(plan).toMatchObject({
      intent: 'kb',
      allowRetrieve: true,
      allowWeb: false,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('知识库意图保留去空白后的图谱短词', async () => {
    invokeMock.mockResolvedValue({
      intent: 'kb',
      standalone_query: '发票报销流程',
      graph_queries: [' 发票 ', '', '报销'],
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('发票怎么报销', HISTORY);

    expect(plan.graphQueries).toEqual(['发票', '报销']);
    expect(plan.allowGraph).toBe(true);
  });

  it('知识库意图未给图谱词时为空数组，但保留图谱工具开关', async () => {
    invokeMock.mockResolvedValue({
      intent: 'kb',
      standalone_query: '发票报销流程',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('发票怎么报销', HISTORY);

    expect(plan.graphQueries).toEqual([]);
    expect(plan.allowGraph).toBe(true);
  });

  it('kb_then_web 同时允许知识库、图谱与联网', async () => {
    invokeMock.mockResolvedValue({
      intent: 'kb_then_web',
      standalone_query: '差旅报销 政策',
      graph_queries: ['差旅', '报销'],
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('差旅报销有什么新政策', HISTORY);

    expect(plan.allowRetrieve).toBe(true);
    expect(plan.allowGraph).toBe(true);
    expect(plan.allowWeb).toBe(true);
    expect(plan.graphQueries).toEqual(['差旅', '报销']);
  });

  it('非知识库意图即使模型给了图谱词也强制清空', async () => {
    invokeMock.mockResolvedValue({
      intent: 'web',
      standalone_query: '今天汇率',
      graph_queries: ['汇率'],
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const plan = await service.classify('今天汇率', HISTORY);

    expect(plan.allowGraph).toBe(false);
    expect(plan.graphQueries).toEqual([]);
  });
});

describe('ChatQueryRewriteService · gradeHits（切题评估）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('空结果直接判 empty，不调用模型', async () => {
    const service = new ChatQueryRewriteService(makeConfig());

    const grade = await service.gradeHits('问题', []);

    expect(grade).toEqual({
      ok: false,
      reason: 'empty',
      text: '未检索到资料',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('grades the original top five using whole evidence and preserves skipped indexes', async () => {
    invokeMock.mockResolvedValue({ relevant: true, reason: 'late evidence' });
    const service = new ChatQueryRewriteService(makeConfig());
    const content = 'background '.repeat(85) + '\n| Rule |\n| --- |\n| LATE_EVIDENCE |\n\n$$E = mc^2$$';
    await service.gradeHits('question', [
      { ...hit('huge'), content: 'x'.repeat(7000) },
      { ...hit('late'), content },
      hit('c'), hit('d'), hit('e'), hit('excluded'),
    ]);
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    const prompt = String(messages[1].content);
    expect(prompt).toContain('2. 文档 late');
    expect(prompt).toContain(content);
    expect(prompt).toContain('5. 文档 e');
    expect(prompt).not.toContain('文档 huge');
    expect(prompt).not.toContain('文档 excluded');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(6200);
  });

  it('模型判定切题时返回 relevant', async () => {
    invokeMock.mockResolvedValue({
      relevant: true,
      reason: '同一制度，可支撑作答',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const grade = await service.gradeHits('问题', [hit('a')]);

    expect(grade).toEqual({
      ok: true,
      reason: 'relevant',
      text: '同一制度，可支撑作答',
    });
  });

  it('模型判定不切题时返回 irrelevant', async () => {
    invokeMock.mockResolvedValue({
      relevant: false,
      reason: '只是词沾边',
    });
    const service = new ChatQueryRewriteService(makeConfig());

    const grade = await service.gradeHits('问题', [hit('a')]);

    expect(grade).toEqual({
      ok: false,
      reason: 'irrelevant',
      text: '只是词沾边',
    });
  });

  it('评估调用失败时按有召回放行，避免误杀', async () => {
    invokeMock.mockRejectedValue(new Error('timeout'));
    const service = new ChatQueryRewriteService(makeConfig());

    const grade = await service.gradeHits('问题', [hit('a')]);

    expect(grade.ok).toBe(true);
    expect(grade.reason).toBe('relevant');
    expect(grade.text).toContain('评估失败');
  });
});

describe('ChatQueryRewriteService · rewriteAfterRetrieve（不足后改写）', () => {
  const GRADE = { ok: false, reason: 'irrelevant' as const, text: '只是词沾边' };

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('uses only the original top three with complete late evidence for rewriting', async () => {
    invokeMock.mockResolvedValue({ query: 'new query' });
    const service = new ChatQueryRewriteService(makeConfig());
    const content = 'background '.repeat(85) + '\n```ts\nconst late = 42;\n```';
    await service.rewriteAfterRetrieve('question', 'old', GRADE, [
      { ...hit('huge'), content: 'x'.repeat(7000) },
      { ...hit('late'), content },
      hit('third'), hit('excluded'),
    ]);
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    const prompt = String(messages[1].content);
    expect(prompt).toContain('2. 文档 late');
    expect(prompt).toContain(content);
    expect(prompt).toContain('3. 文档 third');
    expect(prompt).not.toContain('文档 huge');
    expect(prompt).not.toContain('文档 excluded');
  });

  it('根据上次词与不足原因生成新检索词', async () => {
    invokeMock.mockResolvedValue({ query: '差旅 报销 餐补 标准' });
    const service = new ChatQueryRewriteService(makeConfig());

    const query = await service.rewriteAfterRetrieve(
      '加班餐补怎么报',
      '加班餐补',
      GRADE,
      [hit('a')],
    );

    expect(query).toBe('差旅 报销 餐补 标准');
    const messages = invokeMock.mock.calls[0][0] as Array<{ content: unknown }>;
    expect(String(messages[1].content)).toContain('只是词沾边');
    expect(String(messages[1].content)).toContain('加班餐补');
  });

  it('改写结果与上次相同则回退原问题', async () => {
    invokeMock.mockResolvedValue({ query: '加班餐补' });
    const service = new ChatQueryRewriteService(makeConfig());

    const query = await service.rewriteAfterRetrieve(
      '加班餐补怎么报',
      '加班餐补',
      GRADE,
      [hit('a')],
    );

    expect(query).toBe('加班餐补怎么报');
  });

  it('原问题也等于上次词时返回空串，表示无法再查', async () => {
    invokeMock.mockResolvedValue({ query: '加班餐补' });
    const service = new ChatQueryRewriteService(makeConfig());

    const query = await service.rewriteAfterRetrieve(
      '加班餐补',
      '加班餐补',
      GRADE,
      [],
    );

    expect(query).toBe('');
  });

  it('改写失败时回退原问题，不阻断问答', async () => {
    invokeMock.mockRejectedValue(new Error('timeout'));
    const service = new ChatQueryRewriteService(makeConfig());

    const query = await service.rewriteAfterRetrieve(
      '年会抽奖规则',
      '年会抽奖',
      { ok: false, reason: 'empty', text: '未检索到资料' },
      [],
    );

    expect(query).toBe('年会抽奖规则');
  });
});
