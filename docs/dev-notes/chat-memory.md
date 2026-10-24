# 对话记忆与检索改写（feat-v16）

> **模块覆盖范围**
>
> - `apps/server/src/ai/chat-short-memory.service.ts`：Redis 短期窗口（TTL / 条数 / 回填 / 清理）
> - `apps/server/src/ai/chat-long-memory.service.ts`：Mem0 长期记忆（user / session 双层 + 分类器）
> - `apps/server/src/ai/chat-query-rewrite.service.ts`：追问改写与检索意图判定
> - `apps/server/src/ai/chat-memory.util.ts`：消息提取 / 工作消息过滤 / PG 行转消息 / 改写上下文
> - `apps/server/src/ai/ai-chat.service.ts`、`ai-stream.service.ts`：两条问答链路的记忆编排
> - `apps/server/src/ai/chat-session.service.ts`：`listRecentMessages` + 删除会话时清记忆
>
> **对应基线实现**：后端 `v16`（前端无改动）
> **分叉总表**：[docs/reference-mapping.md](../reference-mapping.md) 第三节

---

## 一、 双层记忆的分工

- **短期记忆（Redis）**：当前会话最近 20 条 user / assistant 原文，TTL 24h，只服务「这一轮怎么接上文」。
- **长期记忆（Mem0）**：抽取后的事实——user 层跨会话（身份 / 岗位 / 偏好 / 约束），session 层随会话（本轮任务 / 进度 / 待办）。
- Postgres 仍是历史真源：Redis 只是热缓存，Mem0 是派生数据，丢了两者都不影响会话回看。

### 【易错】短期窗口不能存检索资料与思考

只存 `HumanMessage` / `AIMessage`（`isWorkingMessage` 过滤）。检索拼接、记忆系统消息、思考过程若进窗口，
下一轮会把它们当成「用户说过的话」，既膨胀上下文，又污染改写与长期记忆抽取。

## 二、 【实录】短期记忆的 miss 路径

`tryLoad` 命中直接用；未命中或 Redis 故障返回 null → `listRecentMessages(userId, sessionId, windowSize)`
（归属校验 + DESC 取 N + reverse）→ `save` 回填。删会话时 `clear`。

Redis 读写失败只 warn：读路径由 PG 兜底，写路径下一轮照样能回填。

## 三、 检索改写

v16 最初为 `{ standalone_query, need_retrieve }` 结构化输出；v17 起升级为
`{ intent, standalone_query }` 五类意图路由（chitchat / profile / kb / web / kb_then_web），
无历史也执行路由，失败兜底 `kb`。检索后的切题评估与不足改写见
[agentic-rag.md](./agentic-rag.md)，本节只保留与记忆强相关的约束。

- 上下文只取最近 4 条（用户 200 字 / 助手 120 字，防制度原文污染）。
- 闲聊/偏好不挂检索工具；知识库与联网由意图决定。
- 无 Key / 超时 / 路由失败 → 回退原问题且按 `kb` 处理，不阻断问答。

### 【易错】改写后的 query 检索必须继续带可见性 scope

`retrieval.search({ query: plan.query }, accessFromUser(user))` —— 漏传 scope 会退化成全量检索（fail-open），
见 [document-visibility.md](./document-visibility.md) §五。v17 的二次检索同样经过
`retrieveAndGrade`，scope 由工具闭包携带，不能只给首轮加。

## 四、 Mem0 写入边界

- **只从用户提问抽取**：`add(extractFrom)` 只传 question；answer 仅截 300 字给分类器作判断。
- 分类器（zod `write_user` / `write_session` / `reason`）+ `customInstructions` 双重约束：
  寒暄、助手依据文档说出的制度 / 人名、联网结果一律不写——知识库内容不进用户画像。
- user 层 `{ userId }`，session 层 `{ userId, runId: sessionId }`；删会话 `deleteAll({ userId, runId })` 只清会话层。
- 无 `MEM0_API_KEY` → `enabled=false` 全跳过；检索 / 写入失败只告警，不影响当轮回答。
- 写入异步（`void rememberTurn`）：刚答完立刻追问可能搜不到，属预期行为。

## 五、 摘要压缩的位置

长对话压缩在 Agent 侧 `summarizationMiddleware`（trigger 12 条 / keep 6 条 / compactLlm 关思考），
只折叠本次调用的上下文，不改 Redis 窗口与 PG 历史；窗口本身仍按 20 条滑动。

## 六、 相对基线的分叉

- LLM 配置与 ai-chat / ai-stream 同源（`LLM_API_KEY → EMBEDDING_API_KEY → OPENAI_API_KEY`，`LLM_MODEL` 统一默认）
- 短期记忆复用既有 `RedisService` 薄封装（基线新建独立连接）；key 前缀 `kh:chat` 与 `kh_auth` 同命名空间
- 会话删除沿用「只删会话行 + 外键级联」，记忆清理放在删除成功之后（基线应用层删两张表）

## 七、 已知局限与后续待办

- Mem0 为 SaaS（可配 `MEM0_HOST` 自托管），企业内网未验证
- 记忆抽取正确性依赖提示词，无程序化校验；建议固定语料回归（6 篇制度 PDF 场景见基线自测清单）
- 改写每轮多一次 LLM 调用（约 1s）；高并发下可考虑先规则改写、再回落 LLM
