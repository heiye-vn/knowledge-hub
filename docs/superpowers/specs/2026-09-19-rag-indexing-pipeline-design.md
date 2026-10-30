# RAG 索引与检索管线设计规格（阶段一）

> **文档状态**：设计就绪 / 待实施
> **创建日期**：2026-09-19
> **修订**：2026-09-19 二次修订 —— 向量与全文检索由 pgvector 改为 **Elasticsearch 8.17 + IK**（决策依据见 §9.2）
> **关联模块**：`apps/server`（Rag / Document / Storage）

---

## 1. 背景与已定决策

文档摄取阶段已完成：元数据（PostgreSQL）+ 正文（PostgreSQL 内容表）+ 源文件元数据（`kh_document` 五列）均已闭环。
下一步是把「已发布的文档」变成「可被检索的知识」。

**已拍板的决策：**

| 决策项 | 结论 |
| :--- | :--- |
| Embedding 方案 | 云端阿里云百炼 **`qwen3.7-text-embedding-flash`**，OpenAI 兼容协议，**1024 维** |
| 向量 + 全文检索 | **Elasticsearch 8.17.0 + IK 中文分词** |
| 检索形态 | **混合检索**：向量 kNN + 中文 BM25，RRF 融合 |
| 异步队列 | **阶段一不做**，`publish` 同步执行；阶段二再引入 Redis + BullMQ 批量重建 |
| 分块策略 | LangChain `RecursiveCharacterTextSplitter`，Markdown 感知 |
| 父子分块 | 阶段一不做，效果验证后再评估 |

**为什么最终选 ES 而非 pgvector**：中文关键词检索是硬需求。PostgreSQL 内置 `tsvector` 对中文基本无效，要做 BM25 需装 `zhparser`（需编译、与 PG 版本绑定）；而 ES 的 IK 分词开箱即用，且 kNN 与 BM25 的混合检索是其原生能力。完整权衡与代价见 §9.2。

**为什么先同步后异步**：切分与召回效果尚未验证，先加异步层会拉长调试链路。同步版跑通后，把执行体搬进 Worker 即可，编排代码无需重写。

---

## 2. 目标与非目标

**目标**
1. 发布文档 → 分块 → 向量化 → 落 ES，形成写入闭环
2. **混合检索**：向量 kNN + 中文 BM25 双路召回 + RRF 融合（选 ES 的核心收益）
3. 重复发布幂等；文档删除联动清向量，并有**检索侧兜底**防止已删文档被召回
4. 中文分词可用且可验证（显式配置 IK，并用 `_analyze` 验收）

**非目标（本阶段不做）**
- 异步队列、失败重试、任务状态表 → 阶段二
- Rerank 二次精排（如 bge-reranker）→ 阶段三
- 父子分块 → 待效果评估
- 鉴权过滤（按用户/团队可见性）→ 随 RBAC 一起做
- 多模态解析（MinerU）→ 独立议题

---

## 3. 数据模型

检索侧全部落在 Elasticsearch 索引 **`kh_chunk`**。

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

### 3.2 基础设施

`docker-compose.yml` 新增两个服务：

| 服务 | 镜像 | 端口 | 要点 |
| :--- | :--- | :--- | :--- |
| `es` | 本地 `./elasticsearch` Dockerfile（`FROM elasticsearch:8.17.0` + `elasticsearch-plugin install` IK 8.17.0） | 9200 | `discovery.type=single-node`、关闭 xpack 安全与 SSL、`ES_JAVA_OPTS=-Xms512m -Xmx512m` |
| `kibana` | `kibana:8.17.0`（版本须与 ES 完全一致） | 5601 | `ELASTICSEARCH_HOSTS=http://es:9200`，`depends_on: es` |

---

## 4. 模块划分

```
apps/server/src/rag/
├── rag.module.ts
├── rag.orchestrator.ts        # 加载 → 清旧 → 分块 → 嵌入 → 落库
├── chunking.service.ts        # Markdown 感知递归切分 + heading 前缀补全
├── embedding.service.ts       # 百炼 qwen3.7-text-embedding-flash，batch 钳制 ≤ 20（可配置）
├── vector-index.service.ts    # ES 版写入/清理/建索引
├── retrieval.service.ts       # 检索侧（kNN + BM25 + RRF）
├── es/
│   ├── es.module.ts
│   └── es-client.service.ts   # ES 连接与降级（不可用时置空 + warn）
├── dto/
│   ├── search.dto.ts
│   └── search-result.dto.ts
└── types/rag.types.ts         # DocumentChunk 等基础类型
```

**接入点**
- `DocumentService.publish(id)` → 触发编排（`PUT /documents/:id/publish`）
- `DocumentService.remove(id)` → 软删除后调用 `VectorIndexService.deleteByDocumentId`
- `DocumentController` → `PUT :id/publish`、`POST documents/search`

---

## 5. 核心流程

### 5.1 发布索引（阶段一：同步）

```
PUT /documents/:id/publish
  → 校验文档存在且状态 ∈ {草稿, 已发布}
  → 更新 PG 状态为 Published，刷新 publish_time
  → RagOrchestrator.indexDocument(doc)
      ├─ VectorIndexService.deleteByDocumentId(id)       // 清理历史旧块
      ├─ ChunkingService.split(content, metadata)         // 递归分块 + 补全 heading
      ├─ EmbeddingService.embedDocuments(chunkTexts)     // 批量嵌入（每批 ≤ 20）
      └─ VectorIndexService.bulkInsert(chunksWithVec)    // 写入 ES
  → 返回 { id, status, publishTime, indexed: true, chunks: N }
```

### 5.2 混合检索与应用层 RRF

```
POST /documents/search
  → 校验入参（query, topK, mode, categoryId, teamId 等）
  → 并发执行两路检索：
      ├─ kNN 向量检索（通过 Dense Vector 相似度打分）
      └─ BM25 全文检索（通过 ik_smart 分词匹配）
  → 应用层 RRF 融合打分：score = Σ 1 / (60 + rank_i)
  → 返回 TopK 候选结果
```

### 5.3 跨系统一致性兜底

由于 Elasticsearch 与 PostgreSQL 无法共享事务，若 ES 清理失败可能导致脏数据。
通过在检索返回时批量回查 PostgreSQL 中文档的未删除状态（`deleted = false`），做检索侧最终兜底过滤。

---

## 6. 核心架构设计与防坑决策

| 维度 | 设计方案 | 架构决策收益 |
| :--- | :--- | :--- |
| **向量与全文存储** | Elasticsearch `kh_chunk` | 原生兼具向量索引与全文分词能力 |
| **中文分词** | **显式配置** `ik_max_word` / `ik_smart` | 规避未指定分词器导致的单字切分缺陷 |
| **队列策略** | 阶段一同步发布；阶段二引入 BullMQ 批量重建 | 阶段一快速验证链路，阶段二削峰与可重试 |
| **分块算法** | RecursiveCharacterTextSplitter + Markdown 边界补丁 | 保护 Markdown 层级语义与标题完整度 |
| **chunkId 命名** | `sha256(docId:index)` | 保证跨批次、跨重建时的幂等覆盖 |
| **幂等更新** | 先 deleteByQuery 再批量 bulk 写入 | 彻底规避重复发布产生的孤儿数据块 |
| **检索形态** | `RetrievalService` 支持 hybrid / vector / keyword 三模式 | 兼顾口语化语义与精准词汇匹配 |
| **删除联动** | 删除主动清向量 + 检索侧 PG 存活状态回查 | 彻底杜绝软删除文档残留检索的数据泄露风险 |
| **Embedding 初始化** | **延迟初始化** | 规避因暂缺配置 Key 导致整个进程启动失败的问题 |
| **RRF 融合位置** | **应用层融合** | 零依赖商业特性，同时完整保留两路原始分数便于排查调优 |

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
| `RAG_MIN_SCORE` | `0.72` | 向量召回最低分，低于此值丢弃。**换模型/换语料必须重新校准** |

> 【架构原则】：`EmbeddingService` 不得在构造函数中因缺 Key 直接 throw，否则拖垮整个应用启动。
> 本设计采用**延迟初始化**：首次使用时构造，失败抛明确业务异常并记录日志。
> ES 客户端同样降级处理：连接失败时置空并 warn，不阻断应用启动。

---

## 8. 风险与待定项

| 项 | 说明 | 应对 |
| :--- | :--- | :--- |
| **跨系统一致性** | ES 与 PG 无法共享事务，删除/重建可能部分失败 | 清理 + **检索侧兜底过滤**（§5.3）；阶段二用队列补偿重试 |
| **同步执行耗时** | 长文档分块多 + 逐批调云端接口，`publish` 可能耗时数秒至数十秒 | 阶段一接受；若实测过长提前进入阶段二异步化 |
| **维度锁死** | `dims: 1024` 不可原地改 | 变更需删索引重建并全量重索引 |
| **版本强绑定** | ES 与 IK 版本必须严格一致 | 用 Dockerfile 固化版本，不依赖 latest |
| **资源占用** | ES 单节点 JVM 512MB 起步，生产需上调；本机多跑 2 个容器 | 本地用最小配置；生产单独评估规格 |
| **同步实时性** | `refresh_interval: 5s`，发布后短暂不可检索 | 写入时 `refresh=true` 强制刷新 |
| **分词效果待实测** | `ik_max_word` 索引期膨胀率较高 | 阶段一先用标准组合，实测后决定是否改为 `ik_smart` 索引 |
| **中文分词的副作用** | 专有名词/型号可能被拆散，影响 BM25 精度 | 阶段三评估自定义词典或 Rerank 补救 |
| **鉴权过滤** | 检索不区分可见性 | 随 RBAC 一起做，届时把 `team_id` / 可见性过滤纳入 |
| **RRF 需商业 License**（实测） | ES 免费版执行 `retriever.rrf` 抛 `security_exception: current license is non-compliant for [RRF]` | 已改为**应用层 RRF**（§5.2）；若未来采购 Platinum 可切回原生，但无实质收益 |
| **ES 客户端/服务端版本差** | `^8.17.0` 实际装成 8.19.2，服务端为 8.17.0 | 实测可正常通信（ES 保证 8.x 内兼容）；如需严格对齐，把 Dockerfile 一并升到 8.19.x 并换对应 IK 版本 |
| **换模型需全量重索引** | 不同 embedding 模型向量空间不兼容，**即使维度相同**（1024→1024）也不能混用；旧向量与新查询算相似度无意义 | 切换 `EMBEDDING_MODEL` 后重跑全部已发布文档的索引；阶段二可用批量任务一键重建 |
| **模型额度/计费** | 改用 `qwen3.7-text-embedding-flash`（0.125 元/百万 tokens） | 若后续额度或价格变化，改 `EMBEDDING_MODEL` 即可，但要重索引（见上一行） |
| **相似度阈值区分度有限**（实测） | 相关查询 0.7478~0.8050，不相关 0.6519~0.7081，**区间接近甚至可能重叠**；口语化查询（如「东西误删了还能找回来吗」）相似度仅 0.62 且会召回错文档 | 阶段三引入 **Rerank 模型**（qwen3-rerank / bge-reranker）做精排，或用 LLM 做查询改写；`RAG_MIN_SCORE` 只是止血手段 |
| **BM25 侧无阈值** | 关键词路没有最低分门槛，词项偶然匹配（如「工资」→「薪资」）仍会召回 | 必要时加 `RAG_MIN_KEYWORD_SCORE`；BM25 分数无归一化上界，需单独校准 |

---

## 9. 选型决策记录（含重新评估条件）

> 记录「为什么这么选」与「什么条件下推翻」，避免日后只看到结论、看不到前提。

### 9.1 队列：BullMQ + Redis

**选择理由**
- Redis 已在架构规划内（缓存、分布式锁），**零新增组件**；RabbitMQ 是额外中间件。
- **重试/退避/失败隔离开箱即用**，规避消费失败直接丢消息无感知的隐患。
- **内建任务状态查询**（`getJob` / `getJobCounts`），无需自建状态表即可感知索引进度与失败。
- `jobId` 去重天然防重复入队；内建限流器对云端 Embedding 的 QPS 限制很有用。

**已知短板**
- 跨语言能力弱（基本是 Node 生态）。若将来出现「Python 进程直接消费队列」的需求，需另引 RabbitMQ。
- 依赖 Redis 持久化，**生产必须开启 AOF**，否则宕机可能丢失少量已入队任务。

**MinerU 扩展性结论**
MinerU 为 Python + PyTorch 视觉模型，按设计备忘既定形态为**独立 HTTP 微服务（Docker/FastAPI）或云端 Open API**，由 Node Worker 消费 job 后以 HTTP 调用。
**该形态下 BullMQ 完全够用且更优**：MinerU 只是被调用的 HTTP 依赖，超时/重试/降级统一由 job 重试机制管理。

### 9.2 检索底座：Elasticsearch（最终选择，曾评估 pgvector）

**选择理由**
- **中文检索是硬需求**。PostgreSQL 内置 `tsvector` 对中文基本无效，要做 BM25 需装 `zhparser`；ES 的 IK 开箱即用。
- **混合检索原生支持**：kNN + BM25 + RRF 融合是 ES 8.17 的内建能力，无需自行实现融合逻辑。
- 规模演进空间大：分片机制可支撑远超 pgvector 舒适区的向量量级。

**为此付出的代价（必须知晓）**
1. **失去同库事务**：pgvector 方案下「删文档 + 删向量」可在一个事务内完成；ES 方案下只能最终一致。
   → 已用「清理 + 检索侧兜底过滤」补偿（§5.3），并在阶段二补队列重试。
2. **多两个容器**：ES 单节点 JVM 512MB 起步、Kibana 另计；生产需单独评估规格。
3. **运维复杂度上升**：JVM 调优、版本升级、索引生命周期管理。
4. **版本强绑定**：ES 与 IK 版本必须严格一致，升级时需同步。

**【核心避坑】**
- mapping 必须显式指定 IK 分析器，避免 `content` 走默认 standard 逐字切分。本设计在 `content` / `document_title` 上显式指定 `ik_max_word` / `ik_smart`，并在验收中加入 `_analyze` 校验。

---

## 10. 验收标准

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
