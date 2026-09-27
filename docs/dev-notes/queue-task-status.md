# 队列任务状态查询（GET /tasks/:taskId）

> **模块范围**：BullMQ 异步任务（KG 建图 `kg.graph`、RAG 全量重建 `rag.reindex`）的统一状态查询入口。
> 对应代码：`src/mq/task-status.service.ts`、`src/mq/task-status.controller.ts`，
> 以及两个 Publisher 新增的 `findJob()`（`src/mq/rag-reindex.publisher.ts`、`src/kg/kg-build.publisher.ts`）。
> 完成时间：2026-09-28。

## 背景

两条异步链路（KG 建图、批量重建）此前只有入队响应里的 taskId，
建图单篇可能跑数分钟，任务死活只能翻服务日志——异步链路不可观测是交付硬伤。
BullMQ 本身自带任务状态存储，缺的只是一个查询入口。

## 关键决策

### jobId 全局唯一 → 一个接口查两个队列，不分路由

两条队列的 jobId 都是入队时 `randomUUID()` 生成的 taskId，全局唯一，冲突概率可忽略。
因此对外只暴露一个 `GET /tasks/:taskId`，服务内部对两个队列各查一次、先命中先用，
前端不用关心（也不知道）任务属于哪条队列。代价是多一次 Redis 查询，可忽略。

### 复用 Publisher 持有的 Queue 连接，不另建客户端

查询只是读操作，但不为它再 new 一套 Queue：`TaskStatusService` 直接注入
`RagReindexPublisher` 与 `KgBuildPublisher`，各暴露一个 `findJob()`。
为此 `MqModule` 导入 `KgModule` 拿 `KgBuildPublisher`——模块图无环
（没有任何模块依赖 MqModule，KgModule 只被 DocumentModule / MqModule 导入），
且两个队列各只占一条 Redis 连接。

### 权限与触发入口对齐

`POST /kg/build`、`POST /rag/reindex` 都是 `@Roles(ADMIN)`，状态查询同为 ADMIN，
不出现「能触发却查不了」或「查得到就能触发」的不对称。

## 踩坑实录

### 【实录】`removeOnComplete: true` 让「查完成任务」永远 404

- **现象**：最初两个队列的 `defaultJobOptions` 都是 `removeOnComplete: true`——任务一完成就被删除，
  状态查询对 completed 任务返回 404，前端无法区分「已完成」和「taskId 错了」。
- **原因**：`removeOnComplete` 的初衷是防队列膨胀，`true` 是「完成即删」，没给观测留窗口。
- **解法**：改为 `removeOnComplete: { age: COMPLETED_JOB_RETENTION_MS }`（1 小时），
  完成任务保留窗口期供查询，到期由 BullMQ 惰性清理；失败任务维持 `removeOnFail: false` 永久保留。
- **如何验证**：`POST /rag/reindex` 后用返回的 taskId 调 `GET /tasks/:taskId`，
  执行中返回 `active`，完成后返回 `completed`（finishedAt 有值）；
  1 小时后同一请求返回 404。

### 【实录】BullMQ 6 的 `getJob()` 返回 `undefined` 而非 `null`

- **现象**：`findJob()` 声明返回 `Promise<Job | null>`，typecheck 报 TS2322
  （`Job | undefined is not assignable to Job | null`）。
- **解法**：`return (await this.queue.getJob(jobId)) ?? null;` 归一化。

### 【实录】Redis 断连时 `getJob()` 无限挂起

- **原因**：BullMQ 是自动重连设计，断连期间命令缓存在离线队列里，`getJob()` 的 Promise 永不 settle；
  状态查询是 HTTP 接口，跟着挂死等于把 Redis 故障放大成网关超时。
- **解法**：单次查询套 `Promise.race` 超时（复用 `REDIS_CONNECT_TIMEOUT_MS`，默认 3s），
  超时抛 `ServiceUnavailableException`（503），与队列不可用（REDIS_ENABLED=false）同语义。
- **如何验证**：单测 `task-status.spec.ts`「查询挂死 → 按超时抛 503」
  （fake publisher 返回永不 resolve 的 Promise，`REDIS_CONNECT_TIMEOUT_MS=50`）。

## 已知局限

- Worker 目前不调 `job.updateProgress()`，`state=active` 时看不到百分比进度；
  KG / 重建都是「按篇循环」，想加进度时在 Worker 里按「已处理篇数 / 总篇数」上报即可。
- BullMQ 的 `age` 清理是惰性的（依赖队列被访问），无任务流量时过期任务可能残留更久——只影响存储，不影响正确性。
- 只支持按已知 taskId 查单个任务，没有「列出队列中全部任务」；需要任务列表 / 可视化时再引入 bull-board。
- 完成任务只保留 1 小时，长周期统计类需求（如每日重建量报表）不在此接口能力范围内。

## 后续待办

- 前端建图 / 重建触发后按 taskId 轮询本接口，展示「排队中 / 建图中 / 完成 / 失败（含原因）」。
