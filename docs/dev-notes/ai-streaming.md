# AI 流式对话（feat-v14）

> **v17 更新（2026-10-24）**：Agent 由构造期单例的 `web_search` 改为每轮按意图挂载
> `retrieve_knowledge` / `rewrite_query` / `web_search`，检索最多两次，过程事件新增
> `data-intent` / `data-eval`。实现细节与工程验证见
> [agentic-rag.md](./agentic-rag.md)；本文以下保留 v14 的流式协议、会话与前端基座说明。

> **模块范围**
> SSE 流式问答（UI Message Stream 协议）、LangChain Agent（web_search 联网工具）、
> 前端 useChat 流式渲染与过程组件。
>
> **对应代码路径**
> `ai/ai-stream.service.ts`、`ai/web-search.service.ts`、`ai/dto/chat-stream.dto.ts`、
> `ai/ai.controller.ts`、`ai/ai.module.ts`、`ai/chat-session.service.ts`（touchTitle / assertOwned）；
> web：`pages/ChatPage.tsx`、`components/ChatMessageParts.tsx`、`components/SourceCiteList.tsx`
>
> **迭代版本**：feat-v14

---

## 一、 流式链路与协议编排

```
POST /ai/chat/stream (@Res() 直写响应，绕过信封)
└─ createUIMessageStream({ execute, onFinish })
   ├─ writer.write: start → data-session → data-status
   ├─ 检索（RetrievalService，失败降级为空继续）→ data-retrieve / data-sources / source-document
   ├─ agent.stream({streamMode:['messages','tools']})
   │    └─ writer.merge(toUIMessageStream(...))   ← 思考 / 正文 / 工具调用
   └─ finish 由 createUIMessageStream 收口
onFinish: 拼 answer → 抽 [n] 引用 → appendTurn 落库（尽力而为）
```

【易错】`toUIMessageStream` 必须 `sendStart:false, sendFinish:false`：
外层 execute 已写 start、finish 由 createUIMessageStream 统一收口，
不关会双发导致前端解析异常。

【易错】`ChatStreamDto` 必须对 useChat 自动附加的 `id / trigger / messageId`
加 `@Allow()`——全局 `forbidNonWhitelisted` 下不放行直接 400，
且报错信息不会提示是哪个字段，极易误判为鉴权/路由问题。

【易错】百炼兼容口把思考内容放在 `additional_kwargs.reasoning_content`，
而 `@ai-sdk/langchain` 适配层只认 `reasoning.summary`。流上用递归转换器
原位改写（`attachDashScopeReasoning`，seen 集合防循环引用）。
不支持思考的模型可设 `LLM_ENABLE_THINKING=false` 关闭。

## 二、 Agent 与降级

- `createAgent`（langchain 1.x）+ `modelCallLimitMiddleware`：v14 单轮最多 4 次模型调用；
  **v17 提高到 6 次**，为「检索 → 改写 → 再检索 → 联网 → 作答」留出空间，超限仍正常收流。
- `web-search.service.ts`：按 `WEB_SEARCH_PROVIDERS` 顺序调用 Bocha / Tavily，
  未配 Key 的跳过，HTTP/网络/接口错误自动切下一个；全部失败返回合并 error，
  由模型向用户转述——联网是增强，不阻断知识库主链路。详见
  [web-search-fallback.md](./web-search-fallback.md)。
- 检索复用主项目 `RetrievalService`（继承 MIN_SCORE 过滤 + 死文档兜底），
  检索异常 catch 降级为空召回继续生成，流内不抛 500。

## 三、 会话与落库

- 传 `sessionId`：开场 `touchTitle` 校验归属并早更新默认标题，越权当场 404
  （避免等到生成结束落库才因越权报错而白白消耗 Token）。`appendTurn` 末尾
  仍保留标题兜底，覆盖流异常与非流式路径。
- 不传：以首问为标题直接建会话，`data-session` 事件回传 id 供前端改 URL。
- 落库在 onFinish：从最终 parts 拼回答、正则抽 `[n]` 只存被引用资料，
  复用 v13 `appendTurn`（尽力而为，失败只记日志）。
- 前端 `onData` 收到 `data-session` 时刷新会话列表；配合服务端开场
  `touchTitle`，首答期间侧栏标题即可从「新对话」变成首问。

## 四、 前端（useChat 渲染）

- `useChat` + `DefaultChatTransport('/api/ai/chat/stream')`，headers 回调注入
  Bearer；`onData` 收 `data-session` 回写 URL；停止生成用 SDK 自带 `stop()`。
- `ChatMessageParts` 按 `part.type` 渲染：`reasoning`/`data-think` → ThinkBlock、
  `data-intent` → IntentCard、`data-eval` → EvalCard、`retrieve_knowledge` →
  RetrieveToolCard、`rewrite_query` → RewriteToolCard、`web_search` → WebSearchCard；
  旧 `data-retrieve` 仍保留兼容。工具输出可能是 JSON 字符串或 content 消息对象，
  需递归解包。v17 的完整时间线与来源选择规则见 [agentic-rag.md](./agentic-rag.md)。
- `SourceCiteList` 卡片化 + `[n]` 点击锚点 flash 联动；正文换 `AnswerMarkdown`
  （react-markdown + remark-gfm，递归注入引用 chip）。
- 历史 `historyToUIMessages` 回填为 parts，与实时流共用同一渲染。
- 【易错】vite 代理必须 `timeout:0 / proxyTimeout:0`，否则长思考流被代理掐断。
- StrictMode 保留，历史加载沿用 `cancelled` 守卫；流式期间锁定会话切换/新建/删除。

## 五、 验证结果与遗留

【实录】typecheck:server / web typecheck / 全量 test:server（192 通过，2 个
KG 集成用例因无 LLM Key 跳败，与本模块无关）/ oxlint（新代码 0 警告）/
web 生产构建均通过；langchain 1.5.16 + core 1.2.11 + zod v4 冒烟验证
（createAgent / tool / modelCallLimitMiddleware 构造成功）。

遗留（详见 docs/TODO.md）：
1. 流式接口 401 不会自动刷新令牌——`DefaultChatTransport` 自管 fetch，
   绕过了 client.ts 的刷新拦截，过期需手动重登（待后续统一流式传输层拦截器）。
2. `@langchain/core` peer 要求 ^1.2.17、实装 1.2.11，冒烟兼容；
   升级待沙箱装依赖回合执行。
3. 联网搜索需配置 `BOCHA_API_KEY` 或 `TAVILY_API_KEY`；都未配置时为显式降级非故障。
