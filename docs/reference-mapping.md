# 参考项目映射对照表（knowledge-hub-backend ↔ knowledge-hub）

> **文档定位**：`knowledge-hub-backend` 是**只读的参考项目**（分支 `v3`），`knowledge-hub` 是**真正在做的主项目**。
> 本文件是两者之间的映射登记簿：记录「参考项目的哪个模块，对应主项目的哪个模块」，
> 以及**哪里有意分叉、为什么分叉、参考项目的哪些缺陷主项目已修复**。
>
> **维护约定**：每次主项目有意偏离参考项目时，在「分叉登记」追加一行。
> 有了这份登记，分叉永远是有据可查的演进，而不是无声的漂移。

---

## 一、 核心原则：模式层对齐，实现层可换，缺陷层超越

参考项目的价值在于**模式层**（管线形状、职责切分、消息契约、幂等模式、已知坑），
这些与技术选型无关；**实现层**（具体队列、具体向量库）可以替换而不损失参考价值；
**缺陷层**（参考项目踩过的坑）恰恰是主项目要超越的地方。

---

## 二、 模块级映射总表

| 参考项目 v3 | 主项目 knowledge-hub | 关系 | 说明 |
| :--- | :--- | :--- | :--- |
| `PUT /documents/:id/publish` | 同名接口（阶段一实现） | 🟢 对齐 | 同步写库 + 触发管线；触发失败不回滚已发布状态。**仅草稿/已发布可发布**，归档文档拒绝（守卫见分叉登记 2026-09-19） |
| `mq/mq.constants.ts`（exchange / queue / routing key） | `mq/mq.constants.ts`（队列名 `rag.reindex`）**已实现** | 🟡 分叉 | topic 交换机 + 路由键 → BullMQ 单个队列，路由语义交给 `job.data.type` |
| `mq/messages/pipeline.messages.ts`（`{taskId, type, documentIds}`） | 同名文件**已实现** | 🟢 对齐 | 字段同名照搬，保持契约形状一致 |
| `mq/document-pipeline.publisher.ts` | `RagReindexPublisher`**已实现** | 🟢 对齐 | 职责同（投递重建任务）；差异：参考项目是发布后自动投递，本项目publish 保持同步，队列只服务批量重建（方案 B） |
| `mq/document-pipeline.consumer.ts` | `RagReindexWorker`**已实现** | 🟡 分叉 | 换成 BullMQ Worker；**并修复丢弃消息的问题**（失败抛错 → 自动重试 + 指数退避） |
| `mq/rabbitmq.service.ts` | 连接配置内联在 Publisher/Worker | 🟡 分叉 | 未单独抽连接服务：BullMQ 的 Queue/Worker 各自管理连接，再包一层无收益 |
| `pipeline/pipeline.orchestrator.ts` | `RagOrchestrator`（同名职责） | 🟡 分叉 | 管线形状一致（清旧块→分块→嵌入→写 ES）；入参改为已加载的 `PipelineDocument`，加载职责上移到调用方 |
| `pipeline/chunking.service.ts` | `ChunkingService`（**同名**） | 🟢 对齐 | 分块策略 + heading 前缀补全照搬 |
| `pipeline/embedding.service.ts` | `EmbeddingService`（**同名**） | 🟡 分叉 | 同为百炼 OpenAI 兼容协议 + 1024 维；模型换为 `qwen3.7-text-embedding-flash`（v3 无可用额度），单批上限 20（v3 为 10） |
| `pipeline/vector-index.service.ts` | `VectorIndexService`（**同名**） | 🟢 对齐 | 同栈同名：`kh_chunk` + `dense_vector`；主项目额外显式配置 IK 分析器 |
| `pipeline/types/pipeline.types.ts` | 同名类型文件 | 🟢 对齐 | `DocumentChunk` 字段保持一致 |
| （无） | `RetrievalService` | 🔵 新增 | **参考项目缺失**：只有写入没有检索；主项目补 kNN + BM25 混合检索 |
| （无，散落在 VectorIndexService） | `ElasticsearchService` | 🔵 新增 | 客户端单例 + `kh_chunk` 索引初始化（IK + dense_vector）与维度校验；避免多处各自 new Client |
| （无） | 删除联动清向量 + 检索侧兜底 | 🔴 超越 | **参考项目缺陷**：软删除不清向量，会召回已删文档。主项目因 ES 无同库事务，额外加检索侧兜底过滤 |
| （无） | IK 分析器显式配置 | 🔴 超越 | **参考项目缺陷**：IK 装了未用，中文切成单字 |
| （无） | `POST /rag/reindex` 批量重建入口 | 🔵 新增 | **参考项目缺失**：只有「发布后自动投递」，无手动/批量触发，换 embedding 模型后无法重建存量向量。本项目按方案 B 保持 publish 同步，故必须有显式入口 |
| （无） | 失败重试 + 指数退避 | 🔴 超越 | **参考项目缺陷**：消费失败 `nack(requeue=false)`，无 DLX 无重试，一次超时该文档索引永久丢失且无感知 |
| （无） | 队列连通性探测（`waitUntilReady` + 超时） | 🔴 超越 | 【易错】`new Queue()/new Worker()` 只创建对象，连不上也返回实例；据此判「可用」会让接口假装可用、入队时挂住 |
| **v4** `pipeline/search-index.service.ts` | `search/search-index.service.ts` | 🟡 分叉 | 同为 ES `kh_document` 文档级索引（upsert / delete）；写入时机改为同步、正文全量、显式 IK（详见分叉登记 2026-09-20） |
| **v4**（无） | `search/search.controller.ts` → `GET\|POST /search/documents` | 🔵 新增 | **参考项目 v4 仍只写不读**；主项目补齐文档级检索 + 高亮，供搜索结果页使用 |
| **v4** 无（MQ 单独投递 delete） | `DocumentService.remove` 同步双清 | 🟡 分叉 | 删除时一块清理 `kh_chunk` + `kh_document`，响应带 `vectorsCleaned` / `searchCleaned` |
| **v4** 无（Search 不参与重建） | `RagReindexWorker` 同步重建两条索引 | 🔵 新增 | 只重建一侧会导致「语义检索是新数据、全文搜索还是旧的」；Search 失败同样抛错触发重试 |

图例：🟢 对齐（照搬模式） 🟡 分叉（换实现，保留语义） 🔵 新增（参考项目没有） 🔴 超越（修复参考项目缺陷）

---

## 三、 分叉登记（每次偏离时追加）

| 日期 | 分叉点 | 参考项目做法 | 主项目做法 | 分叉理由 |
| :--- | :--- | :--- | :--- | :--- |
| 2026-09-19 | 异步队列 | RabbitMQ topic 交换机 | Redis + BullMQ（阶段二） | Redis 本就在架构规划内，零新增组件；BullMQ 自带重试/退避/任务状态查询，直接修掉参考项目的消息丢弃问题 |
| 2026-09-19 | 检索形态 | 只写不读，无检索接口 | kNN + 中文 BM25 双路召回 + RRF 融合 | 参考项目补不上的能力；选 ES 正是为了原生支持混合检索 |
| 2026-09-19 | 中文分词 | 装了 IK 但 mapping 未指定分析器 | 显式配置 `ik_max_word` / `ik_smart` 并做 `_analyze` 验证 | 修参考项目 P1：不指定分析器则中文被切成单字，IK 等于白装 |
| 2026-09-19 | RRF 融合位置 | 无检索，不涉及 | **应用层** RRF（并发双路查询后按 `Σ1/(60+rank)` 融合） | ES 原生 `retriever.rrf` 属商业特性，免费版抛 `security_exception`；应用层融合还能保留两路原始分数便于调优 |
| 2026-09-19 | Orchestrator 入参 | `handleRagReindex(type, ids)` 内部按 ID 查 PG+Mongo | `indexDocument(doc: PipelineDocument)`，由调用方加载 | 阶段一同步调用时调用方已有完整文档，避免重复查询；阶段二 consumer 只需「按 ID 加载 → 调用」，复用同一管线 |
| 2026-09-19 | Embedding 初始化时机 | 构造函数缺 Key 直接 throw | 延迟初始化，首次使用时才构造 | 修参考项目 P1：构造期 throw 会拖垮整个应用启动 |
| 2026-09-19 | 检索接口路径 | 无 | `/search`（GET + POST），独立于 `/documents` | 检索是独立资源，路径语义更清晰；保留 GET 版便于 curl 快速验证 |
| 2026-09-19 | Embedding 模型 | `text-embedding-v3`（单批 ≤10） | `qwen3.7-text-embedding-flash`（单批 ≤20） | 账号侧 v3 无可用额度。默认维度同为 1024，索引结构不变；单批上限改为可配置 `EMBEDDING_MAX_BATCH_SIZE` |

> 说明：向量存储在本轮评估过 pgvector，最终**决定与参考项目保持一致使用 Elasticsearch**，
> 原因是中文 BM25 为硬需求（PG 侧需 `zhparser`，成本高）。评估过程与代价记录在
> [规格文档 §9.2](file:///e:/Study/AI%20Agent/knowledge-hub/docs/superpowers/specs/2026-09-19-rag-indexing-pipeline-design.md)。
> 因此本项**不属于分叉**，而是对齐；为此付出的代价是失去「删文档+删向量同库事务」，
> 已用「清理 + 检索侧兜底过滤」补偿。
| 2026-09-19 | 源文件元数据 | 不落库（与上传响应同生命周期） | `kh_document` 五列持久化（**已实现**） | 支持列表/详情展示、重解析、对象清理反查 |
| 2026-09-19 | 双写补偿 | 无（Mongo 先写，PG 失败留脏数据） | PG 失败补偿删除 Mongo 记录（**已实现**） | 主项目编码规范强制要求跨库补偿 |
| 2026-09-19 | 发布状态守卫 | 仅「草稿 / 已发布」可发布，归档文档拒绝 | 初始实现**漏了该校验**（任何状态都能发布）→ 已补齐为一致（**已实现**） | 此前属**无意偏离**（未登记），对照 v3 时发现。归档是终态，放开会让已下线文档被重新向量化并回到检索结果；已加单测锁住边界 |
| **2026-09-20** | **Search 索引写入时机**（v4） | MQ 消费者异步写（`search.index.exchange` + `kh.search.index.queue`） | **publish / remove 内同步写**（响应带 `searchIndexed` / `searchCleaned`） | 参考项目 publish 本就全异步；我们 publish 是同步管线（方案 B），Search upsert 是一次 ES 请求（毫秒级），同步可保证 write-your-reads。判据与阈值自适应方案见 [dev-notes/search-index.md](./dev-notes/search-index.md) |
| **2026-09-20** | **Search 消息结构**（v4） | `SearchIndexMessage`（消息内带文档快照） | **不引入**：直接传 `PipelineDocument` 对象 | 无 MQ 就没有消息体积问题，无需序列化快照 |
| **2026-09-20** | **索引正文长度**（v4） | `content` 截前 **1000 字** | **全量写入** | 1000 字截断是 MQ 消息体积导致的弱点，长文档后半段搜不到；我们无此约束，且高亮需要完整正文 |
| **2026-09-20** | **kh_document 分词**（v4） | `title/summary/content` 裸 `text`，**未指定 IK** | 显式 `ik_max_word` / `ik_smart` | 修参考项目 P1 的**第二次复发**（v3 的 kh_chunk 已犯过一次，v4 又犯）。已有单测断言锁住 |
| **2026-09-20** | **MQ 删除消息类型**（v4） | `ReindexType` 扩 `'DELETE_BY_DOC_IDS'` | **不引入**：删除同步执行 | 枚举扩展是异步化的产物；我们 delete 直接调 `SearchIndexService` / `RagOrchestrator`，无消息类型可分 |
| **2026-09-20** | **文档级搜索接口**（v4） | **无**（v4 只写索引，没有读接口） | `GET|POST /search/documents`（带 highlight） | 补参考项目 P0「只写不读」在 v4 的延续；`/search` 已被块级检索占用，故加子路径避免破坏既有契约 |
| **2026-09-20** | **两条索引的可用性判定**（v4） | 一起判定（ES 不可用则全跳过） | **分开判定**：RAG 需 ES + Embedding Key，Search 只需 ES | 没配 Embedding Key 时文档搜索仍应可用，不能一刀切把整条链路判死。已加单测覆盖三种组合 |

---

## 四、 参考项目已知缺陷清单（主项目必须避免）

> 来源：2026-09-18 对 `knowledge-hub-backend` v3 分支的代码分析。

| 级别 | 缺陷 | 后果 | 主项目对策 |
| :--- | :--- | :--- | :--- |
| **P0** | 消费失败 `nack(msg, false, false)`，无 DLX 无重试 | 一次限流/超时，该文档索引永久丢失且无感知 | 阶段二用 BullMQ 重试 + 退避 + 失败隔离；阶段一同步执行，错误直接返回 |
| **P0** | 只写不读，无任何检索接口 | 管线是单向管道，无下游消费方 | 阶段一即实现 `RetrievalService` + 检索接口 |
| **P0** | 软删除文档不清 ES 向量块 | 已删除文档仍被召回，数据泄漏级 | 删除/下架联动清理向量块 |
| P1 | `EmbeddingService` 构造函数无 Key 直接 throw | 拖垮整个应用启动，即使关闭 ES/MQ 也起不来 | 延迟初始化 + 启动自检告警，不阻断应用 |
| P1 | 装了 IK 分词器但 mapping 未指定 | 中文被切成单字，IK 等于白装 | **显式指定** `ik_max_word`（索引）/`ik_smart`（查询），并用 `_analyze` 验收 |
| P1 | 注释反复提到 KG（知识图谱）但未实现 | 预留未落地 | 不照抄该预留，主项目暂不涉及 |
| P2 | 未用父子分块（平面 overlapping-window） | 命中精确但返回上下文不足 | 本阶段沿用平面分块（与参考一致）；确认效果后再评估父子分块，届时加 `parent_id` 列成本很低 |
| P2 | `chunkId` 的 `.slice(0, 64)` 对 sha256 hex 是 no-op | 无害冗余 | 不照抄冗余代码 |

---

## 五、 主项目已领先参考项目之处

- 双写补偿（PG 失败删 Mongo）
- 统一响应信封 + 全局异常过滤（参考项目无）
- 原生 ESM 规范与工程约定文档（AGENTS.md / docs）
- 源文件元数据持久化（参考项目缺失）
- TODO 缺口清单沉淀机制（docs/TODO.md）
- **混合检索能力**（kNN + 中文 BM25 + RRF）+ 三种 mode 对比（参考项目无检索）
- **检索侧一致性兜底**：ES 清理失败时仍能靠 PG 复核拦住已删文档
- **索引初始化幂等与并发保护**：单例 Promise + `resource_already_exists` 容错（参考项目多处各自建索引且无锁）
- **向量维度一致性校验**：启动时比对 `embedding.dims` 与 `EMBEDDING_DIMENSION`，避免写入时才报 400 却不知根因
- **文档级搜索索引与接口**（2026-09-20）：参考项目 v4 写了 `kh_document` 却没有读接口；主项目补齐并带 highlight
- **两条索引可用性分开判定**（2026-09-20）：RAG 需 ES + Embedding Key，Search 只需 ES，缺 Key 时搜索仍可用
- **批量重建覆盖两条索引**（2026-09-20）：`/rag/reindex` 同时刷新 `kh_chunk` 与 `kh_document`，避免两侧数据漂移
