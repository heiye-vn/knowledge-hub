/**
 * RAG 重建索引队列常量（BullMQ）
 *
 * 采用 BullMQ 单队列架构（`rag.reindex`），路由语义由 `job.data.type` 承担。
 * 原生提供重试、指数退避、延迟队列与任务状态追踪机制。
 */

/** 重建索引队列名 */
export const RAG_REINDEX_QUEUE = 'rag.reindex';

/**
 * KG 建图队列名
 *
 * 🔴 为什么 KG 必须走队列，而 Search 走同步：
 * 实测单块抽取 19~57s，一篇多分块文档耗时较长，塞进同步 publish 必然撞网关超时。
 * Search upsert 是毫秒级 ES 请求，故采用同步处理。
 */
export const KG_GRAPH_QUEUE = 'kg.graph';

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
 * 失败时结合指数退避重试，防止偶发限流或超时导致重建任务丢失。
 */
export const DEFAULT_REINDEX_ATTEMPTS = 3;

/** 重试退避基数（毫秒），按 attempts 指数增长 */
export const DEFAULT_REINDEX_BACKOFF_MS = 5000;

/** KG 建图任务：单任务最大尝试次数（含首次） */
export const DEFAULT_KG_BUILD_ATTEMPTS = 3;

/** KG 建图任务：重试退避基数（毫秒） */
export const DEFAULT_KG_BUILD_BACKOFF_MS = 30_000;

/**
 * 已完成任务的保留时长（毫秒，默认 1 小时）。
 *
 * 【易错】此前 `removeOnComplete: true` 会让完成任务在结束时**立刻删除**，
 * 任务状态查询查 completed 任务永远是 404，无法区分「已完成」与「不存在」。
 * 改为按时长保留，到期由 BullMQ 惰性清理。
 */
export const COMPLETED_JOB_RETENTION_MS = 60 * 60 * 1000;

/** KG 建图 Worker 并发数。抽取本身有 KG_EXTRACT_CONCURRENCY 控制单篇内的并发，这里限同时处理的篇数 */
export const DEFAULT_KG_BUILD_CONCURRENCY = 1;

/**
 * 启动时探测 Redis 连通性的超时（毫秒）
 *
 * 【易错】`new Queue()` / `new Worker()` 只是**创建对象**，Redis 连不上也照样返回实例
 * （BullMQ 设计为后台自动重连）。若据此判定「可用」，
 * 接口会假装可用、实际入队时挂住或失败。故显式 waitUntilReady 探测一次并加超时。
 */
export const REDIS_CONNECT_TIMEOUT_MS = 3000;
