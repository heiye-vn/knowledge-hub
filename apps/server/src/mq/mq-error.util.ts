/**
 * 队列连接错误的日志处理
 *
 * 【易错】BullMQ 的 Queue / Worker 在 Redis 不可达时会**持续重连**（这是它的设计），
 * 若每次都打日志，Redis 没起时会每秒刷屏，把真正的业务日志淹掉。
 * 故这里做节流：首次立即打印，之后相同位置最多 30 秒一条。
 */

/** 节流间隔（毫秒） */
const THROTTLE_MS = 30_000;

/**
 * 把未知错误转成可用于日志的字符串。
 * 实测出现过 `err.message` 为空的情况（驱动加载失败时抛的不是标准 Error），
 * 直接打 `${err.message}` 会得到一条没有信息量的空日志。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    // AggregateError（如驱动加载失败）的 message 常为空，真正原因在 errors 里
    const sub = (err as Error & { errors?: unknown[] }).errors;
    const detail = Array.isArray(sub)
      ? sub.map((e) => (e instanceof Error ? e.message || e.name : String(e))).join('; ')
      : '';
    return [err.message || err.name || err.constructor.name, detail]
      .filter(Boolean)
      .join(' → ');
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 探测客户端真实连通性（带超时）
 *
 * 【易错】`new Queue()` / `new Worker()` 只是创建对象，Redis 连不上也照样返回实例
 * （BullMQ 设计为后台自动重连）。要判定「是否真的可用」必须显式 waitUntilReady 一次；
 * 又因为它默认会一直等到连上，所以要自己加超时，否则启动会被永久挂住。
 */
export async function waitUntilReady(
  client: { waitUntilReady: () => Promise<unknown> },
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`连接 Redis 超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 节流的错误日志。同一个 key 首次立即输出，之后 THROTTLE_MS 内静默。
 * @returns 是否真的输出了
 */
export function logThrottled(
  logger: { error: (msg: string) => void; warn: (msg: string) => void },
  level: 'error' | 'warn',
  key: string,
  message: string,
  state: Map<string, number>,
): boolean {
  const now = Date.now();
  const last = state.get(key) ?? 0;
  if (last !== 0 && now - last < THROTTLE_MS) return false;
  state.set(key, now);
  logger[level](message);
  return true;
}
