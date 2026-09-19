# 异步重建索引管线（阶段二 · 方案 B）

对应参考项目 `knowledge-hub-backend` v3 的 `src/mq/*`（RabbitMQ）。
实现时间 2026-09-19。模块代码在 `apps/server/src/mq/`。

## 为什么是「方案 B」

先实测再决定，结论推翻了最初的判断：

| 文档规模 | 块数 | 发布耗时 |
| :--- | ---: | ---: |
| 7.7K 字符 | 14 | 1.02s |
| 64.8K 字符 | 120 | 2.79s |
| 260.9K 字符 | 480 | 6.99s |

拟合：**0.84s 固定开销 + 12.8ms/块**。

→ **单次发布根本不慢**，所以没有为了它把 `publish` 改成异步。
真正的刚需是「换 embedding 模型后全量重索引」，故：

- `publish` **保持同步**，响应仍返回 `indexed` / `chunks`，语义不变
- 队列**只服务批量重建**，入口 `POST /rag/reindex`（body 留空 = 全部已发布文档）

代价对比：改成异步会引入「最终一致性窗口 + 任务状态查询接口 + 前端索引中状态」，
按实测数据不值当。

## 【实录】`new Queue()` 连不上也返回实例

**现象**：Redis 没起时，启动日志显示「队列已就绪」，`POST /rag/reindex` 却 502/挂住。

**原因**：BullMQ 设计为后台自动重连，`new Queue()` / `new Worker()` 只是**创建对象**，
不建立连接。我最初用 `queue !== null` 判定可用，等于「假装可用」。

**解法**：`onModuleInit` 里显式 `waitUntilReady()`，并自己加超时
（它默认会一直等到连上，不加超时会把启动永久挂住）。失败则关闭客户端并置 `null`，
让接口如实返回 503。见 `mq-error.util.ts` 的 `waitUntilReady`。

## 【实录】连接错误每秒刷屏

**现象**：Redis 不可达时，日志每秒 2~3 条 `连接异常`，业务日志被淹没。

**原因**：同上，自动重连导致的错误风暴是 BullMQ 的正常行为。

**解法**：`logThrottled` —— 首次立即打印，之后同一位置最多 30 秒一条。
实测 9 秒内从 20+ 条降到 2 条。

## 【实录】`err.message` 是空的

**现象**：日志打出「重建队列连接异常：」后面什么都没有。

**原因**：驱动加载失败抛的是 `AggregateError`，`message` 为空，真正原因在 `.errors` 里。

**解法**：`describeError` 对 `AggregateError` 展开子错误。
修完能看到 `connect ECONNREFUSED 127.0.0.1:6379`，一眼定位到是 Redis 没起。

## 【易错】ioredis 是 peer 依赖，被 pnpm 提升到根目录

`bullmq` 不自带 Redis 客户端，`ioredis` 是 **peerDependency**。
pnpm 开了 `auto-install-peers`，会装上但**提升到工作区根 `node_modules`**，
不在 `apps/server/node_modules` 下——所以按应用目录去找会以为没装。

⚠️ **依赖提升属于实现细节**：建议补一条
`pnpm --filter @knowledge-hub/server add ioredis`
把它显式声明为直接依赖，避免以后提升策略变化导致运行时才炸。
（本次尝试执行时被沙箱的批量删除保护拦截，未成功，留待后续。）

## 【易错】Worker 的连接要关掉重试上限

```ts
connection: { host, port, maxRetriesPerRequest: null }
```

不设的话，长时间阻塞的任务会被连接超时打断。这是 BullMQ 对 Worker 的硬性要求。

## 相对参考项目修掉的缺陷

| 参考项目 v3 | 本项目 |
| :--- | :--- |
| 消费失败 `nack(requeue=false)`，无 DLX 无重试 → 一次超时该文档索引**永久丢失** | 失败抛错 → `attempts=3` + 指数退避；失败任务保留在 Redis 便于排查 |
| 单篇失败只打日志继续，整批仍算成功 | `indexDocuments` 隔离单篇失败后**汇总抛出**，让整批重试（管线幂等，安全） |
| 只有「发布后自动投递」，换模型后无法重建存量 | 新增 `POST /rag/reindex` |

## 验证

- 单测 12 条（Worker 6 + Publisher 3 + DocumentService 3），全 fake，**不依赖 Redis/PG/ES**
- 端到端：起 Redis → 入队 4 篇 → Worker 消费 → 重建成功 4 篇 → ES 块数仍为 4（幂等无重复）
