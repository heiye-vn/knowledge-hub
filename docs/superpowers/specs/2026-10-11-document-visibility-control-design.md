# 文档检索可见性控制设计规格（feat-v15）

> **文档状态**：设计就绪 / 待实施
> **创建日期**：2026-10-11
> **关联分支**：`feat-v15`
> **关联模块**：`apps/server`（Auth / User / Team / Document / Rag / Search / Kg / Ai）、`apps/web`（DocumentEdit / Documents / Search / Graph）
> **参考基线**：`knowledge-hub-backend` 与 `knowledge-hub-frontend` 分支 `v15`
> **分叉对照**：详见 [docs/reference-mapping.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/reference-mapping.md)

---

## 1. 背景与核心目标

### 1.1 现状与痛点
在 `v14` 及更早版本中，文档混合检索（RAG）、全文搜索（ES `kh_document`）以及知识图谱检索（Neo4j）**均缺少数据权限控制**，任何登录用户均可查出知识库中所有已发布的文档及其切块，导致私有团队文档、企业敏感策略存在泄露风险。

### 1.2 目标与业务准则
1. **多层权限收敛**：统一在召回阶段实施可见性剪枝，覆盖 Postgres 文档元数据、ES 全文搜索、ES 向量/BM25 切块召回、Neo4j 知识图谱四大存储引擎。
2. **三态可见性规则**：
   - **公开**（`is_public = true` 且 `status = Published`）：全员登录可见；
   - **团队可见**（`team_id IN user.teamIds` 且 `status = Published`）：所属团队成员可见；
   - **仅自己**（`author_id = user.userId`）：作者本人无视发布状态全流程可见；
   - **管理权限放行**：拥有 `ROLE_ADMIN` 或 `ROLE_REVIEWER` 角色的用户无视团队与公开限制（`unrestricted = true`）。
3. **高效就地更新（In-place Update）**：当已发布文档仅修改公开性或归属团队时，只局部刷新三套索引的可见性字段，严禁重新触发分块、Embedding 或知识图谱大模型抽取。
4. **统一命名与风格**：ES 索引内一律统一使用 `snake_case`（`is_public`、`team_id`、`author_id`），由 `document-access.ts` 集中管理映射。
5. **端到端体验完整闭环**：前端编辑页提供可见性表单与团队选择，列表与搜索结果展示可见性 Badge，非作者/非管理员严禁编辑。

---

## 2. 架构设计与核心模块划分

### 2.1 整体时序与数据流

```
[前端请求]
    │ (携带 JWT Bearer Token)
    ▼
[JwtAuthGuard / JwtStrategy]
    │
    ▼
[UserService.buildAuthUser]
    │ ───> TeamService.listAccessibleTeamIds (查 kh_team_member ∪ kh_team.leader_id)
    ▼
[生成 AuthUser (携带 teamIds: string[])]
    │
    ▼
[Controller & Service]
    │ ───> accessFromUser(user) 构造 DocumentAccessScope
    ├───> Postgres SQL: (author_id = :me OR (status = 1 AND (is_public = true OR team_id IN (:...teamIds))))
    ├───> ES kh_document: bool.filter -> should: [is_public: true, author_id: me, team_id IN teamIds]
    ├───> ES kh_chunk: wrapEsQuery / knn.filter 注入可见性准入过滤
    ├───> Neo4j Cypher: ($unrestricted OR d.authorId = $me OR d.isPublic = true OR d.teamId IN $teamIds)
    └───> AI RAG Chat: 透传 user 上下文至检索服务
```

---

## 3. 后端详细设计（`apps/server`）

### 3.1 用户与团队域（`auth` / `user` / `team`）

1. **`AuthUser` 扩展**：
   - 在 `apps/server/src/auth/auth-user.interface.ts` 中增加字段：
     ```typescript
     export interface AuthUser {
       // ... 既有字段
       teamIds: string[]; // 用户所属团队 ID 列表（包含普通成员与团队负责人）
     }
     ```
2. **`TeamService` 增加反查与个人团队接口**：
   - `listAccessibleTeamIds(userId: string): Promise<string[]>`：
     - 查询 `kh_team_member.user_id = :userId`；
     - 查询 `kh_team.leader_id = :userId AND deleted = false`；
     - 合并两部分 teamId，转 string 去重，二次验证 `deleted = false`，返回有效 teamId 数组。
   - `listMine(userId: string): Promise<TeamEntity[]>`：
     - 调用 `listAccessibleTeamIds`，若为空返回 `[]`；
     - 按 `id IN (:...ids) AND deleted = false` 查询团队实体，按 `sort ASC, createdAt ASC` 排序。
3. **`TeamController` 接口扩展**：
   - 新增 `@Get('mine') listMine(@CurrentUser() user: AuthUser)` 接口，仅需登录态，无需 `system:team` 管理权限。
4. **`UserService` 依赖注入与装配**：
   - `UserModule` 导入 `TeamModule`，`UserService` 构造器注入 `TeamService`；
   - 在 `toAuthUser`、`buildAuthUser`、`validateCredentials` 统一装配 `teamIds`。

### 3.2 权限判定模块（`document/document-access.ts`）

创建纯函数模块，作为全系统的权限规则 SSOT：
- **`DocumentAccessScope`**：
  ```typescript
  export type DocumentAccessScope = {
    unrestricted: boolean; // ROLE_ADMIN || ROLE_REVIEWER
    userId: string;
    teamIds: string[];
  };
  ```
- **核心判定工具**：
  - `accessFromUser(user: AuthUser): DocumentAccessScope`
  - `canReadDocument(doc: Pick<DocumentEntity, 'authorId' | 'teamId' | 'isPublic' | 'status'>, scope: DocumentAccessScope): boolean`
  - `canWriteDocument(doc: Pick<DocumentEntity, 'authorId'>, user: AuthUser): boolean`（`ROLE_ADMIN` 优先，否则 `doc.authorId === user.userId`）
- **ES 查询封装**：
  - `esVisibilityFilter(scope: DocumentAccessScope, fields = { isPublic: 'is_public', authorId: 'author_id', teamId: 'team_id' })`：
    - `unrestricted = true` 时返回 `null`；
    - 否则返回 `{ bool: { should: [{ term: { [fields.isPublic]: true } }, { term: { [fields.authorId]: scope.userId } }, ...(scope.teamIds.length ? [{ terms: { [fields.teamId]: scope.teamIds } }] : [])], minimum_should_match: 1 } }`。
  - `wrapEsQuery(query: Record<string, unknown>, filter: Record<string, unknown> | null)`：
    - 若 `!filter` 返回 `query`；否则返回 `{ bool: { must: [query], filter: [filter] } }`。
- **Neo4j Cypher 注入器**：
  - `neo4jAccessParams(scope?: DocumentAccessScope)`
  - `neo4jDocumentAccessWhere(alias = 'd'): string`

### 3.3 文档服务与控制器（`document`）

1. **`findAll` 分页列表过滤**：
   - 增加 `user: AuthUser` 参数；
   - 若 `!scope.unrestricted`，按 `scope.teamIds.length` 动态追加 `qb.andWhere(...)`，排除无权查阅的文档。
2. **`findOne` 详情权限校验**：
   - 增加 `user?: AuthUser` 参数；
   - `canReadDocument(doc, accessFromUser(user))` 校验失败抛出 `ForbiddenException('无权查看该文档')`。
3. **写权限守卫 `assertWritable`**：
   - 覆盖 `update`、`publish`、`archive`、`saveDraft`、`remove`；
   - 非作者且非管理员拦截抛出 `ForbiddenException('无权修改该文档')`。
4. **可见性变更识别与就地更新**：
   - 在 `update` 方法比对 `isPublic` 与 `teamId`；
   - 若 `doc.status === DocumentStatus.Published && visibilityChanged`，调用 `ragOrchestrator.updateVisibility(saved)`。

### 3.4 三套索引的就地更新与检索过滤（`rag` / `search` / `kg`）

1. **`RagOrchestrator` 编排**：
   - 新增 `updateVisibility(doc: DocumentEntity): Promise<void>`，并发调用：
     - `searchIndexService.updateVisibility(doc.id, vis)`
     - `vectorIndexService.updateVisibility(doc.id, vis)`
     - `graphBuildService.updateVisibility(doc.id, vis)`
2. **全文搜索索引（ES `kh_document`）**：
   - `search-index.service.ts`：
     - 新增 `updateVisibility(documentId, vis)`：调用 `client.update` 局部更新 `is_public`、`team_id`、`author_id`；
     - `search` 方法入参接收 `scope?: DocumentAccessScope`，在 filters 中合并 `esVisibilityFilter`；
     - `toSearchHit` 出参补全 `teamId` 与 `isPublic` 供前端渲染。
   - `search.controller.ts`：注入 `@CurrentUser() user: AuthUser` 并转为 `scope` 传给 `search`。
3. **向量分块索引（ES `kh_chunk`）与检索**：
   - `vector-index.service.ts`：
     - `buildDocMap` 补全 `is_public: chunk.isPublic ?? false`；
     - 新增 `updateVisibility(documentId, vis)`：调用 `client.updateByQuery` 执行 Painless 脚本：
       `ctx._source.is_public = params.is_public; ctx._source.team_id = params.team_id; ctx._source.author_id = params.author_id;`
   - `retrieval.service.ts`：
     - `search` 方法参数增加 `scope?: DocumentAccessScope`；
     - `runKeywordSearch`：使用 `wrapEsQuery`，业务 query 放在 `must`，可见性放在 `filter`；
     - `runVectorSearch`：在 `knn.filter` 中注入 `esVisibilityFilter`。
   - `rag/search.controller.ts`：注入 `@CurrentUser() user: AuthUser` 传入 `retrieval.search`。
4. **知识图谱索引（Neo4j）**：
   - `graph-build.service.ts`：
     - 新增 `updateVisibility(documentId, vis)`：
       `MATCH (d:KnowledgeDocument {id: $id}) SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId, d.updatedAt = $now`；
     - `getOverview`、`searchGraph`、`listNodes`、`listEdges` 等查询接口传入 `scope`，利用 `neo4jDocumentAccessWhere` 穿透过滤文档节点、提及实体和关系边。
   - `kg.controller.ts`：查询接口统一注入 `@CurrentUser() user: AuthUser`。
5. **AI 对话透传（`ai`）**：
   - `ai-chat.service.ts` 与 `ai-stream.service.ts` 在调用 `retrieval.search` 时透传当前用户 scope。

---

## 4. 前端详细设计（`apps/web`）

### 4.1 类型与工具函数（`types.ts` & `utils.ts`）
- `types.ts`：
  - `AuthUser` 增加 `teamIds?: string[]`；
  - `SearchHit` 增加 `teamId?: string | null`、`isPublic?: boolean | null`；
  - 增加 `TeamTreeNode` 类型定义。
- `utils.ts`：
  - `canWriteDocument(user, doc)`：判断当前用户是否为作者或管理员；
  - `visibilityMeta(doc)`：根据 `isPublic` 与 `teamId` 返回 Tag 文本与色彩；
  - `flattenTeams(tree)`：将树形团队扁平化为一维下拉选项。
- `api/index.ts`：
  - 补齐 `teamApi.mine()` 与 `teamApi.tree()` 强类型。

### 4.2 页面与交互优化
- **`DocumentEditPage.tsx`**：
  - 若 `!canWriteDocument(user, doc)` 拦截渲染并提示 403 空状态；
  - 普通用户加载 `teamApi.mine()`，管理员加载 `teamApi.tree()` 打平列表；
  - 表单增加 `isPublic`（Switch）与 `teamId`（Select）控件；
  - 顶部增加规则指引提示条。
- **`DocumentsPage.tsx`**：
  - 表格「公开」列升级为「可见性」Tag 列；
  - 操作栏「编辑」「发布」由 `canWriteDocument` 保护；
  - 顶部查询区新增「仅我的」复选框。
- **`SearchPage.tsx` / `GraphPage.tsx`**：
  - 结果卡片渲染可见性 Tag；
  - 移除无意义的手动 `authorId` 搜索输入框；
  - 顶部显式展示“只会检索你有权限的文档”提示文案。

---

## 5. 验证标准与测试计划

1. **单元测试与集成测试（Vitest）**：
   - 编写 `document-access.spec.ts`：测试 `accessFromUser`、`canReadDocument`、`canWriteDocument`、`esVisibilityFilter`、`wrapEsQuery`、`neo4jDocumentAccessWhere`；
   - 运行既有测试套件 `pnpm test:server`，确保所有既有服务与测试 100% 通过；
2. **前后端联调测试**：
   - 使用普通用户 A 创建私有团队文档，验证同团队用户 B 可查，非团队用户 C 不可查；
   - 验证作者修改文档为公开后，无需重跑 Embedding，ES 与 Neo4j 秒级对用户 C 生效；
   - 验证 AI 问答与流式对话不会引用无权限团队的文档知识。
