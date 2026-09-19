# RAG 索引与检索管线实施计划（阶段一 · 同步版 · Elasticsearch）

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把「已发布文档」变成「可检索知识」，形成写入 + 混合检索闭环。补齐参考项目缺失的检索侧，修掉它「软删除不清向量」的 P0，并避免它「IK 装了没用」的 P1。

**架构：** 检索底座为 Elasticsearch 8.17 + IK 分词（`kh_chunk` 索引），向量与 BM25 双路召回 + RRF 融合；管线同步执行，由 `PUT /documents/:id/publish` 触发；检索走 `POST /documents/search`。异步队列（Redis + BullMQ）留到阶段二，编排代码无需重写即可搬迁。

**技术栈：** NestJS 12（原生 ESM）、TypeORM、Mongoose、Elasticsearch 8.17.0（+ analysis-ik 8.17.0）、Kibana 8.17.0、`@elastic/elasticsearch`、`@langchain/textsplitters`、`@langchain/openai`（百炼兼容模式）、Vitest。

**规格：** [docs/superpowers/specs/2026-09-19-rag-indexing-pipeline-design.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/superpowers/specs/2026-09-19-rag-indexing-pipeline-design.md)
**参考映射：** [docs/reference-mapping.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/reference-mapping.md)

## 全局约束

- **模块与类命名沿用参考项目**（`ChunkingService` / `EmbeddingService` / `VectorIndexService` / `RagOrchestrator`），保证两项目可 grep 对照；索引名沿用 `kh_chunk`。
- ID 一律雪花 `string` + `bigintTransformer`。
- 新接口必须定义专用 DTO 并用 `class-validator` 校验；Controller 不手动封装响应信封（`TransformInterceptor` 已统一）。
- ESM 模式下本地导入必须带 `.js` 扩展名；CJS 依赖注意 `.default` 解构。
- 所有注释与文档使用中文。
- **不得在 Service 构造函数中因缺配置直接 throw 阻断应用启动**（参考项目 P1 教训）；ES 客户端与 Embedding 客户端均延迟初始化 / 降级为空 + warn。
- **IK 分析器必须在 mapping 中显式指定**（`ik_max_word` 索引、`ik_smart` 查询），并用 `_analyze` 验证，禁止出现「装了没用」。
- 每次有意偏离参考项目，须在 `docs/reference-mapping.md` 的「分叉登记」追加一行。

---

### 任务 1：Elasticsearch 基础设施与索引落地

**文件：**
- 创建：`elasticsearch/Dockerfile`
- 修改：`docker-compose.yml`
- 修改：`apps/server/src/.env.example`

- [x] **步骤 1：编写 ES 镜像 Dockerfile**
`FROM elasticsearch:8.17.0`，`elasticsearch-plugin install --batch` 安装 `analysis-ik-8.17.0`。**版本必须与 ES 严格一致**。

- [x] **步骤 2：编排 `es` 与 `kibana` 服务**
`es`：`discovery.type=single-node`、关闭 xpack 安全与 SSL、`ES_JAVA_OPTS=-Xms512m -Xmx512m`、数据卷持久化。
`kibana`：`kibana:8.17.0`、`ELASTICSEARCH_HOSTS=http://es:9200`、`depends_on: es`。

- [x] **步骤 3：启动并验证插件**
`docker compose up -d es kibana`，确认节点日志无 plugin 加载错误，Kibana 可访问。

- [x] **步骤 4：补充环境变量示例**
`ELASTICSEARCH_ENABLED` / `ELASTICSEARCH_NODE` 写入 `apps/server/.env.example`（后续任务用到的 `EMBEDDING_*`、`RAG_*` 一并补齐）。

---

### 任务 2：`kh_chunk` 索引初始化

**文件：**
- 创建：`apps/server/src/rag/es/es-client.service.ts`、`apps/server/src/rag/es/es.module.ts`
- 创建：`apps/server/src/rag/vector-index.service.ts`（先只含建索引能力）

- [x] **步骤 1：ES 客户端封装与降级**
连接失败时置空并 warn，**不阻断应用启动**；`OnModuleDestroy` 关闭连接。

- [x] **步骤 2：创建索引（含 IK）**
按规格 §3.1 写入 mapping，重点：`content` 与 `document_title` 的 `analyzer: ik_max_word`、`search_analyzer: ik_smart`；`embedding` 为 `dense_vector(1024, index:true, similarity:cosine)`。

- [x] **步骤 3：`_analyze` 验证分词**
对中文句子分别用 `ik_smart` / `ik_max_word` 分析，确认**不是单字切分**，把结果记入验证记录。

---

### 任务 3：ChunkingService（分块）

**文件：**
- 创建：`apps/server/src/rag/types/rag.types.ts`
- 创建：`apps/server/src/rag/chunking.service.ts`

- [x] **步骤 1：定义 `DocumentChunk` 类型**
字段对齐参考项目：`chunkId / documentId / documentTitle / content / heading / chunkIndex / totalChunks / categoryId / authorId / teamId / docStatus / publishTime / embedding`。

- [x] **步骤 2：实现分块服务**
`RecursiveCharacterTextSplitter`，`chunkSize = RAG_CHUNK_SIZE × 2`（默认 1024 字符），`overlap = RAG_CHUNK_OVERLAP × 2`（默认 128），`keepSeparator: true`，separators 首位补 `'\n# '`（内置 markdown 列表不含 H1）。

- [x] **步骤 3：heading 继承与前缀补全**
块内命中 `/^(#{1,6})\s+(.+)$/m` 则更新 `currentHeading`；后续块无标题行时拼为 `${heading}\n\n${body}`。

- [x] **步骤 4：稳定 chunkId**
`sha256(documentId:index)`（不照抄参考项目多余的 `.slice(0, 64)`），空正文返回 `[]`。

---

### 任务 4：EmbeddingService（向量化）

**文件：**
- 创建：`apps/server/src/rag/embedding.service.ts`

- [x] **步骤 1：实现百炼兼容客户端**
`OpenAIEmbeddings` + `baseURL = EMBEDDING_BASE_URL`，`model = text-embedding-v3`，`dimensions = 1024`，`stripNewLines: false`。

- [x] **步骤 2：batch 钳制**
`batchSize = Math.min(configured, 10)`，超出时 warn（百炼单次上限 10）。

- [x] **步骤 3：延迟初始化**
不在构造函数 throw；首次调用时才构造客户端，缺 Key 抛明确业务异常。

- [x] **步骤 4：批量与单条接口**
`embedBatch(texts)` 与 `embed(text)`。

---

### 任务 5：VectorIndexService 写入与清理

**文件：**
- 修改：`apps/server/src/rag/vector-index.service.ts`

- [x] **步骤 1：`deleteByDocumentId(documentId)`**
`deleteByQuery` 按 `document_id` 删除，`refresh: true`；索引不存在（`index_not_found`）时静默返回。

- [x] **步骤 2：`indexChunks(chunks)`**
`bulk` 写入，`_id = chunkId`，`refresh: true`；逐 item 检查 `errors`，部分失败记录明细并抛错。

- [x] **步骤 3：字段映射**
按规格 §3.1 组装文档（`publish_time` / `indexed_at` 用 ISO-8601，避免 `Date#toString()` 被 ES 拒绝）。

---

### 任务 6：RagOrchestrator + 发布接口

**文件：**
- 创建：`apps/server/src/rag/rag.orchestrator.ts`、`apps/server/src/rag/rag.module.ts`
- 修改：`apps/server/src/document/document.service.ts`、`apps/server/src/document/document.controller.ts`、`apps/server/src/document/document.module.ts`

- [x] **步骤 1：`indexDocument(docId)` 编排**
加载 PG 元数据 + Mongo 正文 → 清旧块 → 分块 → 嵌入 → 落 ES；记录耗时与块数日志。

- [x] **步骤 2：新增 `publish(id)`**
校验状态 ∈ {草稿, 已发布} → `status = Published` 并刷新 `publishTime` → 触发编排。
**与参考项目一致：管线失败不回滚已发布状态**，但需 error 日志。

- [x] **步骤 3：暴露 `PUT /documents/:id/publish`**

---

### 任务 7：混合检索接口（补参考项目 P0）

**文件：**
- 创建：`apps/server/src/rag/retrieval.service.ts`、`apps/server/src/rag/dto/search.dto.ts`、`apps/server/src/rag/dto/search-result.dto.ts`
- 修改：`apps/server/src/document/document.controller.ts`

- [x] **步骤 1：`SearchDto` 校验**
`query`（必填）、`mode`（`hybrid` / `vector` / `keyword`，默认 `hybrid`）、`topK`、可选 `categoryId` / `teamId` / `docStatus`。

- [x] **步骤 2：双路召回 + RRF 融合**
kNN（`k=RAG_KNN_K`、`num_candidates=RAG_KNN_CANDIDATES`）+ BM25（`content` 上 `match`，走 `ik_smart`）；
优先用 ES `retriever.rrf`，不支持时降级为两次查询后应用层 RRF 合并。

- [x] **步骤 3：元数据过滤**
按 `category_id` / `team_id` / `doc_status` 过滤。

- [x] **步骤 4：一致性兜底**
用召回结果的 `document_id` 回查 PostgreSQL，剔除 `deleted=true` 或不满足状态条件的文档。

- [x] **步骤 5：暴露 `POST /documents/search`**
返回 chunk 文本、得分、`documentId`、标题、heading、chunkIndex。

---

### 任务 8：删除联动清向量（修参考项目 P0）

**文件：**
- 修改：`apps/server/src/document/document.service.ts`

- [x] **步骤 1：`remove(id)` 中调用清理**
双库软删之后调用 `VectorIndexService.deleteByDocumentId(id)`，失败只记日志不阻断删除。

- [x] **步骤 2：验证兜底**
人为跳过清理步骤，确认检索仍不召回该文档（任务 7 步骤 4 的兜底生效）。

---

### 任务 9：端到端验证与测试

**文件：**
- 创建：`apps/server/src/rag/chunking.service.spec.ts`
- 修改：`apps/server/test/manual/`（补充发布与检索 curl 脚本）

- [x] **步骤 1：分块单测**
空正文、超长单段、多标题 heading 继承、重叠生效。

- [x] **步骤 2：端到端**
启动服务 → 上传真实夹具 → `publish` → 查 `kh_chunk` 确认块与向量 →
分别以 `mode=vector` / `mode=keyword` / `mode=hybrid` 检索对比 → `DELETE` 后确认清理与兜底。

- [x] **步骤 3：质量门禁**
`tsc --noEmit` 通过、`pnpm test:server` 通过、`oxlint` 零新增 error。

- [x] **步骤 4：登记分叉**
在 `docs/reference-mapping.md` 追加本次分叉登记（队列选型），并标注向量存储为对齐项。
