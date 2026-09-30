# RAG 精排与 AI 对话（feat-v11）

> **模块范围**
> Reranker 精排（DashScope text-rerank）接入混合检索链路、
> `/ai/chat` 检索 + 生成 + `[n]` 引用溯源、`/search` 检索接口挂权限码。
>
> **对应代码路径**
> `rag/reranker.service.ts`、`rag/retrieval.service.ts`（接入点）、
> `ai/ai-chat.service.ts`、`ai/ai.controller.ts`、`ai/dto/chat.dto.ts`
>
> **对应讲次**：第 60 讲（基线实现 v11）

---

## 一、 精排在管线中的位置

```
双路召回（kNN + BM25）→ RRF 融合 → 取 RAG_HYBRID_TOP_K 候选（默认 20）
  → PG 一致性兜底（剔除已删 / 非发布文档）
  → reranker 精排（relevance_score 重排）
  → 截 RAG_TOP_K（默认 5）返回
```

**精排放 PG 兜底之后**：兜底先剔除已下线文档，rerank 只给活文档打分，
不浪费 API 额度。基线实现没有 PG 兜底层，是「先精排后返回」。

**单路模式（vector / keyword）不精排**：rerank 的价值是修正「双路融合后
排名失真」，单路结果本身就是该路的原始排序，没有修正对象。

## 二、 DashScope text-rerank 接入要点

- 模型 **`qwen3.7-text-rerank`**（与 embedding qwen3.7-text-embedding-flash 同代，Key 共用）
- API：`POST {RERANK_BASE_URL}/api/v1/services/rerank/text-rerank/text-rerank`，
  body 为 `{ model, input: { query, documents }, parameters: { return_documents: false, top_n } }`
- **documents 拼「标题 + heading + 正文」，截 2000 字**：正文超长会拖慢打分，
  截断对相关性判断影响很小
- `return_documents: false`：只回传 index + relevance_score，本地按索引
  回填原 hit，避免响应里重复搬正文
- **索引越界防御**：结果里 index 超出候选数范围的条目直接丢弃

## 三、 降级设计：rerank 永远不能搞挂检索

四层降级，全部返回 `null` 由上层回退 RRF 顺序：

1. 未启用（`RAG_RERANK_ENABLED=false`）或未配置 Key
2. HTTP 非 2xx（Key 失效 / 限流）
3. 返回空 `results`
4. fetch 抛异常（超时 / 网络抖动）

上层写法：`return (reranked ?? results).slice(0, topK)`。

## 四、 引用溯源设计（/ai/chat）

```
检索（复用 RetrievalService，继承 MIN_SCORE 过滤 + PG 兜底）
  → buildContext：[n] 编号 + 标题/heading + 正文截 800 字
  → system prompt：只根据资料回答、不足说不知道、句末必须标 [n]
  → LLM 生成（qwen-plus，temperature 0.2）
  → 正则 /\[(\d+)\]/g 抽出实际引用的编号（越界忽略）
  → sources 只返回被引用条目；一条都没标则回退全部召回
  → 每条 source 带 200 字 excerpt（非整块正文）
```

**为什么 sources 不直接等于召回列表**：召回 5 条 LLM 可能只用 3 条，
把没用的也返给前端会让「引用溯源」变成装饰。抽 [n] 才能对齐
「回答里的每个论断 → 具体资料」的展示效果。

**无命中不调 LLM**：检索空直接返回「知识库里没有相关内容。」，
省一次生成额度；未配置 Key 且检索有结果时才抛 503。

## 五、 Key 回退链（与 extraction.service 对齐）

```
RERANK_API_KEY → LLM_API_KEY → EMBEDDING_API_KEY → OPENAI_API_KEY
```

基线 v11 的回退链是 DASHSCOPE/OPENAI——主项目没有 DASHSCOPE_API_KEY
变量，沿用 extraction 建立的「百炼全家桶共用一个 Key」习惯。
⚠️ 唯一例外：**VLM 的 Key 严格物理隔离**（见 image-document-parser 笔记），
rerank / chat 不允许回退到 VLM_API_KEY。

## 六、 【实录】构造函数加参导致既有 spec 编译失败

`RetrievalService` 注入 `RerankerService` 后，`retrieval.service.spec.ts`
5 处 `new RetrievalService(...)` 全部缺参——tsc 报错但 vitest 依旧绿
（**vitest 不做类型检查**，不跑 tsc 就漏了）。

修法：spec 顶部加 `fakeReranker()`（isEnabled false + rerank 返回 null），
perl 按 `fakeEntityManager(` 行前批量插入。既有集成用例期望的正是
「无精排时按 RRF 顺序返回」，fake 的行为恰好匹配，无需改断言。

## 七、 如何验证

```bash
# 1. 精排链路（需 RERANK_API_KEY 或 LLM_API_KEY 已配置）
curl -X POST localhost:3000/search -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"报销流程","mode":"hybrid","topK":5}'
# 日志应出现「Rerank 完成：model=qwen3.7-text-rerank, in=20, out=5」

# 2. 对话溯源
curl -X POST localhost:3000/ai/chat -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"公司的报销流程是什么？","topK":5}'
# answer 句末应带 [n]；sources 应只含被引用条目

# 3. 降级验证：RERANK_API_KEY 填错值后重查，日志出现
# 「Rerank 调用失败」且检索仍正常返回（RRF 顺序）
```

单测：`reranker.service.spec.ts`（mock fetch 九场景）、
`ai-chat.service.spec.ts`（mock 检索与 LLM 七场景）。

## 八、 与基线实现的分叉汇总

| 分叉点 | 基线 v11 | 主项目 | 理由 |
| :--- | :--- | :--- | :--- |
| reranker 归属 | `ai/` 模块 | `rag/` 模块 | 精排是检索链路组件，ai 模块只做对话编排 |
| 精排对象 | RRF 融合后直接送 | PG 兜底后再送 | 不给已下线文档浪费打分额度 |
| 检索复用 | HybridRetrievalService 自实现 | 复用 RetrievalService | 继承 MIN_SCORE 过滤与一致性兜底 |
| 路由 | `/rag/search` + `/ai/chat` | `/search`（既有）+ `/ai/chat` | 路由契约稳定优先 |
| 溯源 | 同款 [n] 设计 | 同款 | 模式层对齐 |
