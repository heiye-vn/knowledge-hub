# RAG 索引与检索管线

> **模块范围**：文档发布后的向量化与检索能力（阶段一，同步执行）。
> **完成时间**：2026-09-19　　**对应提交**：`a0f3ab7` / `ab62c0e` / `d349765`
>
> **对应代码**
> - `apps/server/src/rag/` —— 全部服务
> - `elasticsearch/Dockerfile`、`docker-compose.yml` 的 `es` / `kibana` —— 基础设施
> - `apps/server/src/document/document.service.ts` —— `publish()` / `remove()` 接入点
>
> **设计文档**：[2026-09-19-rag-indexing-pipeline-design.md](../superpowers/specs/2026-09-19-rag-indexing-pipeline-design.md)
> **实施计划**：[2026-09-19-rag-indexing-phase1.md](../superpowers/plans/2026-09-19-rag-indexing-phase1.md)
>
> 管线形状：`清旧块 → 分块 → 嵌入 → 写 ES`，检索为 `kNN + BM25 → RRF 融合`。
> 服务命名（Chunking / Embedding / VectorIndex / Orchestrator）刻意与参考项目保持一致，便于两项目对照。

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

**这是从参考项目继承来的教训（其 P1 缺陷）**：它装了 IK，但 mapping 里没指定 analyzer，
`content` 走了默认 `standard`，**中文被切成单字，IK 等于白装**。

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

# 对照：standard 逐字切分，tokens 长度 == 字数
curl -s -X POST http://localhost:9200/_analyze \
  -H 'Content-Type: application/json' \
  -d '{"analyzer":"standard","text":"企业级知识库检索系统支持中文分词"}'
```

这条对照已固化成单测断言（`elasticsearch.service.spec.ts`），改坏 mapping 会立刻失败。

### ⭐【实录】ES 免费版不支持原生 RRF（是 license 问题，不是版本问题）

设计时写的是「优先用 ES 8.17 原生 `retriever.rrf`，版本不支持则降级」。
实际一跑就报错：

```
security_exception: current license is non-compliant for [Reciprocal Rank Fusion (RRF)]
```

RRF 是 ES 的**商业特性**，免费 basic license 无权使用。**落地改为应用层 RRF**（见 §5）。

### 【实录】索引并发创建撞车

报错 `resource_already_exists_exception: index [kh_chunk] already exists`，
但代码里明明先 `indices.exists()` 检查过。

原因：`onModuleInit` 里 fire-and-forget 调了一次 `ensureIndex()`，业务侧同时也在调，
两个流程**都**通过 exists 检查，然后**都**去 create。

解法（`elasticsearch.service.ts`）——单例 Promise 锁 + 幂等容错，双保险：

```ts
async ensureIndex(): Promise<void> {
  if (!this.indexReady) {
    this.indexReady = this.doEnsureIndex().catch((err) => {
      this.indexReady = null;   // 失败不缓存，允许下次重试
      throw err;
    });
  }
  return this.indexReady;
}

// 并发创建时可能已被别的流程先建好，视为成功
if (!isAlreadyExists(err)) throw err;
```

> 参考项目把 `createIndexIfNotExists` 分散在多个服务里且无并发保护，这里集中到一个服务。

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

策略**照搬**参考项目（LangChain `RecursiveCharacterTextSplitter` + markdown 感知）。

### ⭐【实录】`RAG_CHUNK_SIZE` 单位是 **token**，不是字符

参考项目实现是 `chunkSize = tokens × 2.0`，即 **`RAG_CHUNK_SIZE=512` 得到 1024 字符的块**。

我最初按"最终字符数"的直觉在 `.env` 写了 `1024`，结果块变成 **2048 字符**，比预期大一倍。

```bash
# 单位：token（代码内 ×2 换算为字符），与参考项目语义一致
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

稳定 ID 是幂等的基石（见 §4）。参考项目后面还跟了 `.slice(0, 64)`，对 sha256 hex 是 no-op，不照抄。

---

## 3. 文本向量化 EmbeddingService

云端方案：百炼 OpenAI 兼容端点 + LangChain `OpenAIEmbeddings`。
模型：**`qwen3.7-text-embedding-flash`**（原定 `text-embedding-v3`，因账号无额度切换）。

### ⭐【实录】构造函数里 throw 会拖垮整个应用启动（参考项目 P1）

```ts
// ❌ 参考项目的写法：没配 Key，连 /health 都起不来
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
（本次切换时 `kh_chunk` 为空，无历史包袱。）

### 【实录】单批上限随模型变化，硬编码会埋雷

v3/v4 = 10，qwen3.7 系列 = 20，超过会 `400 InvalidParameter`。
参考项目把 `10` 硬编码；本项目改为可配置 `EMBEDDING_MAX_BATCH_SIZE`（默认 20），
换回旧模型只改环境变量，不动代码。

### 【易错】`stripNewLines: false`

照搬参考项目。Markdown 分块含换行，strip 掉会让标题与正文粘连，损失结构语义。

---

## 4. 向量写入 VectorIndexService

### 【易错】幂等怎么保证

两步配合，缺一不可：

```
1. deleteByQuery(document_id = X)   ← 先清该文档旧块
2. bulk(index, _id = chunkId)       ← 再以稳定 ID 覆盖写
```

`_id = chunkId` 是关键：同一文档的同一块在任何次发布中都得到相同 `_id`，bulk 覆盖而非新增。
重复发布块数不增长。已固化成单测。

### 【实录】ES 8.x 的 `hits.total` 是**对象**不是数字

`expect(res.hits.total).toBe(3)` 失败，实际是 `{ value: 3, relation: 'eq' }`
（除非请求加 `rest_total_hits_as_int=true`）。取 `.value` 即可。

### 【易错】bulk 的 `errors` 必须显式检查

bulk **不会因为部分文档失败而抛异常**，HTTP 层面是 200，失败信息藏在
`response.items[].index.error` 里。不检查的话，部分写入失败被静默吞掉——
表现为「发布成功但检索不到，且没有任何报错」。

### 【易错】空 embedding 不写入

`buildDocMap` 只在 `embedding?.length` 存在时带该字段。缺失向量不会导致写入失败，
但那批文档**无法被 kNN 召回**——排查时先看 ES 里对应文档有没有 `embedding` 字段。

---

## 5. 混合检索 RetrievalService

支持 `hybrid`（默认）／`vector`／`keyword` 三种模式。
**参考项目完全没有检索能力**（只写不读，其 P0 缺陷），本模块是补上的，
所以坑基本都是第一次遇到。

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

我先后试了两个值，**第一个就是错的**：

| 阶段 | 阈值 | 结果 |
|:---|:---|:---|
| 第一次 | 0.75 | ❌ 把「数据备份多久做一次」（0.7478）**误杀**——这条是字面完全匹配的正确结果 |
| 最终 | **0.72** | ✅ 保留全部正确结果，拦掉全部不相关结果 |

校准方法：起临时实例关掉阈值测真实分布。

```bash
PORT=3001 RAG_MIN_SCORE=0 node dist/main.js
```

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

选 ES 做检索底座的代价（选型过程见 spec §9.2）。一旦 ES 侧操作失败，
就会出现**已删除文档仍能被检索命中**——数据泄漏级别。
参考项目的 P0 正是：软删除后**完全不清 ES 向量**，且无任何补偿。

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
const rows = await this.em.find(DocumentEntity, {
  where: { id: In(unique), deleted: false, status: DocumentStatus.Published },
  select: { id: true },
});
const results = candidates.filter((c) => alive.has(c.documentId));
```

> 单测专门构造了场景：ES 残留 `doc_status=1` 的块但 PG 已软删 → 断言不被召回。
> 日志「检索结果已过滤下线文档」是观察 ES 清理失败频率的窗口，**别删**。

**第三层 · ES 侧状态过滤**：查询固定带 `doc_status: 1`。

### 【易错】发布流程的顺序取舍

```
PUT /documents/:id/publish
  1. 落 PG 状态（status=1, publishTime）  ← 业务真源，先落
  2. 同步执行 RAG 管线
  3. 失败直接上抛
```

先落状态再索引：反过来会导致「索引成功但状态没变」，文档在列表里仍是草稿却能被检索到，更难排查。

失败后：管线幂等，**客户端可直接重试 publish**；阶段二上队列后由重试退避自动兜底。
索引链路整体不可用时（ES 未启用或缺 Key）**仍完成发布**，返回 `indexed: false` 并 warn。

---

## 7. 验证命令速查

```bash
# 基础设施
curl -s http://localhost:9200/_cat/indices?v
curl -s http://localhost:9200/kh_chunk/_count
curl -s http://localhost:9200/kh_chunk/_mapping

# 检索（三种模式对比）
curl -s -G http://localhost:3000/search \
  --data-urlencode "query=出差住宿能报销多少" --data-urlencode "mode=hybrid"

# 端到端
curl -s -X PUT http://localhost:3000/documents/<id>/publish   # 看 indexed / chunks
curl -s -X DELETE http://localhost:3000/documents/<id>        # 看 vectorsCleaned
```

完整命令见 [Apifox 集合](../apifox/knowledge-hub.postman_collection.json) 与
[test/manual/curl3.md](../../apps/server/test/manual/curl3.md)。

---

## 8. 已知局限与后续待办

| 项 | 说明 | 计划 |
|:---|:---|:---|
| 阈值区分度有限 | 相关 0.7478~0.8050 与不相关 0.6519~0.7081 区间太近 | 阶段三引入 **Rerank 模型**做精排 |
| 口语化查询效果差 | 「东西误删了还能找回来吗」仅 0.6247 且召回错文档 | 查询改写（LLM）或 Rerank |
| BM25 侧无阈值 | 偶然词项匹配（「工资」→「薪资」）仍会召回 | 必要时加 `RAG_MIN_KEYWORD_SCORE`（需单独校准） |
| 阈值需按真实语料重校准 | 0.72 仅基于 3 篇文档样本 | 真实语料上线前重测 |
| 发布为同步执行 | 长文档会阻塞请求数秒~数十秒 | 阶段二 BullMQ 异步化 + 重试退避 |
| 分块参数未实测 | 1024 字符 / 128 overlap 为经验值 | 真实语料实测召回质量后调整 |
| 未用父子分块 | 平面 overlapping-window，命中精确但上下文不足 | 需要时加 `parent_id`，成本低 |

以上同步记录在 [TODO.md](../TODO.md) 与 spec 风险表。
