---

## 发布文档（直接发布，无审核）

```bash
DOC_ID='docid'
```

将草稿（或已发布文档）设为已发布，并**同步**执行 RAG 管线（分块 → Embedding → 写入 ES `kh_chunk`）。

```bash
curl -s -X PUT "http://localhost:3000/documents/${DOC_ID}/publish"
```

> ⚠️ 本项目**阶段一为同步执行，没有消息队列**。
> 参考项目 `knowledge-hub-backend` 才走 RabbitMQ 异步解耦（本项目阶段二会引入 BullMQ）。
>
> 响应示例：
> ```json
> {"code":200,"data":{"id":"...","status":1,"publishTime":"...","indexed":true,"chunks":3}}
> ```
> `indexed=false` 表示索引链路不可用（ES 未启用或未配 `EMBEDDING_API_KEY`），
> 此时仍会完成发布，只是没建索引。

---

## 检索（本项目新增，参考项目没有）

```bash
# 混合检索（默认）：kNN 向量 + BM25 关键词 + RRF 融合
curl -s -G http://localhost:3000/search \
  --data-urlencode "query=出差住宿能报销多少" \
  --data-urlencode "mode=hybrid" --data-urlencode "topK=5"

# 纯向量（语义召回）
curl -s -G http://localhost:3000/search --data-urlencode "query=年假几天" --data-urlencode "mode=vector"

# 纯关键词（BM25 + IK 分词）
curl -s -G http://localhost:3000/search --data-urlencode "query=年假" --data-urlencode "mode=keyword"

# POST 版（查询词含特殊字符时更稳妥）
curl -s -X POST http://localhost:3000/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"报销标准","mode":"hybrid","topK":5}'
```

返回体的 `scores` 会分别给出 `vector` / `keyword` 两路原始分，便于对比调优：

```json
{"chunkId":"...","documentTitle":"费用报销管理制度","score":0.0328,
 "scores":{"vector":0.8050,"keyword":1.8807}}
```

> `score` 是 RRF 融合分（`Σ 1/(60+rank)`），量级很小（0.0x）是正常的；
> `mode=vector` / `mode=keyword` 时 `score` 才是该路的原始分数。
>
> `mode=vector` 中低于 `RAG_MIN_SCORE`（默认 0.72）的结果会被丢弃
> —— kNN 必然返回 topK 条，没有门槛会把无关内容也带出来。

---

## ES 侧查询（Elasticvue / curl 通用）

```bash
# 索引概况
GET /_cat/indices?v

# 查看全部块（embedding 是 1024 维，建议排除以免刷屏）
GET /kh_chunk/_search
{
  "size": 100,
  "_source": { "excludes": ["embedding"] },
  "query": { "match_all": {} }
}

# 中文全文检索（验证 IK 生效：应能按词命中，而非单字）
GET /kh_chunk/_search
{
  "query": { "match": { "content": "年假" } },
  "_source": { "excludes": ["embedding"] }
}

# 分词效果验证（确认不是单字切分）
GET /_analyze
{ "analyzer": "ik_smart", "text": "企业级知识库检索系统支持中文分词" }

# 索引 mapping / 向量维度
GET /kh_chunk/_mapping
```

### kNN 向量检索（需自备 1024 维查询向量，日常用 /search 更方便）

```bash
GET /kh_chunk/_search
{
  "size": 5,
  "_source": { "excludes": ["embedding"] },
  "knn": {
    "field": "embedding",
    "query_vector": [/* 1024 个 float */],
    "k": 50,
    "num_candidates": 200
  }
}
```

---

## 清理演示数据

```bash
for id in <文档ID列表>; do curl -s -X DELETE "http://localhost:3000/documents/$id"; done
```

删除文档会联动清理该文档在 `kh_chunk` 的全部向量块（返回 `vectorsCleaned: true`）。
