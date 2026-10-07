import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ChatSessionService } from './chat-session.service.js';

/** EntityManager fake：只实现用到的 findAndCount / findOne / create / save / remove / find */
function makeEm() {
  return {
    findAndCount: vi.fn(async (): Promise<[unknown[], number]> => [[], 0]),
    findOne: vi.fn(async (): Promise<unknown> => null),
    find: vi.fn(async (): Promise<unknown[]> => []),
    create: vi.fn((_cls: unknown, data: object) => ({ ...data })),
    save: vi.fn(async (x: unknown) => x),
    remove: vi.fn(async (x: unknown) => x),
  };
}

function makeService(em: ReturnType<typeof makeEm>) {
  return new ChatSessionService(em as unknown as never);
}

/** 模拟库里的会话行（plain object，避免类实例展开丢失原型） */
const SESSION = {
  id: '8001',
  userId: '1001',
  title: '旧标题',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ChatSessionService（fake EntityManager）', () => {
  it('未传标题时用默认名「新对话」', async () => {
    const em = makeEm();
    const service = makeService(em);
    const session = await service.create('1001', {});
    expect(session.title).toBe('新对话');
    expect(em.create).toHaveBeenCalledOnce();
  });

  it('新建会话标题超 80 字截断，首问生成标题截 30 字', async () => {
    const em = makeEm();
    const service = makeService(em);

    const long = await service.create('1001', { title: `标`.repeat(100) });
    expect((long as { title: string }).title.length).toBe(80);

    // appendTurn 新建路径：question 超 30 字（calls[0] 是上面的长标题会话）
    em.findOne.mockResolvedValue(null);
    await service.appendTurn('1001', undefined, `${'问'.repeat(40)}`, '答', []);
    const created = em.create.mock.calls[1]?.[1] as { title: string };
    expect(created.title).toBe(`${'问'.repeat(30)}…`);
  });

  it('续聊默认名会话时标题被首问覆盖，已有命名保持不变', async () => {
    const em = makeEm();
    const service = makeService(em);

    em.findOne.mockResolvedValue({
      ...SESSION,
      title: '新对话',
    });
    await service.appendTurn('1001', '8001', '什么是 RAG？', '答', []);
    expect(em.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: '什么是 RAG？' }),
    );
    em.findOne.mockResolvedValue({ ...SESSION, title: '自定义' });
    em.save.mockClear();
    await service.appendTurn('1001', '8001', '第二问', '答', []);
    expect(em.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: '第二问' }),
    );
  });

  it('续传他人会话 ID 时 404（所有权校验）', async () => {
    const em = makeEm();
    em.findOne.mockResolvedValue(null);
    const service = makeService(em);

    await expect(
      service.appendTurn('1002', '8001', '问', '答', []),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.listMessages('1002', '8001'),
    ).rejects.toThrow(NotFoundException);
  });

  it('落库一轮问答写两条消息（user + assistant），无引用时 sources 为 NULL', async () => {
    const em = makeEm();
    em.findOne.mockResolvedValue(null);
    const service = makeService(em);

    await service.appendTurn('1001', undefined, '问', '答', []);
    const [, assistantMsg] = em.create.mock.calls.at(-1) ?? [];
    expect(assistantMsg).toMatchObject({
      role: 'assistant',
      content: '答',
      sources: null,
    });

    await service.appendTurn('1001', undefined, '问', '答', [
      { index: 1, documentId: 'd1', documentTitle: 't', heading: null, excerpt: 'e', score: 0.9 },
    ]);
    const lastAssistant = em.create.mock.calls.at(-1)?.[1] as {
      role: string;
      sources: unknown;
    };
    expect(lastAssistant.role).toBe('assistant');
    expect(lastAssistant.sources).toHaveLength(1);
  });

  it('删除会话只删会话行，消息交给外键级联', async () => {
    const em = makeEm();
    em.findOne.mockResolvedValue(SESSION);
    const service = makeService(em);

    await service.remove('1001', '8001');
    expect(em.remove).toHaveBeenCalledWith(SESSION);
    expect(em.find).not.toHaveBeenCalled();
  });
});
