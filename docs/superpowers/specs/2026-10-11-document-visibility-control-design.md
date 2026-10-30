# 文档检索可见性控制设计规格（feat-v15）

> **文档状态**：设计就绪 / 待实施
> **创建日期**：2026-10-11（同日评审修订 V2：对齐主项目代码现状——存量回填、mapping 迁移、is_public 装配链、kg 全量接口、上传默认公开、既有 filterClauses 架构）
> **关联分支**：`feat-v15`
> **关联模块**：`apps/server`（Auth / User / Team / Document / Rag / Search / Kg / Ai）、`apps/web`（DocumentEdit / Documents / Search / Graph）

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
    ├───> ES kh_chunk: 可见性子句并入既有 filterClauses（bool.filter / knn.filter），复用统一过滤通道
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
   - **装配方式（定稿）**：`toAuthUser` 保持同步签名，新增 `teamIds: string[]` 参数；由两个调用方 `buildAuthUser` 与 `validateCredentials` 先 `await listAccessibleTeamIds(userId)` 查好后传入。避免把 `toAuthUser` 改成 async 引发调用点连锁修改；
   - **性能取舍（有意）**：`buildAuthUser` 为每请求执行（JWT 校验链路），装配 `teamIds` 会给所有鉴权请求新增 2 条团队查询（成员表 + leader）。换取成员变动即时生效，与权限码每请求重算的既有策略一致。

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
  - **主路径约定**：`retrieval.service.ts` 已有统一过滤通道 `filterClauses`（`runKeywordSearch` 走 `bool.must + filter`、`runVectorSearch` 走 `knn.filter`），可见性子句由 `search()` 在 `buildFilters` 处**并入 `filterClauses`** 即可，三种 mode 一条代码路径，不重写检索内部结构。
  - `wrapEsQuery(query, filter)` 仅作为无既有过滤架构场景的兼容工具保留（文档级搜索直接可用），**不作为 RAG 检索的改造路径**。
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
   - 覆盖 `update`、`publish`、**`submitForReview`**、`archive`、**`saveAsDraft`**、`remove`（注意方法名以主项目实际为准：`saveAsDraft` 非 `saveDraft`，`submitForReview` 是独立于 publish 的审核提交旁路，必须一并守卫）；
   - 非作者且非管理员拦截抛出 `ForbiddenException('无权修改该文档')`；
   - 审核员的 `approveReview` / `rejectReview` 仍按既有 REVIEWER 角色鉴权，不纳入作者守卫。
4. **可见性变更识别与就地更新（排他顺序）**：
   - 在 `update` 方法比对 `isPublic` 与 `teamId`；
   - **先判内容重建、后判可见性就地更新，二者互斥**：内容变更且免审模式走整篇重建索引（重建本身写入最新 `is_public`），仅当「内容未变 && `doc.status === Published && visibilityChanged`」时才调用 `ragOrchestrator.updateVisibility(saved)`，避免同一次更新双写索引。
5. **既有测试同步**：`findAll` / `findOne` 加参后，`document.service.spec.ts` 等既有用例的入参 fake 需同步补充 `AuthUser`（typecheck 会拦截，但须列为任务避免临场返工）。

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
  - **mapping 迁移（必须）**：`kh-chunk.mapping.ts` 的 properties 增加 `is_public: { type: 'boolean' }`（只影响新建索引）；`ElasticsearchService`（或 `VectorIndexService` 初始化处）增加 `ensureVisibilityMapping`：启动时对已存在的 `kh_chunk` 索引执行 `putMapping` 补 `is_public`，否则存量部署的过滤全部失效。`kh_document` mapping 已含 `is_public`，无需处理。
  - **`is_public` 装配链（必须，三处）**：① `rag.types.ts` 的 `DocumentChunk` 接口增加 `isPublic?: boolean`（当前只有 `PipelineDocument` 有）；② `chunking.service.ts` 的 chunk 参数透传 `isPublic`；③ `rag.orchestrator.ts` 的 `chunkingService.chunk({...})` 调用装配 `isPublic: doc.isPublic`。缺一处则 `buildDocMap` 读到的永远是 `undefined`。
  - `vector-index.service.ts`：
    - `buildDocMap` 补全 `is_public: chunk.isPublic ?? false`；
    - 新增 `updateVisibility(documentId, vis)`：调用 `client.updateByQuery` 执行 Painless 脚本：
      `ctx._source.is_public = params.is_public; ctx._source.team_id = params.team_id; ctx._source.author_id = params.author_id;`
  - `retrieval.service.ts`：
    - `search` 方法参数增加 `scope?: DocumentAccessScope`，在 `buildFilters` 处把 `esVisibilityFilter(scope)` 产物**并入既有 `filterClauses`**（不重写 `runKeywordSearch` / `runVectorSearch` 的内部结构，keyword / vector / hybrid 三种 mode 自动同时生效）；
    - 进入 RRF 融合与 Rerank 的候选切块因此全部满足可见性约束，无需在融合后二次过滤。
  - `rag/search.controller.ts`：**GET 与 POST 两个路由**都注入 `@CurrentUser() user: AuthUser` 传入 `retrieval.search`。
4. **知识图谱索引（Neo4j）**：
   - `graph-build.service.ts`：
     - **写入侧**：`buildForDocument` 的文档节点 `SET` 补 `d.teamId = $teamId, d.isPublic = $isPublic`（当前只有 `authorId`/`status`/`tags`）；
     - 新增 `updateVisibility(documentId, vis)`：
       `MATCH (d:KnowledgeDocument {id: $id}) SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId, d.updatedAt = $now`；
     - **查询侧（全量 7 个接口，一个都不能漏）**：`getOverview`、**`getStats`**、**`listEntities`**、**`getNeighbors`**、`searchGraph`、`listNodes`、`listEdges` 全部传入 `scope`。统计数字只计可见文档，实体/邻居经 `MENTIONS` 路径穿透过滤；
     - 利用 `neo4jDocumentAccessWhere` 过滤文档节点、提及实体和关系边（`EXISTS { MATCH ... }` 子查询需 Neo4j 5+，实现前确认容器版本）。
   - `kg.controller.ts`：全部 7 个查询端点（`overview` / `stats` / `entities` / `neighbors` / `search` / `nodes` / `edges`）统一注入 `@CurrentUser() user: AuthUser` 并转为 `accessFromUser(user)`。
5. **AI 对话透传（`ai`）**：
   - `ai-chat.service.ts` 与 `ai-stream.service.ts` 在调用 `retrieval.search` 时透传当前用户 scope（`ai-stream` 中的 Bocha `web_search` 工具调用不涉及知识库，无需处理）。

### 3.5 存量数据迁移与回填（一次性系统增强）

存量 `kh_chunk` 数据块与 Neo4j 旧 `KnowledgeDocument` 节点**没有** `is_public` / `teamId` 值；可见性过滤一旦上线，`term: { is_public: true }` 不命中缺失字段，**历史已发布的公开文档会被全部误杀**（仅作者与管理员可见）。必须在启用过滤前完成回填：

1. **ES `kh_chunk` 回填**：按 PG `kh_document` 已发布文档（`deleted = false && status = Published`）逐文档执行 `updateByQuery`，把 `is_public` / `team_id` / `author_id` 写入对应 chunk（复用 `vectorIndexService.updateVisibility` 逐文档调用即可，全量文档数不大时无需专门的 bulk 脚本）。
2. **Neo4j 回填**：对每个已发布文档执行 `MATCH (d:KnowledgeDocument {id: $id}) SET d.isPublic = $isPublic, d.teamId = $teamId`（复用 `graphBuildService.updateVisibility`）。
3. **实现形态**：作为 `RagOrchestrator` 的一次性管理方法 + 启动幂等执行（先探测是否存在缺字段数据，有才回填；或做成手动触发脚本，在 dev-notes 记录执行方式）。回填失败不阻塞服务启动，只告警。

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
  - 顶部增加规则指引提示条（公开 → 全员；指定团队 → 团队可见；都不选 → 仅自己）。
- **`DocumentsPage.tsx`**：
  - 表格「公开」列升级为「可见性」Tag 列；
  - 操作栏「编辑」「发布」由 `canWriteDocument` 保护；
  - 顶部查询区新增「仅我的」复选框（后端 `findAll` 已支持显式 `authorId` 筛选，直接复用）；
  - **移除上传时的 `form.append('isPublic', 'true')`**（当前 `DocumentsPage.tsx:78` 强制公开，会把「默认仅自己可见」的规则击穿）。
- **`SearchPage.tsx` / `GraphPage.tsx`**：
  - 结果卡片渲染可见性 Tag；
  - 移除无意义的手动 `authorId` 搜索输入框（已由后端 scope 接管）；
  - 顶部显式展示“只会检索你有权限的文档”提示文案。
- **`DashboardPage.tsx`**：
  - 「最近文档」表格增加可见性 Tag 列。
- **`AppLayout.tsx` / `ProfilePage.tsx`**：
  - 顶栏展示当前用户所属团队 Tag（取前 2 个），个人页展示完整团队列表，用于快速确认可见范围。

---

## 5. 验证标准与测试计划

**命令约定（务必按此执行，避免 filter 名与类型盲区）**：
- 全量：`pnpm test:server`、`pnpm typecheck:server`（根脚本，typecheck 含 spec，`nest build` 有类型盲区）
- 单测定向：`pnpm --filter @knowledge-hub/server exec vitest run <path>`（结尾出现 vitest not found 属已知噪音）
- 前端：`pnpm typecheck:web`、`pnpm build:web`

1. **单元测试与集成测试（Vitest）**：
   - 编写 `document-access.spec.ts`：测试 `accessFromUser`、`canReadDocument`、`canWriteDocument`、`esVisibilityFilter`、`wrapEsQuery`、`neo4jDocumentAccessWhere`；
   - 运行既有测试套件，确保所有既有服务与测试 100% 通过；
   - **同步更新既有 fake**：`document.service.spec.ts`、`retrieval.service.spec.ts` 等受签名变更影响的用例需补齐 `AuthUser` 入参。
2. **存量回填验证（关键）**：
   - 回填执行前后各统计一次「缺 `is_public` 字段的 chunk 数」，确认归零；
   - 用非作者、非团队的普通用户检索一条**历史**已发布公开文档，确认在回填后可见（回填前应不可见，可先验证现象再修复）。
3. **前后端联调测试**：
   - 使用普通用户 A 创建私有团队文档，验证同团队用户 B 可查，非团队用户 C 不可查；
   - 验证作者修改文档为公开后，无需重跑 Embedding，ES 与 Neo4j 秒级对用户 C 生效；
   - 验证 AI 问答与流式对话不会引用无权限团队的文档知识；
   - 验证 `GET /kg/stats`、`GET /kg/entities`、`GET /kg/neighbors` 只返回可见范围内的数据；
   - 验证非作者/非管理员无法通过 API 修改或提交他人文档审核（403）。

---

## 6. 核心架构设计与决策登记

| 关注维度 | 传统/简化实现 | 本系统设计与实现 | 性质 |
| --- | --- | --- | --- |
| ES 字段命名 | 两套命名规则混杂 | 统一为 snake_case 规则映射 | 规范化统一 |
| `teamIds` 装配时机 | 仅在登录签发 Token 时计算 | 每请求随权限实时计算，保证即时性 | 安全增强 |
| `GET /teams/tree` | 强制收紧为 ADMIN 专有 | 保持 `@Public`（支持注册等场景筛选） | 架构设计 |
| kg 统计/实体/邻居接口 | 扩展查询接口未加过滤 | 全量查询接口同步加安全 scope | 安全加固 |
| 存量 `is_public` 回填 | 依赖人工重新发布 | 启动探测与自动回填 | 平滑升级 |
| RAG 检索改造方式 | 侵入式重写 ES query | 优雅并入既有 `filterClauses` 通道 | 架构精简 |
