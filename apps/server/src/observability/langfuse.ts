import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { CallbackHandler } from '@langfuse/langchain';
import {
  propagateAttributes,
  startActiveObservation,
} from '@langfuse/tracing';

const logger = new Logger('Langfuse');

let sdk: NodeSDK | undefined;

/**
 * 一轮对话内的采样上下文。放在 AsyncLocalStorage 里，
 * 子观测与异步工具回调都能拿到同一次判定，避免同一 trace 只剩半截。
 */
type TraceAttrs = {
  userId?: string;
  sessionId?: string;
  tags?: string[];
  sampled: boolean;
};

const traceContext = new AsyncLocalStorage<TraceAttrs>();

/** 上报 LangFuse 的观测字段；input/output 默认不出网。 */
export type ObservationFields = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
};

const SAFE_METADATA_KEYS = new Set([
  'intent',
  'reason',
  'retrieveCount',
  'retried',
  'rewritten',
  'n',
  'error',
  'success',
  'useful',
  'graphUsed',
  'webUsed',
  'durationMs',
]);

/** 配了公私钥才上报；无 Key 时所有包装函数零行为侵入。 */
export function isLangfuseEnabled(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
}

export function isTraceContentEnabled(): boolean {
  return process.env.LANGFUSE_TRACE_CONTENT === 'true';
}

export function startLangfuseTracing(): void {
  if (sdk || !isLangfuseEnabled()) return;
  sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
  logger.log(
    `LangFuse tracing 已启动 baseUrl=${process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'}`,
  );
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = undefined;
  await current.shutdown();
}

/**
 * 内容默认不出网：只保留指标类 metadata 与级别。
 * 这样仍能看到链路、耗时与失败位置，但不会把用户问题、回答或文档摘录发给外部平台。
 */
export function sanitizeObservationFields(
  fields: ObservationFields,
): ObservationFields {
  if (isTraceContentEnabled()) return fields;

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields.metadata ?? {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      metadata[key] = value;
    }
  }
  return {
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(fields.level ? { level: fields.level } : {}),
  };
}

/** 身份哈希默认开启；只有显式 LANGFUSE_HASH_USER_ID=false 才保留原文。 */
export function traceUserId(userId: string | undefined): string | undefined {
  if (!userId) return undefined;
  if (process.env.LANGFUSE_HASH_USER_ID === 'false') return userId;
  const salt = process.env.LANGFUSE_TRACE_ID_SALT ?? 'knowledge-hub-trace-v1';
  return createHash('sha256').update(`${salt}:${userId}`).digest('hex');
}

function sampleRate(): number {
  const raw = Number(process.env.LANGFUSE_TRACE_SAMPLE_RATE ?? '1');
  if (!Number.isFinite(raw)) return 1;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}

/** 稳定采样：同一 userId/sessionId 在同一配置下要么全采、要么全不采。 */
export function shouldTrace(attrs: {
  userId?: string;
  sessionId?: string;
}): boolean {
  const rate = sampleRate();
  if (rate === 1) return true;
  if (rate === 0) return false;
  const salt = process.env.LANGFUSE_TRACE_ID_SALT ?? 'knowledge-hub-trace-v1';
  const identity = attrs.userId ?? attrs.sessionId ?? 'anonymous';
  const digest = createHash('sha256')
    .update(`${salt}:${identity}`)
    .digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff;
  return bucket < rate;
}

export async function withTraceAttrs<T>(
  attrs: {
    userId?: string;
    sessionId?: string;
    tags?: string[];
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) return run();
  const sampled = shouldTrace(attrs);
  const context: TraceAttrs = { ...attrs, sampled };
  if (!sampled) return traceContext.run(context, run);
  const userId = traceUserId(attrs.userId);
  return traceContext.run(context, () =>
    propagateAttributes(
      {
        ...(userId ? { userId } : {}),
        ...(attrs.sessionId ? { sessionId: attrs.sessionId } : {}),
        ...(attrs.tags ? { tags: attrs.tags } : {}),
      },
      run,
    ),
  );
}

/**
 * LangChain 自动回调没有内容脱敏钩子，会把 prompt / 工具入参与回答直接上报。
 * 因此只有显式 LANGFUSE_TRACE_CONTENT=true 才挂回调；默认仅保留业务 span 的元数据。
 */
export function createLangfuseCallbackHandler(attrs: {
  userId?: string;
  sessionId?: string;
  tags?: string[];
}): CallbackHandler | undefined {
  if (!isLangfuseEnabled() || !shouldTrace(attrs)) return undefined;
  if (!isTraceContentEnabled()) return undefined;
  const userId = traceUserId(attrs.userId);
  return new CallbackHandler({
    ...(userId ? { userId } : {}),
    ...(attrs.sessionId ? { sessionId: attrs.sessionId } : {}),
    ...(attrs.tags ? { tags: attrs.tags } : {}),
  });
}

export async function withObservation<T>(
  name: string,
  run: (update: (fields: ObservationFields) => void) => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) return run(() => undefined);
  const context = traceContext.getStore();
  if (context && !context.sampled) return run(() => undefined);

  return startActiveObservation(name, async (span) =>
    run((fields) => {
      span.update(sanitizeObservationFields(fields));
    }),
  ) as Promise<T>;
}
