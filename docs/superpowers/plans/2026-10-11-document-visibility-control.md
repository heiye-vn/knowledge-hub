# 文档检索可见性控制（feat-v15）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 knowledge-hub 中落地端到端文档可见性控制（公开/团队/个人/管理员），覆盖 Postgres 文档增删改查、ES 全文检索、ES 向量切块 RAG、Neo4j 知识图谱及前端 5 个核心页面。

**架构：** 新建 `document-access.ts` 集中抽象作用域与过滤规则；`AuthUser` 注入当前用户所属团队；检索侧在召回前置阶段通过 `bool.filter` 和 Cypher 条件进行权限过滤；已发布文档变更可见性时通过 `RagOrchestrator` 并发就地更新三套索引。

**技术栈：** NestJS, TypeScript (原生 ESM), TypeORM (PostgreSQL), Elasticsearch (8.17 + IK), Neo4j (Cypher), React + Ant Design, Vitest.

**规格：** [docs/superpowers/specs/2026-10-11-document-visibility-control-design.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/superpowers/specs/2026-10-11-document-visibility-control-design.md)

## 全局约束

- 运行时环境：Node.js 原生 ESM 模式，代码中本包内相对导入必须带有 `.js` 后缀。
- ES 字段命名规范：统一遵循项目内部的 `snake_case`（`is_public`、`team_id`、`author_id`）。
- 权限隔离与无副作用：检索打分只在 `must` 中计算，可见性规则一律挂在 `filter` 上下文，不影响 BM25/向量相关度分数。
- 频繁 Commit：每个任务完成后必须执行测试并提交 Git commit。

---

### 任务 1：用户与团队域扩展（AuthUser、TeamService、TeamController、UserService）

**文件：**
- 修改：`apps/server/src/auth/auth-user.interface.ts`
- 修改：`apps/server/src/team/team.service.ts`
- 修改：`apps/server/src/team/team.controller.ts`
- 修改：`apps/server/src/user/user.module.ts`
- 修改：`apps/server/src/user/user.service.ts`

- [ ] **步骤 1：扩展 `AuthUser` 接口**
  在 `apps/server/src/auth/auth-user.interface.ts` 中为 `AuthUser` 增加 `teamIds: string[]` 字段。

- [ ] **步骤 2：在 `TeamService` 中实现反查与个人团队方法**
  - 实现 `listAccessibleTeamIds(userId: string): Promise<string[]>`：联查 `kh_team_member` 与 `kh_team.leader_id`，去重并过滤 `deleted = false`。
  - 实现 `listMine(userId: string): Promise<TeamEntity[]>`：查询用户所在有效团队列表。

- [ ] **步骤 3：在 `TeamController` 中增加 `mine` 接口**
  增加 `@Get('mine') listMine(@CurrentUser() user: AuthUser)` 接口。

- [ ] **步骤 4：在 `UserService` 中注入 `TeamService` 并装配 `teamIds`**
  - `UserModule` 导入 `TeamModule`；
  - `toAuthUser`、`buildAuthUser`、`validateCredentials` 装配 `teamIds: teamIds.map(String)`。

- [ ] **步骤 5：运行测试验证并 Commit**
  运行：`pnpm --filter server test src/team src/user src/auth`
  Commit：`git commit -m "feat(auth): AuthUser 挂载团队 ID 并在 TeamService 增加反查与 mine 接口"`

---

### 任务 2：新建核心权限抽象模块与单元测试（document-access）

**文件：**
- 创建：`apps/server/src/document/document-access.ts`
- 创建：`apps/server/src/document/document-access.spec.ts`

- [ ] **步骤 1：编写失败的单元测试 `document-access.spec.ts`**
  测试用例覆盖：
  - `accessFromUser`（普通用户提取 userId 与 teamIds，管理员/审核员 unrestricted=true）；
  - `canReadDocument`（本人可读、公开可读、同团队可读、未发布拦截、管理员通配）；
  - `canWriteDocument`（作者可写、管理员可写、其他人不可写）；
  - `esVisibilityFilter`（unrestricted 返回 null，普通用户生成 should 子句）；
  - `wrapEsQuery`（无 filter 原样返回，有 filter 包装为 bool.must + bool.filter）；
  - `neo4jAccessParams` 与 `neo4jDocumentAccessWhere`（生成正确的 Cypher 参数与子句）。

- [ ] **步骤 2：运行测试验证失败**
  运行：`pnpm --filter server test src/document/document-access.spec.ts`
  预期：FAIL（模块尚未创建）

- [ ] **步骤 3：实现 `document-access.ts`**
  实现上述所有访问控制函数与常量（采用项目既有的 snake_case 字段映射）。

- [ ] **步骤 4：运行测试验证通过**
  运行：`pnpm --filter server test src/document/document-access.spec.ts`
  预期：PASS

- [ ] **步骤 5：Commit**
  ```bash
  git add apps/server/src/document/document-access.ts apps/server/src/document/document-access.spec.ts
  git commit -m "feat(document): 新增文档访问控制与跨存储过滤工具 document-access"
  ```

---

### 任务 3：文档服务与控制器改造（列表/详情鉴权、写守卫、可见性变更识别）

**文件：**
- 修改：`apps/server/src/document/document.service.ts`
- 修改：`apps/server/src/document/document.controller.ts`

- [ ] **步骤 1：改造 `DocumentService.findAll` 拼接可见性 SQL**
  入参增加 `user: AuthUser`，利用 `accessFromUser(user)` 判定，非 unrestricted 时动态拼接：
  `(doc.author_id = :me OR (doc.status = :published AND (doc.is_public = true OR doc.team_id IN (:...teamIds))))`。

- [ ] **步骤 2：改造 `DocumentService.findOne` 增加读取鉴权**
  增加 `user?: AuthUser`，调用 `canReadDocument`，无权则抛出 `ForbiddenException('无权查看该文档')`。

- [ ] **步骤 3：增加 `assertWritable` 写权限守卫**
  在 `update`、`publish`、`archive`、`saveDraft`、`remove` 方法入口校验 `canWriteDocument(doc, actor)`。

- [ ] **步骤 4：识别可见性变更并触发管线同步**
  在 `update` 方法比对 `isPublic` 与 `teamId`，若已发布且可见性变更，调用 `this.ragOrchestrator.updateVisibility(saved)`。

- [ ] **步骤 5：改造 `DocumentController` 透传 `@CurrentUser() user`**
  在 `findAll`、`findOne`、`publish`、`archive`、`saveDraft`、`remove` 接口注入当前用户并透传。

- [ ] **步骤 6：运行测试验证并 Commit**
  运行：`pnpm --filter server test src/document`
  Commit：`git commit -m "feat(document): 文档列表/详情接入可见性过滤，写操作增加作者鉴权与变更感知"`

---

### 任务 4：Elasticsearch 全文索引就地更新与检索可见性改造（search）

**文件：**
- 修改：`apps/server/src/search/search-index.service.ts`
- 修改：`apps/server/src/search/search.controller.ts`
- 修改：`apps/server/src/search/dto/document-search.dto.ts`

- [ ] **步骤 1：在 `SearchIndexService` 中增加 `updateVisibility`**
  实现 `updateVisibility(documentId: string, vis: { isPublic: boolean; teamId: string | null; authorId: string | null })`，使用 `client.update` 局部更新 `is_public`、`team_id`、`author_id`。

- [ ] **步骤 2：在 `SearchIndexService.search` 中集成可见性过滤**
  入参接收 `scope?: DocumentAccessScope`，使用 `esVisibilityFilter` 构建子句并追加到 `filters` 中；出参 `toSearchHit` 补齐 `isPublic` 与 `teamId`。

- [ ] **步骤 3：改造 `SearchController` 透传用户 scope**
  在 `POST /search/documents` 与 `GET /search/documents` 中注入 `@CurrentUser() user: AuthUser` 并转为 `scope` 传给 service。

- [ ] **步骤 4：运行测试验证并 Commit**
  运行：`pnpm --filter server test src/search`
  Commit：`git commit -m "feat(search): kh_document 搜索索引增加可见性过滤与局部更新 updateVisibility"`

---

### 任务 5：RAG 向量索引就地更新与混合检索可见性改造（rag & ai）

**文件：**
- 修改：`apps/server/src/rag/vector-index.service.ts`
- 修改：`apps/server/src/rag/retrieval.service.ts`
- 修改：`apps/server/src/rag/search.controller.ts`
- 修改：`apps/server/src/rag/rag.orchestrator.ts`
- 修改：`apps/server/src/ai/ai-chat.service.ts`
- 修改：`apps/server/src/ai/ai-stream.service.ts`

- [ ] **步骤 1：在 `VectorIndexService` 中补全字段与 `updateVisibility`**
  - `buildDocMap` 补全 `is_public: chunk.isPublic ?? false`；
  - 实现 `updateVisibility(documentId, vis)`，调用 `client.updateByQuery` 执行 Painless 脚本批量更新 chunk 的 `is_public`、`team_id`、`author_id`。

- [ ] **步骤 2：在 `RetrievalService` 中注入可见性准入过滤**
  - `search` 参数增加 `scope?: DocumentAccessScope`；
  - `runKeywordSearch`：使用 `wrapEsQuery`，业务 query 放 `must`，可见性放 `filter`；
  - `runVectorSearch`：在 `knn.filter` 中注入 `esVisibilityFilter`；
  - 保证进入 RRF 融合与 Rerank 的候选切块全部满足可见性约束。

- [ ] **步骤 3：在 `RagOrchestrator` 中实现 `updateVisibility` 编排**
  实现并发调用 `searchIndexService.updateVisibility`、`vectorIndexService.updateVisibility` 和 `graphBuildService.updateVisibility`。

- [ ] **步骤 4：AI 对话与 RAG 检索透传用户 scope**
  - `rag/search.controller.ts` 注入 `@CurrentUser() user: AuthUser` 传入 `retrieval.search`；
  - `ai-chat.service.ts` 与 `ai-stream.service.ts` 在检索时透传用户的 `scope`。

- [ ] **步骤 5：运行测试验证并 Commit**
  运行：`pnpm --filter server test src/rag src/ai`
  Commit：`git commit -m "feat(rag): RAG 混合检索增加权限准入过滤，向量块支持 updateVisibility 原地更新"`

---

### 任务 6：Neo4j 知识图谱就地更新与穿透可见性检索（kg）

**文件：**
- 修改：`apps/server/src/kg/graph-build.service.ts`
- 修改：`apps/server/src/kg/kg.controller.ts`

- [ ] **步骤 1：在 `GraphBuildService` 中实现 `updateVisibility`**
  执行 Cypher：
  `MATCH (d:KnowledgeDocument {id: $id}) SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId, d.updatedAt = $now`。

- [ ] **步骤 2：知识图谱查询方法注入 `neo4jDocumentAccessWhere`**
  改造 `getOverview`、`searchGraph`、`listNodes`、`listEdges`：
  - 文档节点按 `neo4jDocumentAccessWhere('d')` 过滤；
  - 实体节点按 `MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity) WHERE neo4jDocumentAccessWhere('d')` 穿透过滤；
  - 关系边按双端实体均属于可见文档穿透过滤。

- [ ] **步骤 3：在 `KgController` 中透传 `@CurrentUser() user`**
  各查询端点传入 `accessFromUser(user)`。

- [ ] **步骤 4：运行测试验证并 Commit**
  运行：`pnpm --filter server test src/kg`
  Commit：`git commit -m "feat(kg): Neo4j 知识图谱接入可见性穿透过滤与节点属性原地更新"`

---

### 任务 7：服务端整体自动化测试回归

- [ ] **步骤 1：运行服务端全量测试**
  运行：`pnpm --filter server test`
  预期：全部现有单元测试及新增测试 100% PASS。

- [ ] **步骤 2：运行类型检查与 linter**
  运行：`pnpm --filter server typecheck`
  预期：0 类型报错。

---

### 任务 8：前端类型、工具函数与 API 层扩展（apps/web）

**文件：**
- 修改：`apps/web/src/types.ts`
- 修改：`apps/web/src/utils.ts`
- 修改：`apps/web/src/api/index.ts`

- [ ] **步骤 1：更新 `types.ts`**
  - `AuthUser` 扩展 `teamIds?: string[]`；
  - `SearchHit` 扩展 `teamId?: string | null`、`isPublic?: boolean | null`；
  - 增加 `TeamTreeNode` 类型定义。

- [ ] **步骤 2：更新 `utils.ts`**
  - 实现 `canWriteDocument(user, doc)`；
  - 实现 `visibilityMeta(doc)`（返回 label 和 Tag 颜色）；
  - 实现 `flattenTeams(tree)`。

- [ ] **步骤 3：更新 `api/index.ts`**
  - 补齐 `teamApi.mine()` 方法与 `teamApi.tree()` 类型定义。

- [ ] **步骤 4：Commit**
  ```bash
  git add apps/web/src/types.ts apps/web/src/utils.ts apps/web/src/api/index.ts
  git commit -m "feat(web): 扩展前端可见性类型定义、工具函数与团队 API"
  ```

---

### 任务 9：前端页面对接与可见性交互升级（apps/web）

**文件：**
- 修改：`apps/web/src/pages/DocumentEditPage.tsx`
- 修改：`apps/web/src/pages/DocumentsPage.tsx`
- 修改：`apps/web/src/pages/SearchPage.tsx`
- 修改：`apps/web/src/pages/GraphPage.tsx`
- 修改：`apps/web/src/pages/DocumentDetailPage.tsx`

- [ ] **步骤 1：改造 `DocumentEditPage.tsx`**
  - 非作者/非管理员禁止编辑（403 友好提示）；
  - 加载团队选项（普通用户走 `teamApi.mine`，管理员走 `teamApi.tree` 打平）；
  - 表单增加 `isPublic` 与 `teamId` 控件及辅助说明；
  - 默认 `isPublic: false`。

- [ ] **步骤 2：改造 `DocumentsPage.tsx`**
  - 表格增加「可见性」Tag 列；
  - 操作栏「编辑」「发布」由 `canWriteDocument` 保护；
  - 增加「仅我的」复选框。

- [ ] **步骤 3：改造 `SearchPage.tsx` 与 `GraphPage.tsx`**
  - 结果卡片展示可见性 Tag；
  - 移除无意义的客户端 `authorId` 输入框；
  - 增加权限范围提示文案。

- [ ] **步骤 4：改造 `DocumentDetailPage.tsx`**
  - 展示文档可见性 Tag；编辑/发布按钮由 `canWriteDocument` 保护。

- [ ] **步骤 5：Commit**
  ```bash
  git add apps/web/src/pages/
  git commit -m "feat(web): 文档编辑/列表/搜索/图谱页面全面对接可见性控制与交互"
  ```

---

### 任务 10：全工程构建与 E2E 验证

- [ ] **步骤 1：前端编译构建验证**
  运行：`pnpm --filter web build`
  预期：TypeScript 编译与 Vite build 成功。

- [ ] **步骤 2：全仓库依赖与编译验证**
  运行：`pnpm build`
  预期：整包构建无报错。

- [ ] **步骤 3：最终成果归档与 Git 记录**
  更新 `contexts/context.md` 与 `docs/reference-mapping.md` 登记本次 feat-v15 分支完成的功能与分叉对照。
