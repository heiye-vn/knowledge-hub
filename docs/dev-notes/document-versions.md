# 文档历史版本（feat-v21）

> 模块范围：`kh_document_version` 建表、正文快照写入（创建 / 编辑 / 异步导入）、版本列表/详情/回滚接口与前端页面。
> 代码路径：`apps/server/src/document/document-version.service.ts`、`document.service.ts`（create / update）、
> `document-import.service.ts`（导入完成）、`document-engagement.controller.ts`、`apps/web/src/pages/DocumentVersionsPage.tsx`。

## 关键决策

### 1. 版本号沿用正文表的 `version`，不另起计数

`kh_document_content.version` 本来就随每次正文变更 +1，直接拿它当版本号：
- 创建时写入 v1 快照；
- 编辑时先读到旧版本号 `previousVersion`，新版本号 = 旧 + 1；
- 回滚复用 `DocumentService.update`，同样走一次 +1，因此天然产生「新版本」而不是覆盖历史。

【易错】存量文档（feat-v21 之前创建）没有版本表记录。首次编辑时先补记「改之前的旧稿」，再记新版本；
补记的版本号可能从 5 开始而不是 1，这是真实历史，不做重排。

### 2. 正文与快照同事务

基线实现正文在 Mongo、版本表在 PG，跨库无法原子。主项目正文在 `kh_document_content`，与版本表同库：
`update()` 里用 `em.transaction` 包住「行锁读正文 → 改正文 → 写快照 → 改元数据」，
唯一键 `(document_id, version)` 用 `orIgnore` 兜底并发重复写。

【实录】把正文更新和版本插入拆成两次非事务写入时，第二次失败会留下「内容已改、历史丢失」，
而且没有补偿入口能反推旧正文。必须同事务。

### 3. 列表不带正文，详情单独拉

版本列表只返回 id / version / title / summary / createdAt / createBy；
正文按 `GET /documents/:id/versions/:versionId` 单独取。长文档 × 几十个版本如果一次全量返回，响应体会到 MB 级。

### 4. 导入链路也要记 v1

主项目 v20 的 MinerU 异步导入是独立写入路径，不经过 `DocumentService.update`。
在导入完成事务里补 `recordInitial`，否则导入文档永远没有 v1，用户第一次编辑才突然出现两个版本。

### 5. 审核中禁止回滚

回滚调用 `update()`，而 `update()` 对 `PendingReview` 有「不可编辑」守卫，会直接 400。
前端版本页读取文档状态，审核中禁用回滚按钮并给出提示，避免用户点了才报错。

## 验证

- 单测：`document-version.service.spec.ts`（首改补旧稿、已有历史只记新版本、列表去正文、非作者 403、版本不存在 404）。
- 联调：创建 → 编辑两次 → 列表 3 条 → 详情含 v1 正文 → 回滚 v1 → 列表 4 条且正文恢复 → 非作者 403。
- 并发验证：同一文档同时发起两次 `PATCH`，版本列表为 `[3, 2, 1]`，两次编辑的快照都在，正文为后提交者。
  原因是 `update()` 在事务内对 `kh_document_content` 行加了 `pessimistic_write`，同一文档的正文/版本写入天然串行。
- 浏览器：详情页「版本」→ 左侧版本列表 → 切换预览 → 回滚 Popconfirm → 列表刷新到 v5。

## 已知局限

- 只记录正文/标题/摘要，不记录标签、分类、可见性等元数据；回滚是「内容回滚」而非「整篇快照回滚」。
- 并发编辑不会丢历史，但最终正文遵循「最后提交者获胜」，没有冲突提示或合并能力。
- 版本表不随文档物理删除清理（当前只有软删），后续做归档清理时需按 `document_id` 级联。
