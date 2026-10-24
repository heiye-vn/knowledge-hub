# Agentic RAG：意图路由、检索评估与自主循环（feat-v17）

> **模块覆盖范围**
>
> - `apps/server/src/ai/chat-query-rewrite.service.ts`：五类意图路由、切题评估、不足后检索改写
> - `apps/server/src/ai/agentic-retrieve.ts`：单次检索 + 评估、非流式「检索 → 改写 → 再查」
> - `apps/server/src/ai/ai-stream.service.ts`：每轮 Agent、工具挂载、检索上限、过程事件
> - `apps/server/src/ai/ai-chat.service.ts`：非流式 Agentic RAG 与按需联网
> - `apps/web/src/chat-message-utils.ts`、`components/ChatMessageParts.tsx`、`pages/ChatPage.tsx`、`index.css`：意图/评估/改写/来源时间线与滚动交互
>
> **对应基线实现**：后端 `v17`；前端参考分支为 `v17`（本项目前端无 v16 分支，实际从 v14/v15 UI 直接升级）
> **分叉总表**：[docs/reference-mapping.md](../reference-mapping.md) 第三节

---

## 一、 链路形状

```text
建/续会话（touchTitle，内部 assertOwned）
→ 加载短期记忆
→ classify：意图 + standalone_query
→ 写 data-intent
→ 拉长期记忆
→ 按意图挂工具建 Agent
→ Agent 循环
   ├─ retrieve_knowledge：检索 + 切题评估（最多 2 次）
   ├─ rewrite_query：不足后改写（必须有上一次检索）
   └─ web_search：仅 web / kb_then_web 挂载
→ 正文与工具事件流
→ onFinish：按 [n] 只落库实际引用来源 + 双层记忆
```

流式 `data-*` 事件顺序：`data-session` → `data-status(intent)` → `data-intent` →
`data-eval` / 工具输入输出 / `data-sources` / `source-document` → 正文。

## 二、 关键决策

### 2.1 路由失败与评估失败的取舍方向相反

- **路由失败 → fail-closed（兜底 `kb`）**：漏检索内部制度的代价高于多查一次。
- **评估失败 → fail-open（有召回按切题放行）**：评估模型超时不应把正常召回全判死。

【易错】两者不能统一成同一个默认值。路由放行会让闲聊也查库，评估拦截会让模型在
评估服务抖动时完全无法回答。

验证：`chat-query-rewrite.service.spec.ts` 分别覆盖 `路由抛错 → kb` 与
`评估抛错 → relevant`。

### 2.2 不切题命中必须从模型上下文消失

`retrieveAndGrade` 同时返回：

- `rawHits`：原始命中，仅给改写器参考；
- `hits`：`grade.ok ? rawHits : []`，只有切题资料进入工具返回的 `context`。

【易错】只在前端把评估卡标「不足」而仍把原文塞给模型，模型依旧会把差旅报销
当加班餐补引用。必须在数据层清空。

### 2.3 「最多两次」是代码约束，不是提示词建议

`retrieve_knowledge` 闭包持有 `retrieveCount`，第三次直接返回 `insufficient + error`；
`rewrite_query` 先检查 `lastRetrieve`，未检索或已切题都拒绝改写。
`modelCallLimitMiddleware` 从 4 提到 6，为「检索 → 改写 → 再检索 → 联网 → 作答」留出空间。

【易错】仅靠 system prompt 写「最多两次」挡不住模型重复调用；必须用闭包计数。
联网顺序（先库后网）目前仍只靠提示词约束，工具本身没有状态机，属于已知边界。
联网提供商由 `WEB_SEARCH_PROVIDERS` 控制，Bocha/Tavily 失败自动切换，见
[web-search-fallback.md](./web-search-fallback.md)。

### 2.4 每轮新建 Agent，而不是单例

v16 的 `this.agent` 是构造期单例，只能挂一个无用户上下文的 `web_search`。
v17 改为每轮 `createTurnAgent`，工具闭包捕获 `AuthUser`、`question`、`topK`、`mode`、
`persistSources` 与 `writer`：

- 检索和改写都能带当前用户可见性 scope；
- 多轮检索的来源编号可以跨工具调用累计；
- 不会把上一请求的计数、来源或用户带进下一轮。

### 2.5 内部模型调用必须隔离

`classify`、`gradeHits`、`rewriteAfterRetrieve` 都在 Agent 工具内部再调 LLM。
LangChain 的 callbacks 存在 `AsyncLocalStorage` 中，内部结构化输出的 JSON token
会继承外层流上下文，最后混进回答正文。

解法：`invokeIsolated` 在内部调用期间把 callbacks 换成空数组，并打
`kh-internal` 标签；前端 `stripInternalToolJson` 再按结构过滤 `{relevant,reason}`、
`{query}`、`{intent,standalone_query}`，作为第二道保险。

验证：`chat-query-rewrite.service.spec.ts` 的 16 条用例 + 前端
`chat-message-utils.spec.ts` 的内部 JSON 过滤用例。

## 三、 相对基线的有意分叉

| 分叉点 | 基线 v17 | 本项目 |
| :--- | :--- | :--- |
| 检索服务 | `HybridRetrievalService`，无模式切换 | 复用 `RetrievalService`，保留 `hybrid/vector/keyword`、MIN_SCORE、PG 一致性兜底 |
| 检索参数 | 只传 query/topK | 额外透传请求级 `mode`；模型可在 1–10 内覆盖 topK |
| 流前校验 | 无独立校验 | `touchTitle` 内部 `assertOwned`，越权在流开始前 404，同时早更新默认标题 |
| 模型配置 | `OPENAI_API_KEY/DASHSCOPE_API_KEY` + qwen-plus | 既有回退链 `LLM_API_KEY → EMBEDDING_API_KEY → OPENAI_API_KEY` + `LLM_MODEL` |
| 来源事件 | 失败检索也写空 `data-sources` | 空命中不写；前端取最后一个非空段，修复改写重查后引用丢失 |
| 评估标签 | `retried_*` 文案称「已改写」 | UI 改为「再次检索」，避免模型未调用 rewrite 时误标 |
| 前端输入能力 | 无 topK/模式/仅检索 | 保留三输入与「仅检索不落库」 |
| 流式错误 | 同 | 保留落库尽力而为；非流式检索错误折叠为「库里没有」属已知局限 |

## 四、 【易错】参考实现踩到的两个点

### 4.1 多段 `data-sources` 不能取第一个

参考实现前端 `sourcesFromParts` 直接返回第一个匹配 part。v17 的首次检索不足时
会先写一个空 `data-sources`，第二次检索成功再写完整数组；取第一个会让
「改写重查成功」这条主路径**引用卡全部消失**。

本项目的处理：

1. 服务端 `packRetrieveResult` 在 `sources.length === 0` 时不写 `data-sources`；
2. 前端 `sourcesFromParts` 遍历全部 part，取最后一个非空数组。

验证：`chat-message-utils.spec.ts` 的两个多段 sources 用例 + SSE 实测。

### 4.2 `retried` 不等于「已改写」

`retried_*` 只表示这是第二次检索。模型可能不调用 `rewrite_query` 直接换词再查，
此时标「已改写」是错误归因。本项目的评估卡统一显示「再次检索」。

## 五、 验证结果

【实录】2026-10-24 本地验证：

- `typecheck:server` / `typecheck:web` 通过；
- server 单测 41 个文件、342 条全通过；web 单测 4 个文件、23 条全通过；
- web 生产构建通过；
- 本地 API：`你好` 走 `chitchat`，无检索；制度问题返回 `[1]` 引用与差旅政策来源；
- 本地 SSE：「加班餐补怎么报」实际产生 `data-intent(kb)` → 首轮 `data-eval(irrelevant)` →
  `rewrite_query` → 第二次 `data-eval(retried_ok)` → `data-sources`，最终回答明确说明
  知识库没有加班餐补，并区分差旅餐补，不编造制度。
- 【实录】本地 SSE 第二次评估曾出现一次结构化输出失败，按 fail-open 放行；
  回答仍正确地区分了差旅餐补与加班餐补，但说明评估模型稳定性需要持续观察，
  必要时增加评估重试或单独的 `grade_error` 语义。
- 【实录】联网搜索降级：把 Bocha Key 置为无效后，Bocha 返回 401，Tavily 约 2 秒后
  接管并返回 3 条结果（`provider=tavily`），证明提供商链按错误自动切换。
  详见 [web-search-fallback.md](./web-search-fallback.md)。

【易错】本次未做自动化浏览器截图验收：环境的浏览器自动化策略要求显式授权。
前端交互（时间线、滚动、引用卡）目前由类型检查、前端构建、工具函数单测和 SSE 契约验证
覆盖，仍需在浏览器里人工走一遍主路径。

## 六、 已知局限与后续待办

1. `web_search` 没有硬性次数上限，靠 `modelCallLimit(6)` 收口；「先库后网」靠提示词。
2. 评估 fail-open 时会把宽松命中的原文交给模型，可能多给来源；回答质量依赖提示词。
3. 非流式 `kb` 检索异常会折叠成「知识库里没有相关内容」，不区分接口故障。
4. 过程卡是流式事件，不落库；历史会话只能回放正文与引用，不能回放意图/评估轨迹。
5. 完整六篇制度 PDF 的验收矩阵尚未补齐；当前 `test/fixtures` 只有差旅与发布 SOP 两篇。
6. 会话长期记忆检索词在流式/非流式仍分别使用 `plan.query`，与基线 v17 的
   `question` 选择不完全一致，属低风险差异。
