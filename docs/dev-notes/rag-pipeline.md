# RAG 索引与检索管线

> **模块范围**：文档发布后的向量化与检索能力（阶段一，同步执行）。
> **完成时间**：2026-09-19
>
> **对应代码**
> - `apps/server/src/rag/` —— 全部服务
> - `elasticsearch/Dockerfile`、`docker-compose.yml` 的 `es` / `kibana` —— 基础设施
> - `apps/server/src/document/document.service.ts` —— `publish()` / `remove()` 接入点
>
> 管线形状：`清旧块 → 分块 → 嵌入 → 写 ES`，检索为 `kNN + BM25 → RRF 融合`。
> 服务职责清晰切分（Chunking / Embedding / VectorIndex / Orchestrator / Retrieval）。

---

## 1. Elasticsearch 基础设施与索引

### 【实录】IK 插件版本必须与 ES 严格绑定

版本不匹配时，ES 节点**直接起不来**（不是降级运行）。
所以版本写死在自建 Dockerfile，不用 `latest`：

```dockerfile
FROM elasticsearch:8.17.0
RUN elasticsearch-plugin install --batch \
    https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-8.17.0.zip
```

Kibana 版本同样必须一致（`kibana:8.17.0`）。首次构建镜像约 4~5 分钟。

```bash
curl -s http://localhost:9200/_cat/plugins?v   # 应显示 analysis-ik 8.17.0
```

### ⭐【实录】IK 装了 ≠ 生效，必须在 mapping 显式指定 analyzer

若装了 IK 但 mapping 里没指定 analyzer，`content` 走了默认 `standard`，**中文被切成单字，IK 等于白装**。

本项目显式指定，且索引期与查询期用不同粒度：

```jsonc
"content": {
  "type": "text",
  "analyzer": "ik_max_word",      // 索引期细粒度：提高召回
  "search_analyzer": "ik_smart"   // 查询期粗粒度：提高精度
}
```

验证**必须做对照**，不能只看插件列表是否加载：

```bash
# 期望：["企业级","知识库","检索系统","支持","中文","分词"]
curl -s -X POST http://localhost:9200/_analyze \
  -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_smart","text":"企业级知识库检索系统支持中文分词"}'
```

### 【易错】索引创建并发与幂等

`createIndexIfNotExists` 集中到单一服务中，并提供并发防重容错保护。

```ts
// 并发创建时可能已被别的流程先建好，视为成功
if (!isAlreadyExists(err)) throw err;
```

### 【易错】`dims: 1024` 不可原地修改

`dense_vector` 的 `dims` 建索引后不能改。变更 `EMBEDDING_DIMENSION` 必须**删索引重建 + 全量重索引**。

为此加了启动期维度校验：索引已存在时比对 `embedding.dims` 与配置值，不一致直接报错并给出处置指引——
避免出现「写入时报 400 但不知道根因」这种最难排查的故障。

### 【易错】ES 客户端 / 服务端版本差

`^8.17.0` 实际装成 **8.19.2**，服务端 **8.17.0**。实测可正常通信（ES 保证 8.x 内兼容）。
曾尝试锁 `~8.17.0`，但 `pnpm add` 被本机 safe-delete 批量保护拦截，保留现状。
若将来出现奇怪的响应结构差异，这是第一个要排查的点。

---

## 2. 文档分块 ChunkingService

采用 LangChain `RecursiveCharacterTextSplitter` 进行 Markdown 感知分块。

### ⭐【实录】`RAG_CHUNK_SIZE` 单位是 **token**，不是字符

系统实现中按 `chunkSize = tokens × 2.0` 折算，即 **`RAG_CHUNK_SIZE=512` 得到 1024 字符的块**。

最初若按"最终字符数"的直觉在 `.env` 写了 `1024`，结果块变成 **2048 字符**，比预期大一倍。

```bash
# 单位：token（代码内 ×2 换算为字符）
RAG_CHUNK_SIZE=512
RAG_CHUNK_OVERLAP=64
```

> 这类改动**不报错**，只让检索质量悄悄变差，是最难发现的一类问题。

### 【易错】内置 markdown 分隔符不含 H1

`getSeparatorsForLanguage('markdown')` 返回列表里**没有 `\n# `**，只有 `\n## ` 及更深层级。
不补的话一级标题不会作为切分边界：

```ts
separators: ['\n# ', ...RecursiveCharacterTextSplitter.getSeparatorsForLanguage('markdown')]
```

### 【易错】heading 跨块继承 + 前缀补全

同一章节的后继块通常**不含标题行**，直接用原文本做 embedding 会丢失章节语境。

处理：提取标题 → 更新 `currentHeading` → 若当前块自身无标题行，正文前补 `heading + '\n\n'`。
**送去做 embedding 的是补全后的 `content`**，这样语义里才带上章节信息。

### 【易错】chunkId = sha256(documentId:index)

稳定 ID 是幂等的基石（见 §4）。`sha256(documentId:index)` 生成 64 位定长十六进制串，确保 Chunk 全局唯一。

---

## 3. 文本向量化 EmbeddingService

云端方案：百炼 OpenAI 兼容端点 + LangChain `OpenAIEmbeddings`。
模型：**`qwen3.7-text-embedding-flash`**（1024 维，支持大上下文）。

### ⭐【实录】构造函数里 throw 会拖垮整个应用启动

```ts
// ❌ 错误写法：构造函数缺 Key 直接 throw，会导致整个应用连 /health 都起不来
constructor(config: ConfigService) {
  if (!apiKey) throw new Error('未配置 API Key');
}
```

本项目改为**延迟初始化**：首次使用时才构造，缺 Key 抛明确业务异常但不影响启动，
并提供 `isConfigured()` 供上层判断是否降级。
已固化成单测：`缺 API Key 时构造函数不抛异常`。

### ⭐【实录】维度相同 ≠ 可以直接换模型，必须全量重索引

| 项 | text-embedding-v3 | qwen3.7-text-embedding-flash |
| :--- | :--- | :--- |
| 默认维度 | 1024 | **1024**（可选 768/512/256） |
| 单批上限 | 10 条 | **20 条** |
| 最大输入 | 8K tokens | 128K tokens |
| 价格 | — | 0.125 元 / 百万 tokens |

**维度没变，所以索引不用重建** —— 这很容易让人以为改配置就能切。**但不行**：
不同模型向量空间不兼容，旧向量与新查询算出的相似度**没有意义**，
表现为「检索突然全部失准，且不报任何错」。

切换 `EMBEDDING_MODEL` 后**必须重跑全部已发布文档的索引**。

### 【实录】单批上限随模型变化，硬编码会埋雷

不同供应商单批上限不同（10 或 20 条），超过会 `400 InvalidParameter`。
本项目改为可配置 `EMBEDDING_MAX_BATCH_SIZE`（默认 20），换模型只需改配置环境变量。

### 【易错】`stripNewLines: false`

保留换行符。Markdown 分块含换行，strip 掉会让标题与正文粘连，损失结构语义。

---

## 4. 向量写入 VectorIndexService

### 【易错】幂等怎么保证

写入采用批量 Bulk 操作：对已存在的 `chunkId` 执行覆盖更新，清旧块时根据 `document_id` 统一删除历史块，确保单篇文档重复发布不产生脏块。

检查 `response.items[].index.error`：若不检查，部分写入失败会被静默吞掉——表现为「发布成功但检索不到，且没有任何报错」。

### 【易错】空 embedding 不写入

`buildDocMap` 只在 `embedding?.length` 存在时带该字段。缺失向量不会导致写入失败，
但那批文档**无法被 kNN 召回**——排查时先看 ES 里对应文档有没有 `embedding` 字段。

---

## 5. 混合检索 RetrievalService

支持 `hybrid`（默认）／`vector`／`keyword` 三种模式。本模块补齐了完整的召回与融合能力。

### ⭐⭐【实录】kNN 没有"相关性"概念，必然返回 topK 条（影响最大的缺陷）

**现象**：用真实 API 验证时，问了知识库里**完全没有**的内容，依然返回 3 条结果：

```
查询：手头紧想提前支取工资   → 返回 3 条（0.7081 / ...）
查询：今天天气怎么样         → 返回 3 条（0.6519 / ...）
```

**原因**：kNN 的语义是「找出向量空间里最近的 K 个」，**不是**「找出相关的」。
只要库里有数据就一定能凑满 topK 条，它不知道什么是"不相关"。

**危害**：低分噪声直接喂给 LLM，轻则答案跑偏，重则一本正经地编造（幻觉）。

**解法**：新增 `RAG_MIN_SCORE` 门槛，低于阈值直接丢弃：

```ts
const kept = hits.filter((h) => (h.scores.vector ?? 0) >= minScore);
```

> BM25 没有这个问题（无词项匹配即不返回），所以只需给向量路设阈值。

### ⭐【实录】阈值必须实测校准，不能拍脑袋

先后测试真实数据分布：

| 阶段 | 阈值 | 结果 |
|:---|:---|:---|
| 第一次 | 0.75 | ❌ 把「数据备份多久做一次」（0.7478）**误杀**——这条是字面完全匹配的正确结果 |
| 最终 | **0.72** | ✅ 保留全部正确结果，拦掉全部不相关结果 |

实测（`qwen3.7-text-embedding-flash`，3 篇中文制度文档）：

| 查询 | 分数 | 判定 |
|:---|:---|:---|
| 出差住酒店能报销多少钱 | 0.8050 | ✅ 相关 |
| 一年能休多少天假 | 0.7814 | ✅ 相关 |
| 口令多久要换一次 | 0.7722 | ✅ 相关 |
| 数据备份多久做一次 | **0.7478** | ✅ 相关 ← 分界上沿 |
| 手头紧想提前支取工资 | **0.7081** | ❌ 不相关 ← 分界下沿 |
| 今天天气怎么样 | 0.6519 | ❌ 不相关 |

分界落在 **0.7478 与 0.7081** 之间 → 取 **0.72**（偏保守：宁可漏召也不误召）。

> ⚠️ 换 embedding 模型或换语料后**必须重新校准**。当前值只对
> `qwen3.7-text-embedding-flash` + 这批测试语料有效。

### ⭐【实录】ES 的 cosine `_score` 是 `(1+cos)/2`，不是原始余弦

构造测试向量时以为 cosine=0.5 会得到 `_score=0.5`，实际得到 **0.75**。
ES 对 `similarity: cosine` 返回的是**映射值** `(1 + cos) / 2 ∈ [0, 1]`。

**记住**：`_score = 0.72` 对应的真实余弦只有 **0.44**。
调阈值时尺度搞错会整体偏移，而且非常隐蔽——看起来能跑，只是效果不对。

### 【实录】应用层 RRF 反而比原生更好用

```ts
// score = Σ 1/(k + rank_i)，rank 从 1 开始；rank_constant = 60
```

- 两路查询用 `Promise.all` **并发**发出
- 融合时**同时保留两路原始分数**，而原生 RRF 只给融合分：

```json
{ "score": 0.0328, "scores": { "vector": 0.8050, "keyword": 1.8807 } }
```

调优时一眼看出是向量路还是关键词路在起作用——这是改用应用层实现的意外收益。

### 【易错】`score` 量级差异不要误判

- `mode=hybrid`：RRF 融合分，**0.0x 是正常的**
- `mode=vector` / `keyword`：该路原始分

看原始分请读 `scores.vector` / `scores.keyword`。

### 【易错】默认只检索已发布文档

查询固定带 `term: { doc_status: 1 }`，草稿与归档不参与召回。

---

## 6. 跨系统一致性（ES ↔ PostgreSQL）

### 【易错】根源：ES 与 PG 无法共享事务

选 ES 做检索底座的代价。一旦 ES 侧操作失败或软删除后未同步清理，
就会出现**已删除文档仍能被检索命中**的数据泄露风险。

### 解法：清理 + 兜底，双保险

**第一层 · 删除时主动清理**（`document.service.ts → remove()`）

```ts
try {
  await this.ragOrchestrator.deleteDocument(id);
  vectorsCleaned = true;
} catch (err) {
  // 只记日志，不阻断删除：索引是派生数据，不能反过来卡住业务主流程
  this.logger.error(`删除文档后清理 ES 向量块失败：documentId=${id}, ${message}`);
}
return { id, deleted: true, vectorsCleaned };   // 回传真实结果，不假装成功
```

**第二层 · 检索时兜底过滤**（`retrieval.service.ts → search()`）

结果返回前回查 PG 复核文档仍「未删除且已发布」，批量一次查完（只 `select: { id: true }`）：
```ts
const liveDocIds = new Set((await this.docRepo.find({ where: { id: In(docIds), deleted: false, status: DocumentStatus.PUBLISHED } })).map(d => d.id));
return hits.filter(h => liveDocIds.has(h.documentId));
```

---

## 7. 模块边界与单向依赖

`RagModule` 专注于 RAG 向量管线；文档的审核与生命周期由 `DocumentModule` 编排。
外部失败进入 Outbox 补偿表，确保检索索引与数据库最终一致。
