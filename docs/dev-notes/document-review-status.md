# 文档审核机制与四种状态流转（feat-v6）

> **模块范围**：文档从「草稿」到「下线」的全生命周期状态机，配套发布审核流水与索引联动。
>
> **代码路径**
> - `apps/server/src/document/document-status.ts` —— 状态枚举 + 中文标签 + 五个守卫函数
> - `apps/server/src/document/document-review.service.ts` + `entities/document-review.entity.ts` —— `kh_document_review` 审核流水
> - `apps/server/src/document/document.service.ts` —— 状态迁移与索引联动（`buildIndexes` / `cleanupIndexes`）
> - `apps/server/src/document/document.controller.ts` —— 9 个新端点
> - `init-scripts/postgresql/01-init.sql` —— 建表与部分唯一索引

---

## 一、 状态定义与索引写入规则

| 枚举值 | 状态 | 是否进索引 |
| :--- | :--- | :--- |
| `0` | Draft 草稿 | ❌ |
| `1` | Published 已发布 | ✅ 三条：RAG `kh_chunk` / 搜索 `kh_document` / 图谱 Neo4j |
| `2` | Archived 已归档（终态） | ❌ 归档时清理，正文保留 |
| `3` | PendingReview 待审核 | ❌ 审核通过后才建 |

**索引写入的唯一入口是 Published**。这不是洁癖：草稿里可能夹着未脱密的客户资料，
一旦进索引，问答会把它原样吐出来，且责任无法追溯。

---

## 二、 关键决策与取舍

### 1. 职责单向：审核服务只管自己那张表

状态迁移（改 `kh_document.status`）与索引联动全部留在 `DocumentService`，
审核服务只负责 `kh_document_review` 的读写。

- **为什么**：两边都要读写文档表，双向依赖要么循环 DI（`forwardRef`），
  要么把「改状态 + 建索引」的逻辑复制两份。状态迁移必须连带索引联动，
  而索引编排能力在 `DocumentService`，所以让它当唯一的编排者。
- **代价**：`approve / reject` 端点落在 `DocumentService` 上（审核服务只有查询端点）。

### 2. 审核流水与文档状态同事务，索引构建放事务外

```ts
const { review, doc } = await this.em.transaction(async (tx) => {
  const approved = await this.reviewService.approve(taskId, ..., tx); // 审核流水
  target.status = DocumentStatus.Published;                            // 文档状态
  ...
});
const indexes = await this.buildIndexes(doc, content);                 // 索引在事务外
```

- 两张表同库，**事务能覆盖的部分就别留给补偿**。
- ES / Neo4j 无法与 PG 共享事务，索引失败时事务已提交：文档处于 Published 但没索引。
  这是**可恢复**的状态——`POST /rag/reindex` 扫的就是「已发布且未删除」的文档，直接兜底。
- 反过来（先建索引再提交事务）更糟：索引写成功了但状态没变，文档在索引里却查不到来源。

### 3. 归档定为终态

基线实现把 `Archived` 也放进「可发布」集合，且需审模式下会漏到「免审直发」分支
——归档文档能绕过审核直接上线。本项目两种模式都拒绝，后门从源头堵死。

### 4. 「同一文档只能有一条待审」下沉到数据库

```sql
CREATE UNIQUE INDEX uq_kh_document_review_pending
  ON kh_document_review(document_id) WHERE review_result IS NULL;
```

应用层 `findOne` 判空挡不住并发（两个请求同时查到「没有待审」，然后都插入）。
用**部分唯一索引**兜底，再把 PostgreSQL 的 `23505` 翻译成 400「该文档已有待审核任务」。
顺带它也是待办列表的查询索引——只装待审行，历史越久越不吃亏。

### 5. 需审模式下「已发布文档改正文」不立即重建索引

改稿后到审核通过前，文档仍是 Published 但索引是旧的。这是**有意的窗口期**：
若立刻重建，新内容在还没审核时就可被检索到，审核门禁形同虚设。
免审模式没有这个顾虑，所以直接重建。

---

## 三、 易错点

- 【易错】**路由顺序**：`GET documents/reviews/tasks`、`reviews/tasks/pending-count`
  必须声明在 `@Get(':id')` **之前**，否则被 `:id` 吃掉（Nest 按声明顺序匹配）。
  POST 类端点不与 `:id` 冲突，但一起放在前面更省心。
- 【易错】**`create` 建即发布也要建索引**。免审模式下 `status=1` 创建成功却不建索引，
  「Published 是唯一入口」这条规则就自己破了。
- 【易错】**`remove` 只在已发布时清索引**。草稿 / 待审 / 归档本来就不在索引里，
  无条件投递清理消息只是给 ES 和 Neo4j 增加无谓写放大。
- 【易错】**待审核文档禁止改正文 / 标题**（PATCH 返回 400）。否则审核员看到的
  与被审核通过的内容可能不是同一份。
- 【易错】**PATCH 不允许改 `status`**。直接改状态会留下「已发布但无索引」的脏状态，
  状态一律走 `publish` / `archive` / `save-draft` / 审核接口。

---

## 四、 如何验证

单元测试（不依赖 PG / ES，纯 fake）：

```bash
pnpm --filter @knowledge-hub/server exec vitest run src/document/document.service.spec.ts
# 27 passed：状态守卫 / 双索引 / 审核流程 / 归档下架 / 编辑门禁
```

本地联调（默认 `DOCUMENT_REQUIRE_APPROVAL=true`）：

```bash
# 1. 建草稿 → 2. publish（转 3，不建索引）
curl -X PUT localhost:3000/documents/{id}/publish
# 3. 取任务 ID
curl -s localhost:3000/documents/{id}/reviews/current | jq .id
# 4. 审核通过 → status=1 + indexed=true
curl -X POST localhost:3000/documents/reviews/tasks/{taskId}/approve \
  -H 'Content-Type: application/json' \
  -d '{"reviewComment":"符合规范","reviewerId":"20001","reviewerName":"张三"}'
# 5. 归档 → status=2 + vectorsCleaned=true
curl -X PUT localhost:3000/documents/{id}/archive
```

验证要点：`publish` 后 `GET /documents/{id}` 的 `status` 应为 `3`，且在审核通过前
用正文里的关键词搜不到该文档；`approve` 后才召回得到。

---

## 五、 已知局限与后续待办

- **审核人身份靠调用方传入**：项目尚未接入鉴权，服务层无从得知操作人，
  `reviewerId` / `reviewerName` 暂由请求体传入 —— **任何人都能 approve，无权限校验**。
  接入登录后应改为从登录态取值，DTO 这两个字段随之废弃。
- **索引失败无自动补偿**：靠 `POST /rag/reindex` 人工 / 定时兜底，没有失败任务表。
- **审核任务无撤回、无超时**：作者提交后只能等审核员处理，没有 withdraw 接口与超时策略。
- **归档不可恢复**：定为终态是产品决策（避免已下线文档被重新向量化），
  若日后要支持「重新上架」，需明确是否重新走审核。
- **审核记录无软删除**：`kh_document_review` 与文档生命周期绑定，文档硬删时需另行约定清理策略。
