import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ChatLongMemoryService } from './chat-long-memory.service.js';

const mem0 = {
  search: vi.fn(),
  add: vi.fn(),
  get: vi.fn(),
  getAll: vi.fn(),
  delete: vi.fn(),
  deleteAll: vi.fn(),
};
vi.mock('mem0ai', () => ({
  MemoryClient: class {
    search = mem0.search;
    add = mem0.add;
    get = mem0.get;
    getAll = mem0.getAll;
    delete = mem0.delete;
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

function makeConfig(
  withMem0 = true,
  overrides: Record<string, unknown> = {},
) {
  return {
    get: (key: string, fallback?: unknown) => {
      if (key in overrides) return overrides[key];
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
    mem0.get.mockReset();
    mem0.getAll.mockReset();
    mem0.delete.mockReset();
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

  it('注入闸门：每层条数上限生效，超出条目不再进 prompt', () => {
    const service = new ChatLongMemoryService(
      makeConfig(false, { CHAT_MEMORY_INJECT_MAX_ITEMS: 2 }),
    );
    const text = String(
      service.buildSystemMessage({
        user: ['第一条', '第二条', '第三条'],
        session: [],
      })!.content,
    );
    expect(text).toContain('- 第一条');
    expect(text).toContain('- 第二条');
    expect(text).not.toContain('- 第三条');
  });

  it('注入闸门：字符上限截断并标记，首条超长时保留截断版', () => {
    const service = new ChatLongMemoryService(
      makeConfig(false, {
        CHAT_MEMORY_INJECT_MAX_ITEMS: 10,
        CHAT_MEMORY_INJECT_MAX_CHARS: 30,
      }),
    );
    // 每条 5 个汉字 17 字节；两条 34 字节超 30，第二条被截
    const text = String(
      service.buildSystemMessage({
        user: ['一'.repeat(5), '二'.repeat(5)],
        session: [],
      })!.content,
    );
    expect(text).toContain('- （已截断）');
    expect(text).not.toContain('- 二二二二二');

    // 首条单条就超限（10 个汉字 32 字节 > 30）也要保留，不能整块消失
    const firstOnly = String(
      service.buildSystemMessage({ user: ['长'.repeat(10)], session: [] })!
        .content,
    );
    expect(firstOnly).toContain('- 长');
    expect(firstOnly).toContain('（已截断）');
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

  it('开启时间衰减时按 score × 时间折扣重排，并扩大候选集', async () => {
    const now = Date.now();
    const stale = new Date(now - 30 * 86_400_000).toISOString();
    const fresh = new Date(now - 1 * 86_400_000).toISOString();
    mem0.search
      .mockResolvedValueOnce({
        results: [
          { memory: '旧但满分', score: 1, createdAt: stale },
          { memory: '新且中分', score: 0.8, createdAt: fresh },
        ],
      })
      .mockResolvedValueOnce({ results: [] });

    const service = new ChatLongMemoryService(
      makeConfig(true, { CHAT_MEMORY_DECAY_HALF_LIFE_DAYS: 7 }),
    );
    const hits = await service.search('1001', '8001', '偏好');
    // halfLife 7 天：旧条目 1×exp(-30/7)≈0.014，新条目 0.8×exp(-1/7)≈0.69
    expect(hits.user[0]).toBe('新且中分');
    // 开了衰减就要更大候选集，否则重排只在原 topK 内部换序
    expect(mem0.search.mock.calls[0][1].topK).toBe(10);
  });

  it('未开衰减时保持 Mem0 原始顺序', async () => {
    mem0.search
      .mockResolvedValueOnce({
        results: [
          { memory: '甲', score: 0.6, createdAt: '2020-01-01T00:00:00Z' },
          { memory: '乙', score: 0.9, createdAt: '2026-01-01T00:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({ results: [] });
    const service = new ChatLongMemoryService(makeConfig());
    const hits = await service.search('1001', '8001', '问题');
    expect(hits.user).toEqual(['甲', '乙']);
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

  it('分类器失败时跳过写入，不抛错', async () => {
    classifyMock.mockRejectedValue(new Error('llm timeout'));
    const service = new ChatLongMemoryService(makeConfig());

    await expect(
      service.rememberTurn('1001', '8001', '问题', '答案'),
    ).resolves.toBeUndefined();
    expect(mem0.add).not.toHaveBeenCalled();
  });

  it('写入瞬时失败重试一次后成功', async () => {
    classifyMock.mockResolvedValue({
      write_user: true,
      write_session: false,
      reason: '偏好',
    });
    mem0.add.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([]);
    const service = new ChatLongMemoryService(makeConfig());

    await service.rememberTurn('1001', '8001', '回答短一点', '好');
    expect(mem0.add).toHaveBeenCalledTimes(2);
  });

  it('两次都失败才放弃，只告警不抛错', async () => {
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
    expect(mem0.add).toHaveBeenCalledTimes(2);
  });

  it('user 层写失败不影响 session 层继续写', async () => {
    classifyMock.mockResolvedValue({
      write_user: true,
      write_session: true,
      reason: '身份 + 本轮任务',
    });
    mem0.add
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce([]);
    const service = new ChatLongMemoryService(makeConfig());

    await service.rememberTurn('1001', '8001', '我是后端，这次排查登录', '好');
    expect(mem0.add).toHaveBeenCalledTimes(3);
    expect(mem0.add.mock.calls[2][1]).toMatchObject({ runId: '8001' });
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

  it('list 按层组装 filters；session 层缺 sessionId 直接返回空页', async () => {
    mem0.getAll.mockResolvedValue({
      count: 1,
      next: null,
      previous: null,
      results: [
        {
          id: 'm1',
          memory: '用户偏好简洁',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const service = new ChatLongMemoryService(makeConfig());

    const page = await service.list('1001', 'user', undefined, 1, 20);
    expect(mem0.getAll).toHaveBeenCalledWith({
      filters: { user_id: '1001' },
      page: 1,
      pageSize: 20,
    });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 'm1',
      layer: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const missing = await service.list('1001', 'session', undefined, 1, 20);
    expect(missing.items).toEqual([]);
    expect(mem0.getAll).toHaveBeenCalledTimes(1);
  });

  it('remove 校验归属：别人的记忆按不存在处理，不执行删除', async () => {
    mem0.get.mockResolvedValue({ id: 'm1', userId: '9999' });
    const service = new ChatLongMemoryService(makeConfig());

    expect(await service.remove('1001', 'm1')).toBe(false);
    expect(mem0.delete).not.toHaveBeenCalled();
  });

  it('remove 命中本人记忆才删除', async () => {
    mem0.get.mockResolvedValue({ id: 'm1', userId: '1001' });
    const service = new ChatLongMemoryService(makeConfig());

    expect(await service.remove('1001', 'm1')).toBe(true);
    expect(mem0.delete).toHaveBeenCalledWith('m1');
  });

  it('clearAll 走 deleteAll({ userId })，两层一起清', async () => {
    mem0.deleteAll.mockResolvedValue(undefined);
    const service = new ChatLongMemoryService(makeConfig());

    expect(await service.clearAll('1001')).toBe(true);
    expect(mem0.deleteAll).toHaveBeenCalledWith({ userId: '1001' });
  });
});
