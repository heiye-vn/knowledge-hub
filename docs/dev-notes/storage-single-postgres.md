# 存储切换：PG + Mongo 双库 → 单 PostgreSQL

> 完成时间：2026-09-20
> 类型：功能模块 · 存储架构（同步登记 [reference-mapping.md](../reference-mapping.md) 分叉）
> 代码路径：`document/entities/document-content.entity.ts`（新增）、`document.service.ts`（6 处 Mongo 调用改造）、
> `kg/kg-build.worker.ts`、`app/document/kg` 三个 module、`init-scripts/postgresql/01-init.sql`、`docker-compose.yml`

## 覆盖范围

文档正文的存储从 MongoDB `document_content` 集合迁至 PostgreSQL `kh_document_content` 表；
`kh_document.content_id` 列删除；Mongoose 依赖、Mongo 容器（mongodb + mongo-express）、
数据卷与初始化脚本整体下线。

## 为什么切（决策依据）

Mongo 当初的定位是「chunks 富文本 + chat_histories + 灵活 schema」，现实演化：
- chunks → 已落 ES（`kh_chunk`，IK + dense_vector）
- chat_histories → 未启动
- 实际只剩 `document_content` 一个集合、7 个字段、零 schema 灵活性需求

→ 为一个集合维护一整套独立数据库（容器、连接池、双写补偿、心智负担）得不偿失。

## 方案选择：独立表（B）而非 kh_document 加列（A）

- A（加 content 列）：改动最小，但 `SELECT *` / 列表查询随时可能拖出几 MB 正文
- B（独立 1:1 表）✅：与原 Mongo 形状一致（正文单独成行），列表查询不碰正文表

【易错】刻意**不建 ORM 级 @OneToOne**：与 `kh_document` 的 `category_id`/`team_id`
一样只作裸列，避免 eager/lazy 加载语义混入——两表都按 `documentId` 直查；
外键约束放在 DDL 层（`ON DELETE CASCADE`）。

## 关键改动

1. **create 简化（最大收益）**：原「先写 Mongo 拿 `_id` → 写 PG → PG 失败补偿删 Mongo」
   → 单库 `em.transaction()` 写两表，要么全成要么全无，补偿逻辑整体删除。
2. `kh_document.content_id` 列删除（实体属性 + DDL + init.sql 同步）。
3. 正文读取统一：service 内 `loadContent(documentId)` 私有方法；kg worker 内联同形查询。
4. 接口契约变化：`POST /documents`、`GET /documents/:id` 响应中不再有 `contentId` 字段
   （其余不变；Apifox 集合未引用该字段，无需改）。

## 【易错】em.update() 不更新 @UpdateDateColumn

只改 summary / 软删正文的分支用 `em.update()`（不走实体生命周期），
`@UpdateDateColumn` **不会自动更新**，需手动带 `updatedAt: new Date()`。
用 `findOne + save` 则无此问题（但多一次查询）。

## 【实录】并行 Edit 同一文件互相覆盖

现象：同一条消息里对 `document.service.ts` 发多个 Edit，**全部报 Successfully**，
但部分修改丢失：文件成混合体（imports 旧 + create 新 + findOne 旧），
`publish` 甚至调用了已被覆盖掉的 `loadContent` 方法（编译必然失败）。
原因：Edit 是「读-改-写」非原子操作，同文件并行时后写覆盖先写。
解法：同一文件的改动要么串行（一条消息只发一个 Edit），要么 Read 后 Write 全量重写。
验证：改完立即 `grep contentModel|mongoose` 确认清零，typecheck 兜底。

## 数据处理（本次为清空重建，业务数据由用户自行创建）

- PG：`DROP COLUMN IF EXISTS content_id` + 建 `kh_document_content` + `TRUNCATE kh_document CASCADE`
- ES 派生数据：`kh_chunk`/`kh_document` 执行 `_delete_by_query match_all`
  （PG 清空后旧索引成孤儿，会污染检索结果）
- Neo4j 派生数据：`MATCH (n) DETACH DELETE n`（保留唯一约束）
- 已删容器：`knowledge_hub_mongodb` / `knowledge_hub_mongo_express` + `volumes/mongo` + `init-scripts/mongodb`

## 已知局限与后续待办

- `pnpm install`（更新 lockfile 移除 mongoose）被沙箱 safe-delete 拦截（`_tmp_` 临时目录
  超 50 项阈值，按回合累计），待下个回合重跑；node_modules 现状不影响运行与测试，
  仅 lockfile 有冗余条目
- 若未来做真实数据迁移（非清空重建），需补 Mongo → PG 搬数脚本
