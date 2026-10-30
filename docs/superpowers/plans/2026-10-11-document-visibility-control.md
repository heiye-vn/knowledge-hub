# 文档检索可见性控制（feat-v15）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
> **版本**：V2（2026-10-11 评审修订：修正命令、补齐遗漏接口与装配链、新增存量回填任务）

**目标：** 在 knowledge-hub 中落地端到端文档可见性控制（公开/团队/个人/管理员），覆盖 Postgres 文档增删改查、ES 全文检索、ES 向量切块 RAG、Neo4j 知识图谱及前端核心页面。

**架构：** 新建 `document-access.ts` 集中抽象作用域与过滤规则；`AuthUser` 注入当前用户所属团队；检索侧在召回前置阶段通过既有 `filterClauses`（`bool.filter` / `knn.filter`）和 Cypher 条件进行权限过滤；已发布文档变更可见性时通过 `RagOrchestrator` 并发就地更新三套索引。

**技术栈：** NestJS, TypeScript (原生 ESM), TypeORM (PostgreSQL), Elasticsearch (8.17 + IK), Neo4j (Cypher), React + Ant Design, Vitest.

**规格：** [docs/superpowers/specs/2026-10-11-document-visibility-control-design.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/superpowers/specs/2026-10-11-document-visibility-control-design.md)

## 全局约束

- 运行时环境：Node.js 原生 ESM 模式，代码中本包内相对导入必须带有 `.js` 后缀。
- ES 字段命名规范：统一 `snake_case`（`is_public`、`team_id`、`author_id`），`kh_chunk` 与 `kh_document` 共用一套映射。
- 权限隔离与无副作用：检索打分只在 `must` 中计算，可见性规则一律挂在 `filter` 上下文，不影响 BM25/向量相关度分数。
- **改造方式**：优先复用既有 `filterClauses` 统一过滤通道，不重写检索内部查询结构。
- 频繁 Commit：每个任务完成后必须执行测试并提交 Git commit。

**命令约定（修正：包名为 `@knowledge-hub/server` / `@knowledge-hub/web`）**

```bash
pnpm test:server        # 服务端全量测试（根脚本）
pnpm typecheck:server   # 服务端类型检查（含 spec，nest build 有盲区）
pnpm typecheck:web      # 前端类型检查
pnpm build:web          # 前端构建
# 单测定向执行
pnpm --filter @knowledge-hub/server exec vitest run <path>   # 结尾 vitest not found 是已知噪音
```

---

### 任务 1：用户与团队域扩展（AuthUser、TeamService、TeamController、UserService）

**文件：**
- 修改：`apps/server/src/auth/auth-user.interface.ts`
- 修改：`apps/server/src/team/team.service.ts`
- 修改：`apps/server/src/team/team.controller.ts`
- 修改：`apps/server/src/user/user.module.ts`
- 修改：`apps/server/src/user/user.service.ts`

- [x] **步骤 1：扩展 `AuthUser` 接口**
  增加 `teamIds: string[]`，注释说明「含普通成员与担任负责人的团队」。

- [x] **步骤 2：在 `TeamService` 中实现反查与个人团队方法**
  - `listAccessibleTeamIds(userId)`：`kh_team_member.user_id = :userId` ∪ `kh_team.leader_id = :userId`，`String()` 统一后再用 `In(ids) && deleted = false` 二次过滤（成员记录可能仍指向已软删团队）；
  - `listMine(userId)`：按 `id IN (:...ids) && deleted = false` 查实体，`sort ASC, createdAt ASC`。

- [x] **步骤 3：在 `TeamController` 中增加 `mine` 接口**
  `@Get('mine') listMine(@CurrentUser() user: AuthUser)`，仅需登录态。**`tree` 保持 `@Public`**（本项目的有意分叉，注册/公开筛选场景依赖它）。

- [x] **步骤 4：装配 `teamIds`（同步签名方案）**
  - `UserModule` 导入 `TeamModule`，`UserService` 注入 `TeamService`；
  - `toAuthUser` 保持同步函数，新增 `teamIds: string[]` 参数，**不要改成 async**（避免调用点连锁异步化）；
  - `buildAuthUser` 与 `validateCredentials` 内先 `await listAccessibleTeamIds(userId)` 再传入；
  - 代码注释说明：每请求多 2 条团队查询是**有意取舍**，换取成员变动即时生效（与权限码每请求重算一致）。

- [x] **步骤 5：运行测试验证并 Commit**
  运行：`pnpm --filter @knowledge-hub/server exec vitest run src/team src/user src/auth`
  Commit：`git commit -m "feat(auth): AuthUser 挂载团队 ID 并在 TeamService 增加反查与 mine 接口"`

---

### 任务 2：新建核心权限抽象模块与单元测试（document-access）

**文件：**
- 创建：`apps/server/src/document/document-access.ts`
- 创建：`apps/server/src/document/document-access.spec.ts`

- [x] **步骤 1：编写失败的单元测试 `document-access.spec.ts`**
  测试用例覆盖：
  - `accessFromUser`（普通用户提取 userId 与 teamIds，管理员/审核员 unrestricted=true）；
  - `canReadDocument`（本人可读且无视状态、公开可读、同团队可读、未发布拦截、管理员通配）；
  - `canWriteDocument`（作者可写、管理员可写、其他人不可写）；
  - `esVisibilityFilter`（unrestricted 返回 null，普通用户生成 should 子句，有/无 teamIds 两种分支）；
  - `wrapEsQuery`（无 filter 原样返回，有 filter 包装为 bool.must + bool.filter）；
  - `neo4jAccessParams` 与 `neo4jDocumentAccessWhere`（含默认别名与传入别名）。

- [x] **步骤 2：运行测试验证失败**
  运行：`pnpm --filter @knowledge-hub/server exec vitest run src/document/document-access.spec.ts`
  预期：FAIL（模块尚未创建）

- [x] **步骤 3：实现 `document-access.ts`**
  实现上述所有访问控制函数与常量（snake_case 单套字段映射，角色常量用 `ROLE_ADMIN` / `ROLE_REVIEWER`）。

- [x] **步骤 4：运行测试验证通过**
  预期：PASS

- [x] **步骤 5：Commit**
  ```bash
  git add apps/server/src/document/document-access.ts apps/server/src/document/document-access.spec.ts
  git commit -m "feat(document): 新增文档访问控制与跨存储过滤工具 document-access"
  ```

---

### 任务 3：文档服务与控制器改造（列表/详情鉴权、写守卫、可见性变更识别）

**文件：**
- 修改：`apps/server/src/document/document.service.ts`
- 修改：`apps/server/src/document/document.controller.ts`
- 修改：`apps/server/src/document/document.service.spec.ts`（既有 fake 同步）

- [x] **步骤 1：改造 `DocumentService.findAll` 拼接可见性 SQL**
  入参增加 `user: AuthUser`；非 unrestricted 时：有团队 →
  `(doc.author_id = :me OR (doc.status = :published AND (doc.is_public = true OR doc.team_id IN (:...teamIds))))`；
  无团队 → 去掉 `team_id IN` 分支。

- [x] **步骤 2：改造 `DocumentService.findOne` 增加读取鉴权**
  增加 `user?: AuthUser`，调用 `canReadDocument`，无权则抛出 `ForbiddenException('无权查看该文档')`。

- [x] **步骤 3：增加 `assertWritable` 写权限守卫**
  覆盖 `update`、`publish`、**`submitForReview`**、`archive`、**`saveAsDraft`**、`remove`
  （方法名以主项目实际为准：`saveAsDraft` 非 `saveDraft`；`submitForReview` 是独立于 `publish` 的审核提交旁路，必须一并守卫）。
  审核员的 `approveReview` / `rejectReview` 维持既有 REVIEWER 角色鉴权，不纳入作者守卫。

- [x] **步骤 4：识别可见性变更并触发管线同步（排他顺序）**
  `update` 中比对 `isPublic` / `teamId`：**先判内容重建，后判就地可见性更新，二者互斥**——
  内容变更且免审模式走整篇重建索引（重建本身写入最新 `is_public`）；
  仅当「内容未变 && `status === Published && visibilityChanged`」才调用 `ragOrchestrator.updateVisibility(saved)`。

- [x] **步骤 5：改造 `DocumentController` 透传 `@CurrentUser() user`**
  `findAll`、`findOne`、`publish`、`:id/reviews/submit`、`archive`、`:id/save-draft`、`remove` 注入当前用户并透传。

- [x] **步骤 6：同步既有单测 fake 并 Commit**
  运行：`pnpm --filter @knowledge-hub/server exec vitest run src/document`
  Commit：`git commit -m "feat(document): 文档列表/详情接入可见性过滤，写操作增加作者鉴权与变更感知"`

---

### 任务 4：Elasticsearch 全文索引就地更新与检索可见性改造（search）

**文件：**
- 修改：`apps/server/src/search/search-index.service.ts`
- 修改：`apps/server/src/search/search.controller.ts`

> `kh_document` 的 mapping 已含 `is_public` / `team_id` / `author_id`，**本任务无需改动 mapping 与 DTO**（scope 由 controller 注入 service，不进入请求体）。

- [x] **步骤 1：在 `SearchIndexService` 中增加 `updateVisibility`**
  实现 `updateVisibility(documentId, vis)`，使用 `client.update` 局部更新 `is_public`、`team_id`、`author_id`。

- [x] **步骤 2：在 `SearchIndexService.search` 中集成可见性过滤**
  入参接收 `scope?: DocumentAccessScope`，使用 `esVisibilityFilter` 构建子句并追加到既有 `filters` 中；出参 `toSearchHit` 补齐 `teamId` 与 `isPublic` 供前端渲染。

- [x] **步骤 3：改造 `SearchController` 透传用户 scope**
  `POST /search/documents` 与 `GET /search/documents` **两个路由**均注入 `@CurrentUser() user: AuthUser` 并转为 `scope` 传给 service。

- [x] **步骤 4：运行测试验证并 Commit**
  运行：`pnpm --filter @knowledge-hub/server exec vitest run src/search`
  Commit：`git commit -m "feat(search): kh_document 搜索索引增加可见性过滤与局部更新 updateVisibility"`

---

### 任务 5：RAG 向量索引就地更新与混合检索可见性改造（rag & ai）

**文件：**
- 修改：`apps/server/src/rag/constants/kh-chunk.mapping.ts`
- 修改：`apps/server/src/rag/types/rag.types.ts`
- 修改：`apps/server/src/rag/chunking.service.ts`
- 修改：`apps/server/src/rag/vector-index.service.ts`
- 修改：`apps/server/src/rag/retrieval.service.ts`
- 修改：`apps/server/src/rag/search.controller.ts`
- 修改：`apps/server/src/rag/rag.orchestrator.ts`
- 修改：`apps/server/src/ai/ai-chat.service.ts`
- 修改：`apps/server/src/ai/ai-stream.service.ts`

- [x] **步骤 1：mapping 迁移（存量部署失效保护）**
  - `kh-chunk.mapping.ts` 的 properties 增加 `is_public: { type: 'boolean' }`；
  - 新增 `ensureVisibilityMapping`（放在 `VectorIndexService` 初始化或 `ElasticsearchService`）：启动时对已存在的 `kh_chunk` 执行 `putMapping` 补 `is_public`。

- [x] **步骤 2：打通 `is_public` 装配链（三处，缺一不可）**
  - `rag.types.ts` 的 `DocumentChunk` 接口增加 `isPublic?: boolean`；
  - `chunking.service.ts` 的 chunk 参数透传 `isPublic`；
  - `rag.orchestrator.ts` 的 `chunkingService.chunk({...})` 调用处装配 `isPublic: doc.isPublic`。

- [x] **步骤 3：写入 ES 的字段与就地更新**
  - `buildDocMap` 补全 `is_public: chunk.isPublic ?? false`；
  - 新增 `updateVisibility(documentId, vis)`：`updateByQuery` + Painless 脚本
    `ctx._source.is_public = params.is_public; ctx._source.team_id = params.team_id; ctx._source.author_id = params.author_id;`

- [x] **步骤 4：检索侧注入可见性（复用既有 filterClauses）**
  - `RetrievalService.search` 参数增加 `scope?: DocumentAccessScope`，在 `buildFilters` 处把 `esVisibilityFilter(scope)` 产物并入 `filterClauses`；
  - **不重写 `runKeywordSearch` / `runVectorSearch` 的内部结构**（它们已是 `bool.must + filter` / `knn.filter`），keyword / vector / hybrid 三种 mode 一次性生效；
  - 确认进入 RRF 与 Rerank 的候选全部满足可见性约束。

- [x] **步骤 5：AI 对话透传 scope**
  - `rag/search.controller.ts` 的 GET 与 POST 均注入 `@CurrentUser()`；
  - `ai-chat.service.ts`（约 87 行检索调用）与 `ai-stream.service.ts`（约 193 行 RAG 检索）透传 scope；
  - `ai-stream` 中的 Bocha `web_search` 工具调用不涉及知识库，无需处理。

- [x] **步骤 6：运行测试验证并 Commit**
  运行：`pnpm --filter @knowledge-hub/server exec vitest run src/rag src/ai`
  Commit：`git commit -m "feat(rag): RAG 混合检索增加权限准入过滤，向量块支持 updateVisibility 原地更新"`

---

### 任务 6：Neo4j 知识图谱就地更新与穿透可见性检索（kg）

**文件：**
- 修改：`apps/server/src/kg/graph-build.service.ts`
- 修改：`apps/server/src/kg/kg.controller.ts`

- [x] **步骤 1：写入侧补全文档节点可见性属性**
  `buildForDocument` 的 `KnowledgeDocument` 节点 `SET` 语句补 `d.teamId = $teamId, d.isPublic = $isPublic`
  （当前仅写入 `authorId` / `status` / `tags`；chunk 节点已有 `teamId`，同样补 `isPublic`）。

- [x] **步骤 2：在 `GraphBuildService` 中实现 `updateVisibility`**
  执行 Cypher：
  `MATCH (d:KnowledgeDocument {id: $id}) SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId, d.updatedAt = $now`。

- [x] **步骤 3：知识图谱查询方法注入 `neo4jDocumentAccessWhere`（全量 7 个接口）**
  改造 `getOverview`、**`getStats`**、**`listEntities`**、**`getNeighbors`**、`searchGraph`、`listNodes`、`listEdges`：
  - 文档节点按 `neo4jDocumentAccessWhere('d')` 过滤；
  - 实体节点按
    `MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity) WHERE neo4jDocumentAccessWhere('d')`
    穿透过滤；
  - 关系边按双端实体均属于可见文档穿透过滤；
  - **统计数字（文档数 / 实体数 / 关系数 / 提及数）只计可见范围内的数据**，避免通过数字侧信道泄露。
  - 实现前确认 Neo4j 版本：`EXISTS { ... }` 子查询需 5+，否则改用 `size([... ]) > 0` 写法。

- [x] **步骤 4：在 `KgController` 中透传 `@CurrentUser() user`**
  全部 7 个端点（`overview` / `stats` / `entities` / `neighbors` / `search` / `nodes` / `edges`）传入 `accessFromUser(user)`。

- [x] **步骤 5：运行测试验证并 Commit**
  运行：`pnpm --filter @knowledge-hub/server exec vitest run src/kg`
  Commit：`git commit -m "feat(kg): Neo4j 知识图谱接入可见性穿透过滤与节点属性原地更新"`

---

### 任务 7：存量数据回填（历史存量平滑升级）

> **背景**：存量 `kh_chunk` 数据块与 Neo4j 旧 `KnowledgeDocument` 节点没有 `is_public` / `teamId` 值。
> 可见性过滤上线后 `term: { is_public: true }` 不命中缺失字段 → **历史已发布公开文档被全部误杀**。
> 此项为功能增强设计。

**文件：**
- 修改：`apps/server/src/rag/rag.orchestrator.ts`
- 修改：`apps/server/src/document/document.service.ts`（复用 `findPublishedIds`）

- [x] **步骤 1：探测存量缺口**
  统计「缺 `is_public` 字段的 chunk 数」与「缺 `teamId` / `isPublic` 属性的 `KnowledgeDocument` 节点数」，记录初始统计数值。

- [x] **步骤 2：实现回填方法**
  在 `RagOrchestrator` 增加一次性回填方法：取 PG 中 `deleted = false && status = Published` 的全部文档
  → 逐文档调用 `vectorIndexService.updateVisibility` 与 `graphBuildService.updateVisibility`（幂等，可重复执行）。

- [x] **步骤 3：触发方式与容错**
  启动幂等执行（先探测有缺口才回填）；失败不阻塞启动，只告警；执行方式记入 dev-notes。

- [x] **步骤 4：效果验证**
  - 回填后统计数归零；
  - 用「非作者且非团队」的普通用户检索一条**历史**已发布公开文档，回填前不可见、回填后可见。

- [x] **步骤 5：Commit**
  Commit：`git commit -m "fix(rag): 回填存量向量块与图谱节点的可见性字段，避免历史公开文档被误过滤"`

---

### 任务 8：服务端整体自动化测试回归

- [x] **步骤 1：运行服务端全量测试**
  运行：`pnpm test:server`
  预期：全部现有单元测试及新增测试 100% PASS。

- [x] **步骤 2：运行类型检查与 linter**
  运行：`pnpm typecheck:server`
  预期：0 类型报错（含 spec；不用 `nest build` 代替，其有类型盲区）。

---

### 任务 9：前端类型、工具函数与 API 层扩展（apps/web）

**文件：**
- 修改：`apps/web/src/types.ts`
- 修改：`apps/web/src/utils.ts`
- 修改：`apps/web/src/api/index.ts`

- [x] **步骤 1：更新 `types.ts`**
  - `AuthUser` 扩展 `teamIds?: string[]`；
  - `SearchHit` 扩展 `teamId?: string | null`、`isPublic?: boolean | null`；
  - 增加 `TeamTreeNode` 类型定义。

- [x] **步骤 2：更新 `utils.ts`**
  - `canWriteDocument(user, doc)`：作者或管理员；
  - `visibilityMeta(doc)`：公开 / 团队可见 / 仅自己三态 label + Tag 颜色；
  - `flattenTeams(tree)`：树形团队扁平化为一维下拉选项。

- [x] **步骤 3：更新 `api/index.ts`**
  - 补齐 `teamApi.mine()` 与 `teamApi.tree()` 强类型。

- [x] **步骤 4：Commit**
  ```bash
  git add apps/web/src/types.ts apps/web/src/utils.ts apps/web/src/api/index.ts
  git commit -m "feat(web): 扩展前端可见性类型定义、工具函数与团队 API"
  ```

---

### 任务 10：前端页面对接与可见性交互升级（apps/web）

**文件：**
- 修改：`apps/web/src/pages/DocumentEditPage.tsx`
- 修改：`apps/web/src/pages/DocumentsPage.tsx`
- 修改：`apps/web/src/pages/SearchPage.tsx`
- 修改：`apps/web/src/pages/GraphPage.tsx`
- 修改：`apps/web/src/pages/DocumentDetailPage.tsx`
- 修改：`apps/web/src/pages/DashboardPage.tsx`
- 修改：`apps/web/src/layouts/AppLayout.tsx`
- 修改：`apps/web/src/pages/ProfilePage.tsx`
- 修改：`apps/web/src/index.css`

- [x] **步骤 1：改造 `DocumentEditPage.tsx`**
  - 非作者/非管理员禁止编辑（403 空状态）；
  - 普通用户加载 `teamApi.mine()`，管理员加载 `teamApi.tree()` 打平；
  - 表单增加 `isPublic` 与 `teamId` 控件及辅助说明；
  - 默认 `isPublic: false`。

- [x] **步骤 2：改造 `DocumentsPage.tsx`**
  - 表格「公开」列升级为「可见性」Tag 列；
  - 操作栏「编辑」「发布」由 `canWriteDocument` 保护；
  - 增加「仅我的」复选框（传 `authorId`）；
  - **移除上传时 `form.append('isPublic', 'true')`**（当前第 78 行）——否则上传文档默认公开，与「默认仅自己可见」规则冲突。

- [x] **步骤 3：改造 `SearchPage.tsx` 与 `GraphPage.tsx`**
  - 结果卡片展示可见性 Tag；
  - 移除手动 `authorId` 输入框；
  - 增加权限范围提示文案。

- [x] **步骤 4：改造 `DocumentDetailPage.tsx`**
  - 展示可见性 Tag；编辑/发布/归档/删除按钮由 `canWriteDocument` 保护；403 空状态。

- [x] **步骤 5：改造 `DashboardPage.tsx`、`AppLayout.tsx`、`ProfilePage.tsx`**
  - 最近文档表格增加可见性 Tag 列；
  - 顶栏展示所属团队 Tag（取前 2 个），个人页展示完整团队列表。

- [x] **步骤 6：`index.css` 增加 `.kh-access-hint` 提示条样式**

- [x] **步骤 7：Commit**
  ```bash
  git add apps/web/src/pages/ apps/web/src/layouts/ apps/web/src/index.css
  git commit -m "feat(web): 文档编辑/列表/搜索/图谱页面全面对接可见性控制与交互"
  ```

---

### 任务 11：全工程构建与 E2E 验证

- [x] **步骤 1：前端编译构建验证**
  运行：`pnpm typecheck:web` 与 `pnpm build:web`
  预期：TypeScript 编译与 Vite build 成功。

- [x] **步骤 2：服务端构建验证**
  运行：`pnpm build:server`
  预期：无报错（注意：它不能替代 `pnpm typecheck:server`）。

- [x] **步骤 3：接口集合同步（AGENTS.md 第三节）**
  更新 `docs/apifox/knowledge-hub.postman_collection.json`：新增 `GET /teams/mine`；标注检索类接口（`/search`、`/search/documents`、`/kg/*`、`/ai/chat*`）新增的可见性行为。

- [x] **步骤 4：成果归档与 Git 记录**
  - 归档核心设计决策（`teams/tree` 保持 `@Public`；kg `stats`/`entities`/`neighbors` 扩展接口同步加 scope；存量数据自动回填）；
  - 追加 `docs/dev-notes/<模块>.md`（document / rag / kg / team），标注【实录】与【易坑】；
  - 更新 `contexts/context.md` 记录 feat-v15 完成内容。

