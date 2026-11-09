# 对话记忆与检索改写（feat-v16，feat-v22 加固）

> **模块覆盖范围**
>
> - `apps/server/src/ai/chat-short-memory.service.ts`：Redis 短期窗口（List 追加写 / 双闸门 / 回填 / 清理）
> - `apps/server/src/ai/chat-long-memory.service.ts`：Mem0 长期记忆（user / session 双层 + 分类器 + 注入闸门 + 衰减）
> - `apps/server/src/ai/chat-memory-mirror.service.ts`：`kh_ai_memory` 本地镜像与归档（v22，默认关闭）
> - `apps/server/src/ai/chat-history-compressor.service.ts`：非流式历史压缩 + 流式阈值统一（v22）
> - `apps/server/src/ai/chat-query-rewrite.service.ts`：追问改写与检索意图判定
> - `apps/server/src/ai/chat-memory.util.ts`：消息提取 / 工作消息过滤 / 预算裁剪 / PG 行转消息 / 改写上下文
> - `apps/server/src/ai/ai-chat.service.ts`、`ai-stream.service.ts`：两条问答链路的记忆编排
> - `apps/server/src/ai/chat-session.service.ts`：`listRecentMessages` + 删除会话时清记忆
> - `apps/server/src/ai/ai.controller.ts`：记忆治理接口（列表 / 删单条 / 全清）
> - `apps/web/src/pages/MemoryPage.tsx`、`apps/web/src/api/index.ts`（`memoryApi`）：治理页与前端 API 封装
> - `apps/server/eval/datasets/memory-extraction-20.json`、`src/ai/eval/run-memory-experiment.ts`：判定口径离线评测

---

## 一、 三层记忆的分工

| 层 | 存储 | 存什么 | 判定方式 | 失效影响 |
| :--- | :--- | :--- | :--- | :--- |
| 短期 | Redis List | 最近 N 条 user / assistant 原文 | **位置判定**：不做内容判断，靠条数与 token 双闸淘汰 | 从 PG 回填，无感 |
| 长期 | Mem0（SaaS） | 抽取后的**事实**，非原文 | **LLM 结构化分类器**：两层布尔值 | 跳过记忆背景，问答正常 |
| 真源 | `kh_ai_message` | 全量原文 | 无条件落库 | 会话回看失败 |

「短期 / 长期」的分界线不是时间长短，而是**存原文还是存事实**。Redis 只是热缓存，Mem0 是派生数据，两者丢失都不影响会话回看。

### 【易错】短期窗口不能存检索资料与思考

只存 `HumanMessage` / `AIMessage`（`isWorkingMessage`）。检索拼接、记忆系统消息、思考过程若进窗口，下一轮会把它们当成「用户说过的话」，既膨胀上下文，又污染改写与长期记忆抽取。

## 二、 短期记忆：位置判定 + 双闸门

### 2.1 判定：只认 user / assistant

`chat-memory.util.ts` 的 `isWorkingMessage()` 只放行两类消息。没有「这条值不值得记」的判断 —— 所有轮次无条件进窗口，靠容量闸淘汰。

### 2.2 两道容量闸（feat-v22）

- **条数**：`CHAT_SHORT_MEMORY_MAX_MESSAGES`（默认 20），`slice(-N)`。
- **估算 token**：`CHAT_SHORT_MEMORY_MAX_ESTIMATED_TOKENS`（默认 12000），复用 `context-budget.ts` 的 `estimateContextTokens`（1 token ≈ 1 UTF-8 字节，悲观口径，不引入 tokenizer）。

条数管不住长文本：20 条 × 3000 字的对话能撑到六万字；预算管不住碎消息（20 条一问一答占不满）。两道都保留。

`fitMessagesToBudget()` 从末尾往前累加，超预算即停；**最后一条强制保留** —— 本轮问题再长也要进模型，否则单条超长会把窗口裁成空数组。

**【实录】预算闸的取值**：单测中 4 条各 10 汉字（每条 30 字节，共 120 字节），预算设 70 时实际保留最近 2 条；把预算压到 10、单条 500 字时仍保留该条（末条豁免）。

### 2.3 追加写：从覆盖改为 RPUSH（feat-v22）

### 【易错】基于过期快照的覆盖写会丢轮次

旧实现：`tryLoad` 读窗口 → 与新一轮问答拼接 → `save` 整体覆盖。两个并发请求会各自持有一份相同快照，后写者把先写者的整轮问答抹掉。同一用户单会话通常串行，但多标签页、前端重试、SSE 重连都能触发。

解法：Redis 改 List 结构，key 升版 `kh:chat:{userId}:{sessionId}:v2:messages`：

- 追轮：`RedisService.appendListWindow()`，单条 Lua 完成 `RPUSH × N + LTRIM + EXPIRE`；
- 回填 / 收敛：`replaceListWindow()`，`DEL + RPUSH + LTRIM + EXPIRE`，空数组等价于删键（留空 List 会让下次读取命中空窗口而不回源数据库）；
- `appendTurn(userId, sessionId, question, answer)` **不再接收 history 参数** —— 共享快照正是问题根因。

**【实录】验证方式**：连续 `appendTurn` 5 轮后 `tryLoad` 得到 10 条且顺序正确；另有一条断言 `listRange` 未被调用，证明写路径无读改写。

代价：追加时算不出全窗口 token，**预算收敛挪到读取路径** —— `tryLoad` 命中后 `fit()` 一次，超限则异步重写（幂等，晚一轮无害）。

### 2.4 【实录】短期记忆的 miss 路径

`tryLoad` 命中直接用；未命中、空 List 或 Redis 故障返回 null → `listRecentMessages(userId, sessionId, windowSize)`（归属校验 + DESC 取 N + reverse）→ `save` 回填。

**【易错】回填必须返回裁剪后的窗口**：`save()` 内部已按条数 + 预算收紧，但早期版本 `loadWorkingHistory` 返回的是**未裁剪**的 `history`，导致「Redis 里裁过、模型看到没裁」，预算闸要等到下一轮才生效。现在 `save()` 返回实际落库窗口，回填路径直接用它。

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

## 四、 长期记忆：分类器判定 + Mem0 双层

### 4.1 判定口径

`temperature: 0` 的 LLM + `withStructuredOutput(memorySchema)`，输出 `{ write_user, write_session, reason }`。

| 档位 | 收什么 | 不收什么 |
| :--- | :--- | :--- |
| user 层 | 身份、岗位、团队自称、长期偏好、持久约束 | 本轮任务、知识库条文 |
| session 层 | 本轮排查的问题、在写什么、已确认的下一步 | 跨会话语义 |
| 都不写 | — | 寒暄致谢、纯确认、**助手依据知识库说出的制度/流程/负责人/系统名**、联网结果、引用编号 |

### 4.2 写入边界（双重约束）

**【易错】RAG 系统天然会把文档内容说得很像「用户事实」**。不拦住的话，用户画像会被公司制度条文覆盖，长期记忆退化成一个劣质向量库副本。

1. **抽取源隔离**：`extractFrom` 只传用户提问，`answer` 截 300 字仅供分类器判断，绝不进 `add()`。
2. **`customInstructions` 再压一遍**：「只用用户说的话抽取…不要保存制度条文、流程、时限、负责人、系统名、引用编号。不要译成英文。」

存储走 Mem0，两层靠 metadata 过滤区分（不是两套库）：

- user 层：`add(..., { userId })` / `search({ filters: { user_id } })`
- session 层：`add(..., { userId, runId: sessionId })` / `search({ filters: { AND: [{ user_id }, { run_id }] } })`

Mem0 的 `add` 是增量 upsert 语义（内部去重与冲突更新），项目侧不管理冲突。

### 4.3 注入闸门（feat-v22）

### 【易错】user 层是永久累积的

`topK=5` 只限制单次检索条数，不限制单条长度。用户用一年后，5 条长偏好足以吃掉大半系统提示预算。

`buildSystemMessage()` 增加两道闸：`CHAT_MEMORY_INJECT_MAX_ITEMS`（默认 8 条/层）、`CHAT_MEMORY_INJECT_MAX_CHARS`（默认 1200 字符/块）。超限按检索顺序截断并追加 `（已截断）`；**首条就超限时保留其截断版**，否则整块记忆会凭空消失。

### 4.4 写入重试与本地镜像（feat-v22）

- `rememberTurn` 是 fire-and-forget（`void`），失败无重试会让本轮记忆静默丢失。现在每层独立退避重试一次（200ms），仍失败落结构化日志 `memory_write_failed layer=… sessionId=… attempt=… error=…`。user 层失败不阻止 session 层写入。
- `kh_ai_memory` 镜像表：按 `memory_id` 幂等 upsert，供分层计数、归档扫描与审计。**默认关闭**（`CHAT_MEMORY_MIRROR_ENABLED=false`）—— 未拿到真实条目量与增速前不引入写放大。开启只影响可观测性，不改变检索行为。
- 镜像与 Mem0 的一致性以 Mem0 为准：删会话 / 全清 / 删单条都在 Mem0 成功后同步删镜像。

### 4.5 时间衰减（feat-v22）

两种方式，**不要同时开**：

1. **平台 decay（首选）**：Mem0 项目级 `decay` 开关，按最近使用加权、衰减陈旧条目，在 dashboard 配置。
2. **本地重排（兜底）**：`CHAT_MEMORY_DECAY_HALF_LIFE_DAYS > 0` 时，`rank = score × exp(-ageDays / halfLife)`，并把候选集自动扩为 `topK × 2`（否则重排只在原 topK 内部换序，等于没衰减）。缺 `score` 或缺时间戳的条目排在其后，不做降权猜测。

## 五、 上下文压缩

长对话压缩分两处，**都不写回存储**：

- 流式：`createAgent` 挂 `summarizationMiddleware({ trigger, keep, summaryPrompt })`，在 Agent 循环内折叠；
- 非流式：`ChatHistoryCompressor.maybeCompress()` 在组装 messages 前折叠一次（没有 agent 循环可挂中间件）。

两者共用 `CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES`（默认 12）/ `CHAT_HISTORY_SUMMARY_KEEP_MESSAGES`（默认 6）与同一段摘要指令，避免同一会话在 `/ai/chat` 与 `/ai/chat/stream` 上表现不一致。

- 压缩与检索**并行启动**，短会话（未超阈值）同步返回，不增加延迟；
- 摘要输入按「从最近往前」累加，上限 6000 字节、单条截 800 字；
- 压缩失败退回原始窗口 —— 上下文变长可接受，问答失败不可接受。

### 【易错】摘要本身也要防污染

摘要提示词同样要求「不要写入知识库条文」，否则摘要会把文档内容固化成对话事实，下一轮被当成用户上下文。

## 六、 记忆治理接口（feat-v22）

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/ai/memory?layer=user&page=1&pageSize=20` | 分页；`layer=session` 必须带 `sessionId`，否则返回空页 |
| DELETE | `/ai/memory/:memoryId` | 删单条；越权与不存在统一 404 |
| DELETE | `/ai/memory` | 清空全部（含各会话上下文） |

前端入口：个人中心 → 我的记忆（`/profile/memory`，路由守卫沿用 `profile` 权限码）。
两层分 tab 展示；「会话上下文」tab 必须先选会话 —— 这与后端「缺 sessionId 返回空页」是同一个安全默认。
删除与清空均二次确认，清空文案明确写「聊天记录不受影响，但助手会忘记偏好与约束」，
避免用户误以为会丢聊天记录。

### 【易错】Mem0 的 delete 不校验归属

`client.delete(memoryId)` 只认 ID。必须先 `get(memoryId)` 比对 `userId`，否则拿到任意 ID 就能删别人的记忆。TOCTOU 窗口极小，接受。

### 【易错】deleteAll 无法表达「只删 runId 为空」

Mem0 的过滤条件没有 `runId is null`。自行分页筛 `runId` 会因删除导致页码前移而漏删。因此全清接口语义明确为「全部记忆」，不提供「只清画像」入口。

## 七、 离线评测（feat-v22）

`apps/server/eval/datasets/memory-extraction-20.json` + `pnpm eval:memory`。

- 只调分类器：不写 Mem0、不建会话、不检索 —— 分类能力已与存储能力解耦，无 `MEM0_API_KEY` 也能跑；
- 20 条覆盖身份 / 偏好 / 约束 / 会话任务 / 寒暄 / 纯查询，以及 **5 条知识库事实陷阱**（助手给出制度条文、人名、系统名）；
- 核心指标：**陷阱样本误写数，红线为 0**，非 0 即退出码 1。其次是两层 precision；
- **【实录】评测依赖有效 LLM Key**：本次环境 `.env` 的 Key 返回 401，runner 已改为输出明确提示并退出，而不是抛栈。统计逻辑已由 `memory-eval.spec.ts` 独立覆盖。

## 八、 核心架构设计与工程优化

- **统一凭证回退链**：`LLM_API_KEY → EMBEDDING_API_KEY → OPENAI_API_KEY`，模型参数全局收口。
- **连接与命名空间收敛**：短期记忆复用全局 `RedisService`，统一 key 前缀 `kh:chat:*`；窗口原语（`listRange` / `appendListWindow` / `replaceListWindow`）放在 RedisService，避免各业务自己拼 Lua。
- **级联删除保障**：会话删除依托外键 `ON DELETE CASCADE`，记忆清理（Redis DEL、Mem0 deleteAll、镜像 delete）作为后置尽力而为动作，失败不回滚。
- **降级一致性**：三层记忆的失败都只 warn，不阻断当轮回答；记忆是派生数据。

## 九、 已知局限与后续待办

- Mem0 为 SaaS（可配 `MEM0_HOST` 自托管），企业内网未验证，见 [mem0-selfhost.md](./mem0-selfhost.md)。
- 记忆抽取正确性依赖提示词，离线评测只覆盖固定 20 条语料，未接入 CI 门禁。
- 改写每轮多一次 LLM 调用（约 1s）；非流式长会话再叠加一次摘要调用，高并发下需实测 RT 分布。
- `kh_ai_memory` 镜像默认关闭，未在真实数据量下验证写放大与归档收益。
- `archiveStale` 只改本地状态，真正退出检索仍需在 Mem0 侧删除，尚无自动编排（项目无调度器，引入 `@nestjs/schedule` 需单独评估）。
