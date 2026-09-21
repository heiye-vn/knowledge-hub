# KG 知识图谱（kg 模块）

> **覆盖范围**：LLM 实体关系抽取、Neo4j 建图 / 删图 / 查询、BullMQ `kg.graph` 队列，
> 以及发布 / 删除链路的接入。对应代码 `apps/server/src/kg/`。
> 对照参考项目 knowledge-hub-backend v5（`pipeline/extraction.service.ts` +
> `graph-build.service.ts` + `kg-extraction.schema.ts`）。

---

## 一、为什么 KG 必须异步（与 v4 的 Search 相反）

实测（`apps/server/test/fixtures/` 下两个真实 PDF，qwen-plus，2026-09-20）：

| 文件 | 字符 | 块 | 耗时 | 平均/块 |
|---|---|---|---|---|
| 差旅费报销制度 | 1292 | 2 | **56.9s** | 28s |
| 生产发布 SOP | 1537 | 2 | **37.7s** | 19s |

- Search upsert 是毫秒级 ES 请求 → 同步（write-your-reads）；
- KG 抽取是**每块一次 LLM 调用**，单块 19~57s → 同步必撞网关超时，必须入队。
- 推算：30 块的文档并发 3 ≈ 4~10 分钟。因此有 `KG_MAX_CHUNKS=30` 截断与
  `KG_BUILD_BACKOFF_MS=30000` 的长退避。

判据一句话：**单篇 P95 < 8s 同步；含分钟级慢步骤必须异步，且必须有补偿入口**。

---

## 二、【实录】实测揪出的三个真 bug（前两个参考项目也有）

### 1. 先截断实体、再校验关系 → 关系被整片误杀

初版（与参考项目同逻辑）先按 `KG_MAX_ENTITIES=12` 截断实体，再用截断后的集合校验
关系的 source/target。实测 qwen-plus 单块产出 24~40 个实体 → 引用「第 13 个之后实体」
的关系全部被丢。**第一份测试文档关系数直接归 0**，第二份正常——典型的「测试数据不够
多样性就发现不了」。

**修法**：先用**全量**实体建池校验关系 → 再对实体做写入截断 → 被保留关系引用到的实体
必须补回（否则 Neo4j 侧 `MATCH` 不到节点，关系会**静默写不进去**，比丢弃更糟）。

**验证**：改前关系 0，改后 `raw=30实体/26关系, kept=30实体/26关系`。

### 2. 「事后补救」救不回跨块关系

最初想最后拿完整实体池把被误杀的关系重新放行一遍——**没用**，关系在第一次归一化时
就已经丢了，后面池再大也无济于事。

**修法**：`extract()` 增加 `knownEntities` 入参，边抽边累积文档级实体池，
后面的块可以直接引用前面块已抽到的实体。

**【易错】lint 还抓到我漏传这个参数**（`knownEntities` 声明了没往下传，oxlint
`no-unused-vars` 报警）——签名加了参数、函数体忘了用，正是最容易漏的一步。

### 3. 同形异码（U+2F2F vs U+5DE5）——只有真实数据能发现

样本实体名出现了 `全体员⼯`，那个 `⼯` 是康熙部首兼容字符（U+2F2F），不是
`工`（U+5DE5）。LLM 在实体和关系里字形不一致时，字符串比对不匹配 → 关系被丢。

**修法**：`entityKey(name) = name.trim().normalize('NFKC').toLowerCase()` 作为匹配 key，
并把关系的 source/target 回填为实体的规范名（保证 Neo4j MATCH 得到）。

**验证**：单测 `同形异码按 NFKC 归一，关系不被误杀`。

---

## 三、架构与命名

```
publish ──┬─ RAG 同步：分块 → Embedding → ES kh_chunk
          ├─ Search 同步：整篇快照 → ES kh_document
          └─ KG 异步：BullMQ kg.graph 队列 → Worker 抽取 + 写 Neo4j
remove ────  双清 ES + 投递 KG 删除任务
```

- **模块依赖刻意保持单向**：`DocumentModule → KgModule`（DocumentService 要投递任务），
  `KgModule` **不导入** `DocumentModule`——Worker 直接注入 `EntityManager` +
  `DocumentContent` 模型加载文档（与 `DocumentService.loadForIndex` 同形）。
  反向导入就是模块环，NestJS 虽有 `forwardRef` 但能不用就不用。
- **建图复用 RAG 同款 `ChunkingService`**：图谱块与向量块共用 `chunkId`，
  将来「向量召回 → 反查图谱」能直接对上。
- **图模型**（与参考项目一致）：
  `(KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)`，
  实体间 `(e)-[:RELATED_TO {relation, weight}]->(e)`。
  ⚠️ **边类型恒为 RELATED_TO**，语义在 `relation` 属性上，查询按属性过滤。

---

## 四、补偿与幂等

| 场景 | 手段 |
|---|---|
| 换 LLM 模型 / 修 bug 后全量重建 | `POST /kg/build`（不传 documentIds = BUILD_ALL，参考项目此消息类型无入口） |
| 建图失败 | BullMQ 重试（attempts=3，退避 30s→60s→120s）；失败明细汇总后抛错才触发重试 |
| 单块失败 | 不中断其余块；**全部块失败才算整篇失败**（部分失败保留成果） |
| 重复建图 | 先 `deleteForDocument` 再建 + MERGE 幂等，文档节点不翻倍（集成用例锁定） |
| 图膨胀 | 删图时清理「无任何块 MENTIONS」的孤儿实体 |

---

## 五、如何验证

```bash
# 0. 起 Neo4j
docker compose up -d neo4j   # http://localhost:7474，账号 neo4j / 12345678

# 1. 纯单测（无容器依赖）
pnpm --filter @knowledge-hub/server exec vitest run src/kg/

# 2. Neo4j 集成（会调真实 LLM，约 30s；Neo4j 不在线自动跳过）
pnpm --filter @knowledge-hub/server exec vitest run src/kg/graph-build.e2e.spec.ts

# 3. 真实 PDF 实测（消耗 token，默认跳过）
KG_E2E=1 pnpm --filter @knowledge-hub/server exec vitest run src/kg/extraction-e2e.spec.ts

# 4. 端到端：发布 → 看响应 kgQueued → 图查询
curl -s -X PUT localhost:3000/documents/<id>/publish          # kgQueued=true
curl -s "localhost:3000/kg/stats"                             # documents/chunks/entities/relations
curl -s "localhost:3000/kg/entities?keyword=财务部"
curl -s "localhost:3000/kg/neighbors?name=财务部"
```

---

## 已知局限与后续待办

> 本节是**本模块**的局限清单；正式登记的待实施改进项在
> [../TODO.md §4](../TODO.md#4-kgfeat-v5遗留项)（含触发条件与候选方案）。
> 注意：**下列都不是参考项目 v5 的功能缺口**，v5 对齐本身已完成。

1. **无任务状态查询接口**：BullMQ 有 jobId 但没有 `GET /kg/tasks/:id`，前端只能看日志。
   已登记到 TODO.md；与 `rag.reindex` 共用一套状态查询更划算，别做两份。
2. **关系噪声**：实测存在 LLM 产出「引用不存在实体」的关系（如某块 raw 38 关系 → kept 2），
   靠挂空实体过滤兜住，宁可少写不写悬空边。要提精度需换更大模型或加实体链接（entity linking）。
3. **无增量更新**：文档只改了几段也会全篇重抽（token 成本线性于全文字数）。
   后续可按 chunkId 比对，只重抽变更块。
4. **关系类型不是边类型**：查询「谁负责什么」要按 `r.relation` 属性过滤而非边类型，
   Neo4j 索引帮不上忙；数据量大后需评估把高频关系提升为边类型。
5. **apoc 插件已装未用**：与参考项目保持一致先装着；用到 `apoc.periodic.iterate`
   做大批量写时再启用。
