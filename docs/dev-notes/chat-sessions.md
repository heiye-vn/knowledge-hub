# AI 会话持久化（feat-v13）

> **模块范围**
> RAG 对话落库本人会话、会话 CRUD（分页 / 新建 / 重命名 / 删除）、历史消息查询。
>
> **对应代码路径**
> `ai/chat-session.service.ts`、`ai/entities/ai-session.entity.ts`、
> `ai/entities/ai-message.entity.ts`、`ai/chat.types.ts`、`ai/dto/session.dto.ts`、
> `ai/ai-chat.service.ts`（接入点）、`ai/ai.controller.ts`、`init-scripts/postgresql/01-init.sql`
>
> **对应讲次**：第 62 讲（基线实现 v13）

---

## 一、 数据模型

两张表，一轮问答落两条消息：

```
kh_ai_session                    kh_ai_message
├─ id (snowflake PK)             ├─ id (snowflake PK)
├─ user_id        ─┐             ├─ session_id (FK, ON DELETE CASCADE)
├─ title(80)       │ 一对多       ├─ role ('user' | 'assistant')
├─ created_at      └──────────→  ├─ content (text)
└─ updated_at                    ├─ sources (jsonb, assistant 专属，无引用 NULL)
   (索引 user_id,updated_at DESC)└─ created_at (索引 session_id,created_at)
```

- **updated_at 是列表排序键**：每轮问答手动推进（`@UpdateDateColumn` 在
  `em.save` 全量保存时会更新，但这里业务上显式赋值，语义自明），
  会话列表按其倒序 = 最近活跃在前。
- **sources 存摘录不存整块正文**：与响应体同一份 `ChatSource[]`，
  历史回看时直接复用溯源 UI。
- **user_id 不加外键**：用户是软删除模型，且用户删除场景不归会话管；
  只在会话侧加 CASCADE，删除路径单一。

## 二、 落库时序与所有权

`POST /ai/chat` 的完整时序：检索 →（无命中走固定话术）→ LLM 生成 →
抽 `[n]` 溯源 → **appendTurn** → 响应。

- **appendTurn 内部**：传了 sessionId 先过 `getOwned(userId, sessionId)`；
  没传则新建会话（标题 = 首问压空白后截 30 字）。
- **标题自动生成只覆盖默认名**：首轮问答时若 title 仍是「新对话」才用
  首问覆盖，用户自己命名过的会话不动。
- **越权 = 不存在**：`getOwned` 查询条件同时带 id 与 userId，
  越权访问和真不存在统一 404，不泄漏「会话存在但不是你的」。

## 三、 🟡 与基线实现的分叉

| 基线实现 | 本项目 | 理由 |
| :--- | :--- | :--- |
| 删除会话先删消息再删会话（应用层两条 DELETE） | 只删会话行，消息交给外键 CASCADE | 库已经声明了级联，应用层再删一遍是重复防御 |
| appendTurn 失败直接向上抛，**已生成的回答整单丢失** | 落库尽力而为：失败只记 error 日志，回答照常返回 | 回答的价值在生成之后，持久化故障不应让用户拿不到答案；落库缺失影响的是历史回看 |
| ChatSource 定义在 ai-chat.service.ts | 独立 `chat.types.ts` | 实体（type-only）与溯源服务都要引用，避免反向依赖服务文件 |

## 四、 鉴权与权限码

- 会话 5 接口与 `/ai/chat` 同挂 `search` 权限码（沿用 feat-v10/11 的
  「只挂码不叠 @Roles」原则）。
- 全局 JWT Guard 下无匿名路径，chat 的 `user` 参数实际恒存在；
  保留 `user?` 可选签名是为了服务层可脱离 HTTP 上下文复用（含单测）。

## 五、 前端接入（apps/web）

契约与主项目 server 对齐（`/ai/*` 一套路由），前端改动集中在四处：

- **api 层**：`chat` 增加可选 sessionId；新增 `sessions` / `createSession` /
  `messages` / `renameSession` / `removeSession`（`client.ts` 的 get/post/patch/del 齐备）。
- **URL 即会话态**：`/chat?session=<id>`。无参数 = 新会话（首问由服务端建会话后
  `navigate(replace)` 回填 id）；切换会话拉历史消息映射成气泡。
- **「仅检索」不落会话**：走 `/search` 纯检索，与 `/ai/chat` 分道，避免检索调试污染历史。
- **历史消息复用溯源组件**：`AnswerWithCitations` + `SourceCiteList`（主项目自研，
  比基线的 antd List 直拼更完整）。会话栏删除图标 `stopPropagation` 防误触。

**StrictMode 保留（🟡 分叉）**：基线实现为绕开 dev 环境 effect 双调用，
直接**删除了 StrictMode**。主项目保留它，改为把加载逻辑写成幂等 +
`cancelled` 守卫（参考实现本身也写了守卫，删 StrictMode 属多余）。
删掉 StrictMode 会失去一整类问题的 dev 期暴露，代价远大于适配成本。

## 六、 已知局限与后续待办

- **多轮上下文未进 LLM**：会话只是持久化，追问「那第二天呢」不会带上
  前文；每轮仍是独立检索 + 独立作答。要支持需把近 N 轮消息拼进
  prompt（见 docs/TODO.md）。
- 会话无草稿/归档态，删除即物理删除（消息级联）。
- 未做会话消息分页：单会话消息量级预期小，一次全量返回。
