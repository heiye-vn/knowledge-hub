# 索引失败补偿与可见性巡检

> 代码路径：`apps/server/src/indexing/`（`index-outbox.service.ts` / `index-outbox.worker.ts` / `visibility-patrol.service.ts`）
> 接口：`GET /indexing/outbox/stats`、`POST /indexing/patrol/run`（均需管理员）

## 一、要解决的问题

**现象**：PostgreSQL 与 ES / Neo4j 无法共享事务。文档发布成功后，若向量索引写入失败，
此前只打一条 error 日志——文档已是 `Published`，但检索不到，行为上等同"静默丢数据"；
审核通过、归档清理同样存在这个窗口。

**原因**：跨系统写入没有补偿机制，人工 `POST /rag/reindex` 是唯一兜底，
既要求有人看日志，也要求事后记得处理。

**解法**：失败任务落 `kh_index_outbox`（PG 表），后台 Worker 按退避重放。
不用 BullMQ 承载补偿——补偿本身要覆盖"Redis 不可用"的场景，用队列会形成
"队列挂了就无法补偿队列故障"的死循环。

## 二、表结构与合并语义【易错】

```sql
CREATE UNIQUE INDEX uq_kh_index_outbox_pending
  ON kh_index_outbox(document_id, target, operation)
  WHERE status IN ('pending', 'retry');
```

- **部分唯一索引**：只约束未完成任务，允许同一文档同一目标保留多条 `succeeded` / `dead` 历史；
- `record()` 用 `ON CONFLICT ... DO UPDATE SET last_error`：同一故障在短时间内重复触发
  （例如一次发布连写三条索引都失败）只保留一条待办，不放大扫描量。

**退避**：`backoff = 30000 * 2^(attempts-1)`，封顶 1 小时；达到 `INDEX_OUTBOX_MAX_ATTEMPTS`
（默认 8）转 `dead` 并打 error 日志，不再自动重试。

## 三、四类补偿目标

| target | upsert | delete |
| :--- | :--- | :--- |
| `rag` | `RagOrchestrator.indexDocument`（先删旧块再写，幂等） | `deleteDocument` |
| `search` | `SearchIndexService.indexDocument` | `deleteDocument` |
| `kg` | `KgBuildPublisher.enqueueBuildByDocIds`（`null` 视为失败，留待重试） | `enqueueDeleteByDocIds` |
| `visibility` | 三套索引并发 `updateVisibility`（无 delete 语义） | — |

## 四、可见性巡检：以写代检

`VisibilityPatrolService` 每 30 分钟分页扫已发布文档，把 PG 的
`is_public / team_id / author_id` 重新写回 `kh_chunk`、`kh_document` 与 Neo4j。

- **不做差异比对**：读三套索引再比对的成本高于直接覆盖，且覆盖天然幂等；
- **单篇失败不中断**：写 outbox 后继续下一篇，一轮结束输出 `scanned / synced / failed`；
- **可关不可删**：`VISIBILITY_PATROL_ENABLED=false` 关闭定时器，管理员仍可
  `POST /indexing/patrol/run` 手动触发。

## 五、为什么模块拆成两个

`DocumentModule` 需要 `IndexOutboxService` 记录失败，而 Worker 又需要
`DocumentService.loadForIndex` 加载待补偿文档——放在同一模块会成环。

拆成 `IndexOutboxModule`（只读写表，无业务依赖）与 `IndexMaintenanceModule`
（Worker + 巡检 + 管理入口，依赖 `DocumentModule`）后，依赖方向保持单向。

## 六、验证方式

- 单测：`pnpm --filter @knowledge-hub/server exec vitest run src/indexing`
  （service 6 条 + worker 5 条 + patrol 2 条）；
- 手工：文档发布失败后查 `GET /indexing/outbox/stats` 看 `pending`，
  等一个扫描周期（默认 60s）后应转 `succeeded`；
- 巡检：`POST /indexing/patrol/run` 返回 `{ scanned, synced, failed }`。

## 七、已知局限

- 补偿是**轮询**（默认 60s 一周期），不是实时；发布后最坏等一个周期才自愈。
- 单实例串行处理，多实例部署时同一任务可能被两个进程同时取到
  （`findDue` 未加 `FOR UPDATE SKIP LOCKED`）。当前定位单实例，暂不改；
  多实例前需补行级锁或任务抢占字段。
- `dead` 任务只告警不自动清理，需要人工介入（接口只提供统计，未做重放按钮）。
