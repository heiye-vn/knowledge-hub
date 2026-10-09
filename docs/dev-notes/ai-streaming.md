# AI 流式对话（feat-v14）

> **模块范围**
> SSE 流式问答（UI Message Stream 协议）、LangChain Agent（web_search 联网工具）、
> 前端 useChat 流式渲染与过程组件。
>
> **对应代码路径**
> `ai/ai-stream.service.ts`、`ai/web-search.service.ts`、`ai/dto/chat-stream.dto.ts`、
> `ai/ai.controller.ts`、`ai/ai.module.ts`、`ai/chat-session.service.ts`（assertOwned）；
> web：`pages/ChatPage.tsx`、`components/ChatMessageParts.tsx`、`components/SourceCiteList.tsx`
>
> **对应讲次**：第 63 讲（基线实现 v14）

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

- `createAgent`（langchain 1.x）+ `modelCallLimitMiddleware({runLimit:4, exitBehavior:'end'})`：
  单轮最多 4 次模型调用，防 web_search 循环打爆；超限正常收流不抛错。
- `web-search.service.ts`（Bocha）：未配 `BOCHA_API_KEY` 或调用失败时返回带
  error 的空结果，由模型向用户转述原因——联网是增强，不阻断知识库主链路。
- 检索复用主项目 `RetrievalService`（继承 MIN_SCORE 过滤 + 死文档兜底），
  检索异常 catch 降级为空召回继续生成，流内不抛 500。

## 三、 会话与落库

- 传 `sessionId`：开场 `assertOwned` 校验归属，越权当场 404
  （基线实现要到 onFinish 落库才失败，此时已白跑一次 LLM）。
- 不传：以首问为标题直接建会话，`data-session` 事件回传 id 供前端改 URL。
- 落库在 onFinish：从最终 parts 拼回答、正则抽 `[n]` 只存被引用资料，
  复用 v13 `appendTurn`（尽力而为，失败只记日志）。

## 四、 前端（useChat 渲染）

- `useChat` + `DefaultChatTransport('/api/ai/chat/stream')`，headers 回调注入
  Bearer；`onData` 收 `data-session` 回写 URL；停止生成用 SDK 自带 `stop()`。
- `ChatMessageParts` 按 `part.type` 渲染：`reasoning`/`data-think` → ThinkBlock、
  `data-retrieve` → RetrieveCard、`isToolUIPart && web_search` → WebSearchCard
  （LangChain 工具输出可能是 JSON 字符串或 content 消息对象，需递归解包）。
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
   绕过了 client.ts 的刷新拦截，过期需手动重登（基线实现同样未处理）。
2. `@langchain/core` peer 要求 ^1.2.17、实装 1.2.11，冒烟兼容；
   升级待沙箱装依赖回合执行。
3. 联网搜索需配置 `BOCHA_API_KEY`，未配置为显式降级非故障。
