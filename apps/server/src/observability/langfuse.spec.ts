import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const spanUpdate = vi.fn();
  const startActiveObservation = vi.fn(
    async (
      _name: string,
      fn: (span: { update: typeof spanUpdate }) => unknown,
    ) => fn({ update: spanUpdate }),
  );
  const propagateAttributes = vi.fn((_attrs: unknown, fn: () => unknown) =>
    fn(),
  );
  return { spanUpdate, startActiveObservation, propagateAttributes };
});

vi.mock('@opentelemetry/sdk-node', () => {
  const instances: unknown[] = [];
  class NodeSDK {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
    start = vi.fn();
    shutdown = vi.fn(async () => undefined);
  }
  return { NodeSDK, __instances: instances };
});

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class LangfuseSpanProcessor {},
}));

vi.mock('@langfuse/tracing', () => ({
  startActiveObservation: mocks.startActiveObservation,
  propagateAttributes: mocks.propagateAttributes,
}));

vi.mock('@langfuse/langchain', () => ({
  CallbackHandler: class CallbackHandler {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  },
}));

type LangfuseModule = typeof import('./langfuse.js');

async function importFresh(): Promise<LangfuseModule> {
  vi.resetModules();
  return import('./langfuse.js');
}

function setEnv(env: Record<string, string | undefined>) {
  const keys = [
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
    'LANGFUSE_TRACE_CONTENT',
    'LANGFUSE_TRACE_SAMPLE_RATE',
    'LANGFUSE_HASH_USER_ID',
    'LANGFUSE_TRACE_ID_SALT',
  ];
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

async function sdkInstances(): Promise<unknown[]> {
  const sdk = (await import('@opentelemetry/sdk-node')) as unknown as {
    __instances: unknown[];
  };
  return sdk.__instances;
}

describe('LangFuse 观测封装', () => {
  beforeEach(() => {
    setEnv({});
    mocks.spanUpdate.mockClear();
    mocks.startActiveObservation.mockClear();
    mocks.propagateAttributes.mockClear();
  });

  it('未配置公私钥时不启动 SDK，业务照常执行', async () => {
    const mod = await importFresh();
    expect(mod.isLangfuseEnabled()).toBe(false);
    expect(() => mod.startLangfuseTracing()).not.toThrow();

    const value = await mod.withObservation('test', async (update) => {
      update({ input: { question: '敏感问题' } });
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(mocks.startActiveObservation).not.toHaveBeenCalled();
  });

  it('配置公私钥后只启动一次 SDK，shutdown 会等待并清理', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
    });
    const mod = await importFresh();
    expect(mod.isLangfuseEnabled()).toBe(true);

    mod.startLangfuseTracing();
    mod.startLangfuseTracing();
    expect(await sdkInstances()).toHaveLength(1);

    await mod.shutdownLangfuseTracing();
    mod.startLangfuseTracing();
    expect(await sdkInstances()).toHaveLength(2);
  });

  it('默认不上传内容：input/output 被移除，metadata 只保留安全字段', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
    });
    const mod = await importFresh();
    const sanitized = mod.sanitizeObservationFields({
      input: { question: '出差报销' },
      output: { answer: '找张敏加签', hitTitles: ['差旅制度'] },
      metadata: {
        intent: 'kb',
        retrieveCount: 2,
        retried: true,
        error: true,
        hitTitles: ['差旅制度'],
        query: '出差报销',
      },
    });
    expect(sanitized.input).toBeUndefined();
    expect(sanitized.output).toBeUndefined();
    expect(sanitized.metadata).toEqual({
      intent: 'kb',
      retrieveCount: 2,
      retried: true,
      error: true,
    });
  });

  it('显式开启内容上报时保留 input/output 与 metadata', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_CONTENT: 'true',
    });
    const mod = await importFresh();
    const fields = {
      input: { question: '出差报销' },
      output: { answer: '找张敏加签' },
      metadata: { hitTitles: ['差旅制度'] },
    };
    expect(mod.sanitizeObservationFields(fields)).toEqual(fields);
  });

  it('开启内容上报时 withObservation 把字段交给 span.update', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_CONTENT: 'true',
    });
    const mod = await importFresh();
    await mod.withObservation('ai-chat', async (update) => {
      update({ input: { question: '出差报销' } });
      return 'done';
    });

    expect(mocks.startActiveObservation).toHaveBeenCalled();
    expect(mocks.spanUpdate).toHaveBeenCalledWith({
      input: { question: '出差报销' },
    });
  });

  it('默认脱敏模式下 withObservation 只把安全 metadata 交给 span.update', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
    });
    const mod = await importFresh();
    await mod.withObservation('retrieve-and-grade', async (update) => {
      update({
        input: { query: '出差报销' },
        output: { answer: '张敏' },
        metadata: { retrieveCount: 1, hitTitles: ['差旅制度'] },
      });
      return 'done';
    });

    expect(mocks.spanUpdate).toHaveBeenCalledWith({
      metadata: { retrieveCount: 1 },
    });
  });

  it('默认脱敏模式下不创建 LangChain 自动回调，显式开正文才创建', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
    });
    const safe = await importFresh();
    expect(
      safe.createLangfuseCallbackHandler({ userId: '1001' }),
    ).toBeUndefined();

    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_CONTENT: 'true',
      LANGFUSE_HASH_USER_ID: 'false',
    });
    const full = await importFresh();
    const handler = full.createLangfuseCallbackHandler({
      userId: '1001',
      sessionId: '9001',
      tags: ['eval'],
    });
    expect(handler).toBeDefined();
  });

  it('userId 默认哈希，可配置保留原文', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_ID_SALT: 'salt-a',
    });
    const mod = await importFresh();
    const hashed = mod.traceUserId('1001');
    expect(hashed).not.toBe('1001');
    expect(hashed).toHaveLength(64);
    expect(mod.traceUserId('1001')).toBe(hashed);

    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_ID_SALT: 'salt-b',
      LANGFUSE_HASH_USER_ID: 'false',
    });
    const plain = await importFresh();
    expect(plain.traceUserId('1001')).toBe('1001');
  });

  it('采样率非法回退为 1，且同一身份采样结果稳定', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_SAMPLE_RATE: 'abc',
    });
    const mod = await importFresh();
    expect(mod.shouldTrace({ userId: '1001', sessionId: '9001' })).toBe(true);

    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_SAMPLE_RATE: '0',
    });
    const zero = await importFresh();
    expect(zero.shouldTrace({ userId: '1001' })).toBe(false);

    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_SAMPLE_RATE: '0.5',
    });
    const half = await importFresh();
    const first = half.shouldTrace({ userId: '1001', sessionId: '9001' });
    expect(half.shouldTrace({ userId: '1001', sessionId: '9001' })).toBe(first);
    expect(
      half.shouldTrace({ userId: 'other-user', sessionId: 'other-session' }),
    ).toBeTypeOf('boolean');
  });

  it('withTraceAttrs 传播哈希后的身份，并把采样判定传给嵌套观测', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_CONTENT: 'true',
      LANGFUSE_TRACE_ID_SALT: 'salt-a',
    });
    const mod = await importFresh();
    let nestedSawSpan = false;

    const value = await mod.withTraceAttrs(
      { userId: '1001', sessionId: '9001', tags: ['ai-chat'] },
      async () => {
        await mod.withObservation('child', async () => {
          nestedSawSpan = true;
          return 'child-ok';
        });
        return 'root-ok';
      },
    );

    expect(value).toBe('root-ok');
    expect(nestedSawSpan).toBe(true);
    expect(mocks.propagateAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: expect.any(String),
        sessionId: '9001',
        tags: ['ai-chat'],
      }),
      expect.any(Function),
    );
  });

  it('采样命中为 false 时嵌套业务仍执行但不创建 span', async () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_TRACE_SAMPLE_RATE: '0',
    });
    const mod = await importFresh();
    const value = await mod.withTraceAttrs(
      { userId: '1001', sessionId: '9001' },
      () =>
        mod.withObservation('child', async (update) => {
          update({ input: '敏感' });
          return 'ok';
        }),
    );

    expect(value).toBe('ok');
    expect(mocks.startActiveObservation).not.toHaveBeenCalled();
    expect(mocks.propagateAttributes).not.toHaveBeenCalled();
  });
});
