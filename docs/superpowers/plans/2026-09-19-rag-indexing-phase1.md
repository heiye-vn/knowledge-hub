# RAG 索引与检索管线实施计划（阶段一 · 同步版 · Elasticsearch）

> **目标：** 把「已发布文档」变成「可检索知识」，形成写入 + 混合检索闭环。补齐检索侧能力，规避软删除不清向量的隐患，并在 mapping 中显式配置 IK 分词。

**架构：** 检索底座为 Elasticsearch 8.17 + IK 分词（`kh_chunk` 索引），向量与 BM25 双路召回 + RRF 融合；管线同步执行，由 `PUT /documents/:id/publish` 触发；检索走 `POST /documents/search`。异步队列（Redis + BullMQ）留到阶段二，编排代码无需重写即可搬迁。

**技术栈：** NestJS 12（原生 ESM）、TypeORM、Elasticsearch 8.17.0（+ analysis-ik 8.17.0）、Kibana 8.17.0、`@elastic/elasticsearch`、`@langchain/textsplitters`、`@langchain/openai`（百炼兼容模式）、Vitest。

**规格：** [docs/superpowers/specs/2026-09-19-rag-indexing-pipeline-design.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/superpowers/specs/2026-09-19-rag-indexing-pipeline-design.md)

## 全局约束

- **模块与类命名清晰规范**（`ChunkingService` / `EmbeddingService` / `VectorIndexService` / `RagOrchestrator`）；索引名统一使用 `kh_chunk`。
- ID 一律雪花 `string` + `bigintTransformer`。
- 新接口必须定义专用 DTO 并用 `class-validator` 校验；Controller 不手动封装响应信封（`TransformInterceptor` 已统一）。
- ESM 模式下本地导入必须带 `.js` 扩展名；CJS 依赖注意 `.default` 解构。
- 所有注释与文档使用中文。
- **不得在 Service 构造函数中因缺配置直接 throw 阻断应用启动**；ES 客户端与 Embedding 客户端均延迟初始化 / 降级为空 + warn。
- **IK 分析器必须在 mapping 中显式指定**（`ik_max_word` 索引、`ik_smart` 查询），并用 `_analyze` 验证，禁止出现「装了没用」。

---

### 任务 1：Elasticsearch 基础设施与索引落地

**文件：**

- [ ] 修改：`docker-compose.yml`（加入 es、kibana）
- [ ] 创建：`elasticsearch/Dockerfile`（安装 analysis-ik 插件）
- [ ] 创建：`apps/server/src/rag/constants/kh-chunk.mapping.ts`
- [ ] 创建：`apps/server/src/rag/elasticsearch.service.ts`
- [x] **步骤 1：固定 Dockerfile**
    
  基础镜像 `elasticsearch:8.17.0`，插件 `analysis-ik 8.17.0`（写死版本，不用 latest）。
- [x] **步骤 2：定义 mapping 常量**
    
  `content` 配 `ik_max_word`（索引）+ `ik_smart`（搜索）；`embedding` 配 `dense_vector`（`dims: 1024`，`similarity: cosine`，`index: true`）。
- [x] **步骤 3：实现 ElasticsearchService**
    
  延迟初始化单例 Client；`onModuleInit` 探测连通性，连不上只 warn 不 throw；提供 `createIndexIfNotExists(name, mapping)`。

---

### 任务 2：RagModule 骨架与配置接入

**文件：**

- [ ] 创建：`apps/server/src/rag/rag.module.ts`
- [ ] 修改：`apps/server/src/app.module.ts`
- [ ] 修改：`apps/server/.env.example`
- [x] **步骤 1：扩充环境变量**
    
  `EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSION`、`ELASTICSEARCH_NODE`、`ELASTICSEARCH_INDEX`。
- [x] **步骤 2：创建并导入 RagModule**

---

### 任务 3：ChunkingService（分块与 Markdown 感知）

**文件：**

- [ ] 创建：`apps/server/src/rag/chunking.service.ts`
- [x] **步骤 1：定义 `DocumentChunk` 类型**
    
  字段规范：`chunkId / documentId / documentTitle / content / heading / chunkIndex / totalChunks / categoryId / authorId / teamId / docStatus / publishTime / embedding`。
- [x] **步骤 2：实现分块服务**
    
  `RecursiveCharacterTextSplitter`，`chunkSize = RAG_CHUNK_SIZE × 2`（默认 1024 字符），`overlap = RAG_CHUNK_OVERLAP × 2`（默认 128），`keepSeparator: true`，separators 首位补 `'\n# '`（内置 markdown 列表不含 H1）。
- [x] **步骤 3：heading 继承与前缀补全**
    
  块内命中 `/^(#{1,6})\s+(.+)$/m` 则更新 `currentHeading`；后续块无标题行时拼为 `${heading}\n\n${body}`。
- [x] **步骤 4：稳定 chunkId**
    
  `sha256(documentId:index)`，空正文返回 `[]`。

---

### 任务 4：EmbeddingService（向量化）

**文件：**

- [ ] 创建：`apps/server/src/rag/embedding.service.ts`
- [x] **步骤 1：延迟初始化**
    
  首次调用时再创建 `OpenAIEmbeddings`；缺 Key 时方法内抛出友好业务异常，构造函数不 throw。
- [x] **步骤 2：实现批量嵌入**
    
  `embedDocuments(texts[])` + `embedQuery(text)`；单批上限 `RAG_EMBEDDING_MAX_BATCH` 截断，`stripNewLines: false`。

---

### 任务 5：VectorIndexService（向量写入与索引管理）

**文件：**

- [ ] 创建：`apps/server/src/rag/vector-index.service.ts`
- [x] **步骤 1：写入管线（幂等 bulk）**
    
  先按 `document_id` 调 `delete_by_query` 清旧块 → 调 `bulk` 写入新块（带 `embedding` 字段）。
- [x] **步骤 2：清理与存在性检查**
    
  `deleteByDocumentId(documentId)`、`checkChunkCount(documentId)`。

---

### 任务 6：RagOrchestrator 与发布入口接入

**文件：**

- [ ] 创建：`apps/server/src/rag/rag.orchestrator.ts`
- [ ] 修改：`apps/server/src/document/document.service.ts`
- [ ] 修改：`apps/server/src/document/document.controller.ts`
- [x] **步骤 1：编排全流程**
    
  入参 `PipelineDocument` → 清旧块 → 分块 → Embedding → 批量写 ES → 返回 `{ chunksCount }`。
- [x] **步骤 2：接入 `DocumentService.publish(id)`**
    
  校验状态 ∈ {草稿, 已发布} → `status = Published` 并刷新 `publishTime` → 触发编排。
    
  管线失败不回滚已发布状态，但需 error 日志。
- [x] **步骤 3：暴露 `PUT /documents/:id/publish`**

---

### 任务 7：混合检索接口

**文件：**

- [ ] 创建：`apps/server/src/rag/retrieval.service.ts`、`apps/server/src/rag/dto/search.dto.ts`、`apps/server/src/rag/dto/search-result.dto.ts`
- [ ] 修改：`apps/server/src/document/document.controller.ts`
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

### 任务 8：删除联动清向量

**文件：**

- [ ] 修改：`apps/server/src/document/document.service.ts`
- [x] **步骤 1：`remove(id)` 中调用清理**
    
  软删之后调用 `VectorIndexService.deleteByDocumentId(id)`，失败只记日志不阻断删除。
- [x] **步骤 2：验证兜底**
    
  人为跳过清理步骤，确认检索仍不召回该文档（任务 7 步骤 4 的兜底生效）。

---

### 任务 9：端到端验证与测试

**文件：**

- [ ] 创建：`apps/server/src/rag/chunking.service.spec.ts`
- [ ] 修改：`apps/server/test/manual/`（补充发布与检索 curl 脚本）
- [x] **步骤 1：分块单测**
    
  空正文、超长单段、多标题 heading 继承、重叠生效。
- [x] **步骤 2：端到端**
    
  启动服务 → 上传真实夹具 → `publish` → 查 `kh_chunk` 确认块与向量 →
    
  分别以 `mode=vector` / `mode=keyword` / `mode=hybrid` 检索对比 → `DELETE` 后确认清理与兜底。
- [x] **步骤 3：质量门禁**
    
  `tsc --noEmit` 通过、`pnpm test:server` 通过、`oxlint` 零新增 error。
