# 文档级搜索索引（search 模块）

> **覆盖范围**：ES `kh_document` 索引的写入 / 删除 / 检索，以及它在发布、删除、批量重建
> 三条链路上的接入。对应代码 `apps/server/src/search/`。

---

## 一、它和 RAG 检索不是一回事

| | `kh_chunk`（RAG） | `kh_document`（本模块） |
| :--- | :--- | :--- |
| 粒度 | 一篇文档切成 N 块 | 一篇文档一条记录 |
| 索引内容 | 块文本 + 1024 维向量 | 标题 / 摘要 / 全文 + 元数据 |
| 服务场景 | 语义检索，结果喂给 LLM | 关键词搜索结果页 + 高亮 |
| 依赖 | ES **+ Embedding Key** | 只要 ES |
| 接口 | `GET\|POST /search` | `GET\|POST /search/documents` |

**【易错】两条链路的可用性必须分开判定。** RAG 缺 Embedding Key 就不可用，
但文档搜索只依赖 ES。若沿用「一处不可用 → 整条索引链路判死」的写法，
没配 Key 的环境里发布后文档搜不到，而这个故障看起来像「搜索功能坏了」，
排查时很容易误判成索引没写进去。已在 `DocumentService.publish` 里拆成两个
`isAvailable()`，并用单测覆盖三种组合（都可用 / 只有 Search / 都不可用）。

---

## 二、为什么采用同步写策略

在文档发布（publish）与删除（remove）时，对文档级搜索索引采用同步写入：

1. **Search upsert 是一次单条 ES 文档请求，耗时仅几毫秒。** 实测索引耗时的大头在 Embedding 向量计算与切块，文档级全文 upsert 开销与之相比极低。
2. **同步才能保证 write-your-reads（即读即写一致性）。** 异步方案下用户点完发布、立刻去搜索框搜自己的文档会有不可见的空窗期，易造成“发布成功但搜不到”的用户困惑。

**【实录】判据不是「同步好还是异步好」，而是「单篇耗时落在哪个区间」：**

| 场景 | 选择 | 理由 |
| :--- | :--- | :--- |
| 单篇发布，P95 < 3–8s | 同步 | write-your-reads，语义清晰 |
| 单篇含慢步骤（KG 抽取 / 多模态），> 10s | 异步 | 否则撞网关超时 |
| 批量导入 / 全量重建 | 异步 + 并发控制 | 削峰、可重试 |

---

## 三、关键架构设计与踩坑规避

| 常见设计隐患 | 本项目设计方案 | 选型技术理由 |
| :--- | :--- | :--- |
| `content` 截前 **1000 字** | **全量写入** | 消息体积或字段截断会让长文档后半段彻底搜不到，且正文高亮需要完整内容 |
| mapping 裸 `text`，**未指定 IK** | 显式 `ik_max_word` / `ik_smart` | 未指定分词器会导致中文按 standard 单字切分，丧失词义召回能力。已加单测断言锁住三个字段的 analyzer |
| `tags` 直接写字符串 | 逗号分隔拆成 **keyword 数组** | 逗号分隔字符串直接写 ES 会被当成一个整体 term，无法精确按标签做 Term 过滤 |

**【易错】ES 索引名 `kh_document` 与 PG 表名 `kh_document` 同名。**
排查日志时务必看清是 TypeORM 还是 ES client 打的。索引名可用
`ELASTICSEARCH_DOC_INDEX` 覆盖，默认值保持 `kh_document`。

---

## 四、删除与重建的一致性

- **删除**：`DocumentService.remove` 清 `kh_chunk` 和 `kh_document`，**两个 try 分开**，
  一侧失败不连累另一侧；响应带 `vectorsCleaned` / `searchCleaned`。
- **批量重建**：`POST /rag/reindex` 的 Worker 现在**同时**重建两条索引。
  【易错】只重建一侧会造成「语义检索是新数据、全文搜索还是旧的」这种半更新状态，
  而且现象很隐蔽（两种搜索结果对不上）。Search 失败同样抛错以触发 BullMQ 重试。

---

## 五、如何验证

```bash
# 1. 纯单测（无需容器）：断言 mapping 的 IK 配置
pnpm typecheck:server && pnpm test:server

# 2. 集成用例（需本地 ES + IK，否则 skipIf 跳过）
docker compose up -d es
pnpm test:server   # search-index.service.spec.ts 的集成用例会跑

# 3. 端到端：发布 → 检索 → 删除 → 检索
curl -s -X PUT localhost:3000/documents/<id>/publish        # 看 searchIndexed
curl -s "localhost:3000/search/documents?query=差旅费"       # 看 hits[].highlight
curl -s -X DELETE localhost:3000/documents/<id>             # 看 searchCleaned
curl -s "localhost:3000/search/documents?query=差旅费"       # 应为空

# 4. 确认 IK 真的生效（不是 standard 单字切分）
curl -s -X POST "localhost:9200/kh_document/_analyze" -H 'Content-Type: application/json' \
  -d '{"analyzer":"ik_max_word","text":"差旅费报销管理办法"}'
```

---

## 已知局限与后续待办

1. **无高亮标签配置**：目前硬编码 `<em>` / `</em>`，前端需要其他标签时再加环境变量。
2. **无同义词 / 别名词典**：企业知识库里「报销」与「费用申请」同义是常态，
   后续应在 `settings.analysis` 里挂 IK 同义词。
3. **计数类字段不回写**：`view_count` 等写进 ES 后不会随 PG 更新同步，
   只有重新发布或 `/rag/reindex` 才刷新——搜索结果里显示的浏览量可能滞后。
