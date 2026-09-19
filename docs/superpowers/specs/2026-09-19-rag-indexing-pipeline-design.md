# RAG 索引与检索管线设计规格（阶段一）

> **文档状态**：设计就绪 / 待实施
> **创建日期**：2026-09-19
> **修订**：2026-09-19 二次修订 —— 向量与全文检索由 pgvector 改为 **Elasticsearch 8.17 + IK**（决策依据见 §9.2）
> **关联模块**：`apps/server`（Rag / Document / Storage）
> **参考基线**：`knowledge-hub-backend` 分支 `v3`，模块映射见 [docs/reference-mapping.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/reference-mapping.md)

---

## 1. 背景与已定决策

文档摄取阶段已完成：元数据（PostgreSQL）+ 正文（MongoDB）+ 源文件元数据（`kh_document` 五列）均已闭环。
下一步是把「已发布的文档」变成「可被检索的知识」。

**已拍板的决策：**

| 决策项 | 结论 |
| :--- | :--- |
| Embedding 方案 | 云端阿里云百炼 **`qwen3.7-text-embedding-flash`**，OpenAI 兼容协议，**1024 维**（2026-09-19 由 `text-embedding-v3` 切换，见 §9.3） |
| 向量 + 全文检索 | **Elasticsearch 8.17.0 + IK 中文分词**（与参考项目同栈） |
| 检索形态 | **混合检索**：向量 kNN + 中文 BM25，RRF 融合 |
| 异步队列 | **阶段一不做**，`publish` 同步执行；阶段二再引入 Redis + BullMQ |
| 分块策略 | 沿用参考项目：LangChain `RecursiveCharacterTextSplitter`，Markdown 感知 |
| 父子分块 | 阶段一不做（与参考项目一致），效果验证后再评估 |

**为什么最终选 ES 而非 pgvector**：中文关键词检索是硬需求。PostgreSQL 内置 `tsvector` 对中文基本无效，
要做 BM25 需装 `zhparser`（需编译、与 PG 版本绑定）；而 ES 的 IK 分词开箱即用，
且 kNN 与 BM25 的混合检索是其原生能力。完整权衡与代价见 §9.2。

**为什么先同步后异步**：切分与召回效果尚未验证，先加异步层会拉长调试链路。同步版跑通后，把执行体搬进 Worker 即可，编排代码无需重写。

---

## 2. 目标与非目标

**目标**
1. 发布文档 → 分块 → 向量化 → 落 ES，形成写入闭环
2. **混合检索**：向量 kNN + 中文 BM25 双路召回 + RRF 融合（选 ES 的核心收益）
3. 重复发布幂等；文档删除联动清向量，并有**检索侧兜底**防止已删文档被召回
4. 中文分词可用且可验证（显式配置 IK，避免参考项目「装了没用」的 P1）

**非目标（本阶段不做）**
- 异步队列、失败重试、任务状态表 → 阶段二
- Rerank 二次精排（如 bge-reranker）→ 阶段三
- 父子分块 → 待效果评估
- 鉴权过滤（按用户/团队可见性）→ 随 RBAC 一起做
- 多模态解析（MinerU）→ 独立议题

---

## 3. 数据模型

检索侧全部落在 Elasticsearch 索引 **`kh_chunk`**（与参考项目同名，便于对照）。

### 3.1 索引 mapping

```jsonc
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "5s"
  },
  "mappings": {
    "properties": {
      "chunk_id":       { "type": "keyword" },
      "document_id":    { "type": "keyword" },
      "document_title": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart",
        "fields": { "keyword": { "type": "keyword" } }
      },
      "content": {
        "type": "text",
        "analyzer": "ik_max_word",       // 索引期细粒度切分，提高召回
        "search_analyzer": "ik_smart"    // 查询期粗粒度切分，提高精度
      },
      "heading":        { "type": "keyword" },
      "chunk_index":    { "type": "integer" },
      "total_chunks":   { "type": "integer" },
      "category_id":    { "type": "keyword" },
      "author_id":      { "type": "keyword" },
      "team_id":        { "type": "keyword" },
      "doc_status":     { "type": "integer" },
      "publish_time":   { "type": "date" },
      "indexed_at":     { "type": "date" },
      "embedding": {
        "type": "dense_vector",
        "dims": 1024,                    // 必须等于 EMBEDDING_DIMENSION
        "index": true,
        "similarity": "cosine"
      }
    }
  }
}
```

> ⚠️ **两条硬约束**
> 1. `dims: 1024` 建索引后不可原地修改。变更 `EMBEDDING_DIMENSION` 必须删索引重建并全量重索引。
> 2. **IK 版本必须与 ES 严格一致**（8.17.0 ↔ 8.17.0），否则插件加载失败导致节点起不来。

> ✅ **相对参考项目的关键改进**：参考项目装了 IK 却在 mapping 里没指定分析器，`content` 走了默认 standard 分词，
> 中文被切成单字，等于白装。本设计在 `content` 与 `document_title` 上**显式指定** `ik_max_word` / `ik_smart`。

### 3.2 基础设施

`docker-compose.yml` 新增两个服务（沿用参考项目已验证的编排）：

| 服务 | 镜像 | 端口 | 要点 |
| :--- | :--- | :--- | :--- |
| `es` | 本地 `./elasticsearch` Dockerfile（`FROM elasticsearch:8.17.0` + `elasticsearch-plugin install` IK 8.17.0） | 9200 | `discovery.type=single-node`、关闭 xpack 安全与 SSL、`ES_JAVA_OPTS=-Xms512m -Xmx512m` |
| `kibana` | `kibana:8.17.0`（版本须与 ES 完全一致） | 5601 | `ELASTICSEARCH_HOSTS=http://es:9200`，`depends_on: es` |

---

## 4. 模块划分（与参考项目同名，便于对照）

```
apps/server/src/rag/
├── rag.module.ts
├── rag.orchestrator.ts        # 对应参考 PipelineOrchestrator：加载 → 清旧 → 分块 → 嵌入 → 落库
├── chunking.service.ts        # 同名：Markdown 感知递归切分 + heading 前缀补全
├── embedding.service.ts       # 同名：百炼 qwen3.7-text-embedding-flash，batch 钳制 ≤ 20（可配置）
├── vector-index.service.ts    # 同名：ES 版写入/清理/建索引（与参考项目同栈）
├── retrieval.service.ts       # 新增：参考项目缺失的检索侧（kNN + BM25 + RRF）
├── es/
│   ├── es.module.ts
│   └── es-client.service.ts   # ES 连接与降级（不可用时置空 + warn）
├── dto/
│   ├── search.dto.ts
│   └── search-result.dto.ts
└── types/rag.types.ts         # 对应参考 pipeline.types.ts：DocumentChunk 等
```

**接入点**
- `DocumentService.publish(id)` → 触发编排（参考项目同名 `PUT /documents/:id/publish`）
- `DocumentService.remove(id)` → 软删除后调用 `VectorIndexService.deleteByDocumentId`
- `DocumentController` → `PUT :id/publish`、`POST documents/search`

---

## 5. 核心流程

### 5.1 发布索引（阶段一：同步）

```
PUT /documents/:id/publish
  → 校验文档存在且状态 ∈ {草稿, 已发布}
  → status = Published，刷新 publishTime
  → RagOrchestrator.indexDocument(docId)
       ├─ 加载 PG 元数据 + Mongo 正文
       ├─ VectorIndexService.deleteByDocumentId(docId)   // deleteByQuery + refresh，保证幂等
       ├─ ChunkingService.chunk(content, meta) → DocumentChunk[]
       ├─ EmbeddingService.embedBatch(contents) → number[][]（内部按 10 条切片）
       └─ VectorIndexService.indexChunks(chunks)         // bulk，_id = chunkId，refresh
  → 返回文档（与参考项目一致：管线失败不回滚已发布状态，但需 error 日志）
```

### 5.2 混合检索

```
POST /search  { query, topK?, mode?, categoryId?, teamId?, authorId? }
GET  /search?query=...&mode=...   // 便捷版，供 curl / 浏览器快速验证
  → EmbeddingService.embed(query)
  → ES 双路召回 + RRF 融合：
      ├─ kNN：embedding 字段，k=50、num_candidates=200，cosine
      └─ BM25：content 上的 match 查询（ik_smart），可选 document_title 加权
      再按 category_id / team_id / doc_status 过滤
  → 兜底：用召回结果的 document_id 回查 PostgreSQL，
           剔除 deleted=true 或不满足状态条件的文档（见 §5.3）
  → 组装：chunk 文本、得分、documentId、标题、heading、chunkIndex、高亮片段
```

RRF 优先使用 ES 8.17 原生 `retriever.rrf`（`rank_window_size: 100`、`rank_constant: 60`）；
若目标集群版本不支持，降级为两次查询后在应用层做 RRF 合并。
`mode` 参数允许只走向量（`vector`）、只走关键词（`keyword`）或混合（`hybrid`，默认），便于效果对比。

> 🔴 **实现结果修正（2026-09-19 实测）**：ES 原生 RRF **不是版本问题，而是 license 问题**。
> 免费版（basic license）执行 `retriever.rrf` 直接抛
> `security_exception: current license is non-compliant for [Reciprocal Rank Fusion (RRF)]`。
> 因此落地采用**应用层 RRF**：并发发起 kNN 与 BM25 两次查询，在 Node 侧按 `score = Σ 1/(60 + rank)` 融合。
> 额外收益：应用层融合能同时保留两路原始分数（`scores.vector` / `scores.keyword`），
> 而 ES 原生 RRF 只给融合分，无法对比两路贡献 —— 对后续调优反而更有利。

### 5.3 删除联动 + 一致性兜底

ES 是独立系统，**无法与 PostgreSQL 共享事务**，因此采用「清理 + 兜底」双保险：

```
DELETE /documents/:id
  → 双库软删（既有逻辑，业务真源）
  → VectorIndexService.deleteByDocumentId(id)     // deleteByQuery，失败只记日志不阻断
```

兜底机制：**检索返回前按 `document_id` 回查 PostgreSQL，过滤掉已删除/不满足条件的文档**。
这样即使某次 ES 清理失败（网络抖动、节点不可用），也不会出现「已删除文档被召回」的数据泄漏。
批量回查最多 `topK` 个 ID，成本可忽略。

> 这是相对参考项目 P0（软删除不清 ES 向量）的正解：参考项目既没有清理、也没有兜底。

---

## 6. 与参考项目的差异汇总

| 维度 | 参考项目 v3 | 主项目（本设计） | 类别 |
| :--- | :--- | :--- | :--- |
| 向量与全文存储 | Elasticsearch `kh_chunk` | Elasticsearch `kh_chunk`（**同栈同名**） | 🟢 对齐 |
| 中文分词 | 装了 IK 但 mapping 未指定 | **显式配置** `ik_max_word` / `ik_smart` | 🔴 超越（修 P1） |
| 队列 | RabbitMQ topic | 阶段一同步；阶段二 BullMQ | 🟡 分叉（实现层） |
| 分块算法 | RecursiveCharacterTextSplitter + `\n# ` 补丁 | **照搬** | 🟢 对齐 |
| chunkId | `sha256(docId:index)` | **照搬** | 🟢 对齐 |
| 幂等 | 先 deleteByQuery 再 bulk | **照搬** | 🟢 对齐 |
| 嵌入模型 | 百炼 v3 / 1024 / batch ≤10 | **照搬** | 🟢 对齐 |
| 检索接口 | 无 | 新增 `RetrievalService` + `/search`，且支持混合检索 | 🔴 超越（补 P0） |
| 失败处理 | nack 丢弃，无重试 | 阶段一错误上抛+日志；阶段二重试退避 | 🔴 超越（修 P0） |
| 删除清理 | 不清向量 | 清理 + 检索侧兜底过滤 | 🔴 超越（修 P0） |
| 模块命名 | Chunking / Embedding / VectorIndex / Orchestrator | **同名** | 🟢 对齐（便于 grep 对照） |
| 检索入口 | 无 | `/search`（GET+POST），独立于 `/documents` | 🔴 超越（补 P0） |
| RRF 融合位置 | 无（无检索） | **应用层**（ES 原生 RRF 需商业 license） | 🔴 超越 |
| Orchestrator 入参 | `handleRagReindex(type, ids)` 自己查 PG+Mongo | `indexDocument(doc: PipelineDocument)` 由调用方加载 | 🟡 分叉（实现层，阶段二 consumer 复用同一管线） |
| Embedding 初始化 | 构造函数缺 Key 即 throw（拖垮启动） | **延迟初始化** | 🔴 超越（修 P1） |
| 发布入口 | `PUT /documents/:id/publish` | **同名同方法** `PUT /documents/:id/publish` | 🟢 对齐 |

---

## 7. 配置与环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ELASTICSEARCH_ENABLED` | `true` | 关闭时跳过写入与检索（降级不阻断启动） |
| `ELASTICSEARCH_NODE` | `http://localhost:9200` | |
| `EMBEDDING_API_KEY` / `DASHSCOPE_API_KEY` | 无（必填） | 百炼 API Key |
| `EMBEDDING_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点 |
| `EMBEDDING_MODEL` | `qwen3.7-text-embedding-flash` | 换模型必须**全量重索引** |
| `EMBEDDING_DIMENSION` | `1024` | **必须等于 mapping 的 `dims`** |
| `EMBEDDING_BATCH_SIZE` | `20` | 实际每批条数，受下一项钳制 |
| `EMBEDDING_MAX_BATCH_SIZE` | `20` | 模型单次上限：`qwen3.7` 系列 = 20；`text-embedding-v3/v4` = 10 |
| `RAG_CHUNK_SIZE` | `512`（token）→ 1024 字符 | 换算系数 `CHARS_PER_TOKEN = 2.0` |
| `RAG_CHUNK_OVERLAP` | `64`（token）→ 128 字符 | |
| `RAG_TOP_K` | `5` | 最终返回条数 |
| `RAG_KNN_K` / `RAG_KNN_CANDIDATES` | `50` / `200` | kNN 召回参数 |
| `RAG_RRF_WINDOW` / `RAG_RRF_CONSTANT` | `100` / `60` | RRF 融合参数 |

> 参考项目的教训（P1）：`EmbeddingService` 不得在构造函数中因缺 Key 直接 throw，否则拖垮整个应用启动。
> 本设计改为**延迟初始化**：首次使用时构造，失败抛明确业务异常并记录日志。
> ES 客户端同样降级处理：连接失败时置空并 warn，不阻断应用启动（该做法参考项目是对的，予以保留）。

---

## 8. 风险与待定项

| 项 | 说明 | 应对 |
| :--- | :--- | :--- |
| **跨系统一致性** | ES 与 PG 无法共享事务，删除/重建可能部分失败 | 清理 + **检索侧兜底过滤**（§5.3）；阶段二用队列补偿重试 |
| **同步执行耗时** | 长文档分块多 + 逐批调云端接口，`publish` 可能耗时数秒至数十秒 | 阶段一接受；若实测过长提前进入阶段二异步化 |
| **维度锁死** | `dims: 1024` 不可原地改 | 变更需删索引重建并全量重索引 |
| **版本强绑定** | ES 与 IK 版本必须严格一致 | 用 Dockerfile 固化版本，不依赖 latest |
| **资源占用** | ES 单节点 JVM 512MB 起步，生产需上调；本机多跑 2 个容器 | 本地用最小配置；生产单独评估规格 |
| **同步实时性** | `refresh_interval: 5s`，发布后短暂不可检索 | 写入时 `refresh=true` 强制刷新（参考项目做法） |
| **分词效果待实测** | `ik_max_word` 索引期膨胀率较高 | 阶段一先用标准组合，实测后决定是否改为 `ik_smart` 索引 |
| **中文分词的副作用** | 专有名词/型号可能被拆散，影响 BM25 精度 | 阶段三评估自定义词典或 Rerank 补救 |
| **鉴权过滤** | 检索不区分可见性 | 随 RBAC 一起做，届时把 `team_id` / 可见性过滤纳入 |
| **RRF 需商业 License**（实测） | ES 免费版执行 `retriever.rrf` 抛 `security_exception: current license is non-compliant for [RRF]` | 已改为**应用层 RRF**（§5.2）；若未来采购 Platinum 可切回原生，但无实质收益 |
| **ES 客户端/服务端版本差** | `^8.17.0` 实际装成 8.19.2，服务端为 8.17.0 | 实测可正常通信（ES 保证 8.x 内兼容）；如需严格对齐，把 Dockerfile 一并升到 8.19.x 并换对应 IK 版本 |
| **换模型需全量重索引** | 不同 embedding 模型向量空间不兼容，**即使维度相同**（1024→1024）也不能混用；旧向量与新查询算相似度无意义 | 切换 `EMBEDDING_MODEL` 后重跑全部已发布文档的索引；阶段二可用批量任务一键重建 |
| **模型额度/计费** | `text-embedding-v3` 账号无可用额度，已切 `qwen3.7-text-embedding-flash`（0.125 元/百万 tokens） | 若后续额度或价格变化，改 `EMBEDDING_MODEL` 即可，但要重索引（见上一行） |

---

## 9. 选型决策记录（含重新评估条件）

> 记录「为什么这么选」与「什么条件下推翻」，避免日后只看到结论、看不到前提。

### 9.1 队列：BullMQ + Redis（而非参考项目的 RabbitMQ）

**选择理由**
- Redis 已在架构规划内（缓存、分布式锁），**零新增组件**；RabbitMQ 是额外中间件。
- **重试/退避/失败隔离开箱即用**，直接根治参考项目 P0（消费失败 `nack(requeue=false)` 丢消息且无感知）。
- **内建任务状态查询**（`getJob` / `getJobCounts`），无需自建状态表即可感知索引进度与失败。
- `jobId` 去重天然防重复入队；内建限流器对云端 Embedding 的 QPS 限制很有用。

**已知短板**
- 跨语言能力弱（基本是 Node 生态）。若将来出现「Python 进程直接消费队列」的需求，需另引 RabbitMQ。
- 依赖 Redis 持久化，**生产必须开启 AOF**，否则宕机可能丢失少量已入队任务。

**MinerU 扩展性结论**
MinerU 为 Python + PyTorch 视觉模型，按设计备忘（`2026-09-15-document-ingestion-and-parser-design.md` §2.1）既定形态为**独立 HTTP 微服务（Docker/FastAPI）或云端 Open API**，由 Node Worker 消费 job 后以 HTTP 调用。
**该形态下 BullMQ 完全够用且更优**：MinerU 只是被调用的 HTTP 依赖，超时/重试/降级统一由 job 重试机制管理。
仅当改为「Python worker 直接消费队列」时，才需要改用 RabbitMQ——按 YAGNI，当前不为该可能性预先买单。

### 9.2 检索底座：Elasticsearch（最终选择，曾评估 pgvector）

**选择理由**
- **中文检索是硬需求**。PostgreSQL 内置 `tsvector` 对中文基本无效（中文无空格，simple 分词器把整句当一个 token），
  要做 BM25 需装 `zhparser`（需编译、与 PG 版本绑定，当前镜像未包含）；ES 的 IK 开箱即用。
- **混合检索原生支持**：kNN + BM25 + RRF 融合是 ES 8.17 的内建能力，无需自行实现融合逻辑。
- 与参考项目 v3 **同栈同名**（`kh_chunk` + `dense_vector`），可直接复用其已验证的编排与 mapping 经验。
- 规模演进空间大：分片机制可支撑远超 pgvector 舒适区的向量量级。

**为此付出的代价（必须知晓）**
1. **失去同库事务**：pgvector 方案下「删文档 + 删向量」可在一个事务内完成；ES 方案下只能最终一致。
   → 已用「清理 + 检索侧兜底过滤」补偿（§5.3），并在阶段二补队列重试。
2. **多两个容器**：ES 单节点 JVM 512MB 起步、Kibana 另计；生产需单独评估规格。
3. **运维复杂度上升**：JVM 调优、版本升级、索引生命周期管理。
4. **版本强绑定**：ES 与 IK 版本必须严格一致，升级时需同步。

**必须避免的参考项目教训**
- 参考项目装了 IK 却在 mapping 未指定分析器，`content` 走默认 standard，**中文被切成单字，等于白装**。
  本设计在 `content` / `document_title` 上显式指定 `ik_max_word` / `ik_smart`，并在验收中加入 `_analyze` 校验。

**重新评估条件（满足任一即重新评估回退 pgvector）**
- 规模长期停留在十万块以内，且确认不需要 BM25（纯语义检索即可）；
- ES 的资源占用或运维成本成为主要矛盾，且 `zhparser` 方案届时已成熟可用。

**迁移成本**：反向迁移同样集中在 `VectorIndexService` 与 `RetrievalService` 两个类，
`ChunkingService` / `EmbeddingService` / `RagOrchestrator` 无需改动（模块同名设计的收益）。

### 9.3 Embedding 模型：qwen3.7-text-embedding-flash（原定 text-embedding-v3）

**切换原因（2026-09-19）**：账号侧 `text-embedding-v3` 无可用额度，改用 `qwen3.7-text-embedding-flash`。

**为何这个替换是安全的（关键：维度未变）**

| 项 | text-embedding-v3 | qwen3.7-text-embedding-flash | 影响 |
| :--- | :--- | :--- | :--- |
| 默认维度 | 1024 | **1024**（可选 768/512/256） | ✅ `kh_chunk` 的 `dims=1024` **无需重建索引** |
| 单批上限 | 10 | **20** | ⚠️ 代码钳制常量需同步（已改为可配置的 `EMBEDDING_MAX_BATCH_SIZE`） |
| 最大输入 | 8K tokens | 128K tokens | ✅ 更宽松，长块不会被截断 |
| 价格 | — | 0.125 元/百万 tokens | 成本更低 |

**必须注意**：维度相同 ≠ 可以直接换。不同模型的向量空间不兼容，
若索引中已有 v3 生成的向量，切成 flash 后**必须全量重索引**，否则检索结果无意义。
（本项目切换时 `kh_chunk` 为空，无需历史重索引。）

**重新评估条件**
- 该模型额度/价格变化，或出现效果更好的同价位模型 → 改 `EMBEDDING_MODEL` 并全量重索引；
- 需要 sparse vector / task instruction 等高级能力 → 评估 `qwen3.7-text-embedding`（非 flash 版）。

---

## 10. 验收标准

> 2026-09-19 阶段一实现完成，逐项核对如下（未勾选项为阶段二/阶段三遗留）。

- [x] ES 容器正常启动，IK 插件加载成功（`_cat/plugins` 显示 `analysis-ik 8.17.0`）
- [x] `_analyze` 校验：`ik_smart` / `ik_max_word` 中文按词切分，**对照 standard 确认其为单字切分**（单测断言）
- [x] 发布真实文档后 `kh_chunk` 产生对应块，`embedding` 非空且维度 1024（端到端实测）
- [x] 同一文档重复发布块数不增长（幂等），`chunk_id` 稳定（单测断言 sha256(docId:index)）
- [x] `mode=vector` 能召回（端到端实测；mock embedding 端点验证链路）
- [x] 中文关键词检索可用：`mode=keyword` 中文词句有合理召回（端到端 + 单测）
- [x] `mode=hybrid` 融合结果合理，切换 mode 可对比（RRF 分 = Σ1/(60+rank) 已核对数值）
- [x] 软删除后向量块被清理；**模拟清理失败（ES 残留但 PG 已删）时检索仍不召回**（单测构造该场景）
- [x] 单测覆盖：空正文跳过分块、超长单段降级切分、多标题 heading 继承、embedding batch 钳制
- [x] `tsc --noEmit` 通过（`oxlint` 0 warning 0 error，34 个单测全绿）
- [ ] Kibana 容器启动验证（本次未启动，用 curl 直连 ES 完成验证）
