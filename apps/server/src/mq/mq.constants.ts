/**
 * RAG 重建索引队列常量（BullMQ）
 *
 * 🟡 与参考项目 knowledge-hub-backend 的**实现层分叉**：
 * - 参考项目：RabbitMQ topic 交换机 `rag.reindex.exchange` + 队列 `kh.rag.reindex.queue`
 *   + 路由键 `rag.reindex.by_ids`
 * - 本项目：BullMQ 单个队列 `rag.reindex`，路由语义由 `job.data.type` 承担
 *
 * 队列名与消息结构**保持同名同形**（`rag.reindex` / `{taskId, type, documentIds}`），
 * 便于两项目 grep 对照；换实现层的理由见
 * `docs/reference-mapping.md`「分叉登记」：BullMQ 自带重试/退避/任务状态查询，
 * 直接修掉参考项目「消费失败 nack 后消息永久丢失」的 P0。
 */

/** 重建索引队列名 */
export const RAG_REINDEX_QUEUE = 'rag.reindex';

/** Redis 连接默认值 */
export const DEFAULT_REDIS_HOST = 'localhost';
export const DEFAULT_REDIS_PORT = 6379;

/**
 * Worker 并发数。
 * 默认 1：embedding 走远程 API，并发高了容易触发限流；且重建是后台任务，不追求快。
 */
export const DEFAULT_REINDEX_CONCURRENCY = 1;

/**
 * 单任务最大尝试次数（含首次）。
 * 🔴 相对参考项目的修复：参考项目消费失败直接 `nack(requeue=false)`，无重试无 DLX，
 * 一次限流/超时该文档的索引就永久丢失且无感知。
 */
export const DEFAULT_REINDEX_ATTEMPTS = 3;

/** 重试退避基数（毫秒），按 attempts 指数增长 */
export const DEFAULT_REINDEX_BACKOFF_MS = 5000;

/**
 * 启动时探测 Redis 连通性的超时（毫秒）
 *
 * 【易错】`new Queue()` / `new Worker()` 只是**创建对象**，Redis 连不上也照样返回实例
 * （BullMQ 设计为后台自动重连）。若据此判定「可用」，
 * 接口会假装可用、实际入队时挂住或失败。故显式 waitUntilReady 探测一次并加超时。
 */
export const REDIS_CONNECT_TIMEOUT_MS = 3000;
