import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ChatLongMemoryService } from './chat-long-memory.service.js';

const mem0 = {
  search: vi.fn(),
  add: vi.fn(),
  deleteAll: vi.fn(),
};
vi.mock('mem0ai', () => ({
  MemoryClient: class {
    search = mem0.search;
    add = mem0.add;
    deleteAll = mem0.deleteAll;
    constructor(_opts: unknown) {}
  },
}));

const classifyMock = vi.fn();
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    withStructuredOutput() {
      return { invoke: classifyMock };
    }
    constructor(_opts: unknown) {}
  },
}));

function makeConfig(withMem0 = true) {
  return {
    get: (key: string, fallback?: unknown) => {
      if (key === 'MEM0_API_KEY') return withMem0 ? 'mem0-key' : '';
      if (key === 'LLM_API_KEY') return 'llm-key';
      return fallback;
    },
  } as unknown as ConfigService;
}

describe('ChatLongMemoryService（mock Mem0 与分类器）', () => {
  beforeEach(() => {
    mem0.search.mockReset();
    mem0.add.mockReset();
    mem0.deleteAll.mockReset();
    classifyMock.mockReset();
  });

  it('未配置 MEM0_API_KEY 时整条能力关闭：检索为空、写入跳过', async () => {
    const service = new ChatLongMemoryService(makeConfig(false));
    expect(service.enabled).toBe(false);

    const hits = await service.search('1001', '8001', '问题');
    expect(hits).toEqual({ user: [], session: [] });
    expect(mem0.search).not.toHaveBeenCalled();

    await service.rememberTurn('1001', '8001', '我是后端', '收到');
    expect(classifyMock).not.toHaveBeenCalled();
    expect(mem0.add).not.toHaveBeenCalled();

    await service.clearSession('1001', '8001');
    expect(mem0.deleteAll).not.toHaveBeenCalled();
  });

  it('buildSystemMessage 分两层拼接并声明「以检索资料为准」', () => {
    const service = new ChatLongMemoryService(makeConfig(false));

    const msg = service.buildSystemMessage({
      user: ['用户是成都研发中心后端'],
      session: ['本轮只看差旅住宿上限'],
    });
    expect(msg).not.toBeNull();
    const text = String(msg!.content);
    expect(text).toContain('【用户长期记忆】');
    expect(text).toContain('- 用户是成都研发中心后端');
    expect(text).toContain('【当前会话记忆】');
    expect(text).toContain('以本轮检索资料为准');

    expect(service.buildSystemMessage({ user: [], session: [] })).toBeNull();
  });

  it('search 分别按 user 层与 session 层（run_id）过滤', async () => {
    mem0.search
      .mockResolvedValueOnce({ results: [{ memory: '用户偏好简洁' }] })
      .mockResolvedValueOnce({ results: [{ memory: '本轮看住宿上限' }] });
    const service = new ChatLongMemoryService(makeConfig());

    const hits = await service.search('1001', '8001', '住宿标准');
    expect(hits).toEqual({
      user: ['用户偏好简洁'],
      session: ['本轮看住宿上限'],
    });
    expect(mem0.search).toHaveBeenNthCalledWith(1, '住宿标准', {
      filters: { user_id: '1001' },
      topK: 5,
    });
    expect(mem0.search).toHaveBeenNthCalledWith(2, '住宿标准', {
      filters: { AND: [{ user_id: '1001' }, { run_id: '8001' }] },
      topK: 5,
    });
  });

  it('search 失败时返回空（记忆只作背景，不阻断问答）', async () => {
    mem0.search.mockRejectedValue(new Error('mem0 down'));
    const service = new ChatLongMemoryService(makeConfig());

    await expect(service.search('1001', '8001', '问题')).resolves.toEqual({
      user: [],
      session: [],
    });
  });

  it('分类为 user 层时只写 userId，不写 runId', async () => {
    classifyMock.mockResolvedValue({
      write_user: true,
      write_session: false,
      reason: '用户声明岗位',
    });
    const service = new ChatLongMemoryService(makeConfig());

    await service.rememberTurn('1001', '8001', '我是成都研发中心后端', '好的');
    expect(mem0.add).toHaveBeenCalledTimes(1);
    const [messages, opts] = mem0.add.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: '我是成都研发中心后端' }]);
    expect(opts).toMatchObject({ userId: '1001' });
    expect(opts.runId).toBeUndefined();
    // 抽取约束：只从用户话里取，不存制度条文
    expect(String(opts.customInstructions)).toContain('不要保存制度条文');
  });

  it('分类为 session 层时带 runId 写入', async () => {
    classifyMock.mockResolvedValue({
      write_user: false,
      write_session: true,
      reason: '本轮任务',
    });
    const service = new ChatLongMemoryService(makeConfig());

    await service.rememberTurn('1001', '8001', '这次只看住宿上限', '好');
    expect(mem0.add).toHaveBeenCalledWith(
      [{ role: 'user', content: '这次只看住宿上限' }],
      expect.objectContaining({ userId: '1001', runId: '8001' }),
    );
  });

  it('分类为均不写入时（寒暄 / 文档事实）不调 add', async () => {
    classifyMock.mockResolvedValue({
      write_user: false,
      write_session: false,
      reason: '寒暄',
    });
    const service = new ChatLongMemoryService(makeConfig());

    await service.rememberTurn('1001', '8001', '好的谢谢', '不客气');
    expect(mem0.add).not.toHaveBeenCalled();
  });

  it('写入失败只告警不抛错', async () => {
    classifyMock.mockResolvedValue({
      write_user: true,
      write_session: false,
      reason: '偏好',
    });
    mem0.add.mockRejectedValue(new Error('mem0 down'));
    const service = new ChatLongMemoryService(makeConfig());

    await expect(
      service.rememberTurn('1001', '8001', '回答短一点', '好'),
    ).resolves.toBeUndefined();
  });

  it('clearSession 只清会话层（user 层画像保留）', async () => {
    mem0.deleteAll.mockResolvedValue(undefined);
    const service = new ChatLongMemoryService(makeConfig());

    await service.clearSession('1001', '8001');
    expect(mem0.deleteAll).toHaveBeenCalledWith({
      userId: '1001',
      runId: '8001',
    });
  });
});
