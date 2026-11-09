# Mem0 自托管验证（feat-v22）

> **模块范围**
>
> - `apps/server/src/ai/chat-long-memory.service.ts`：唯一调用 Mem0 的入口
> - `apps/server/.env.example`：`MEM0_API_KEY` / `MEM0_HOST` / `MEM0_TOP_K`
> - `apps/server/test/manual/mem0-contract.md`：切换前必须跑通的契约测试
>
> 本文不是「Mem0 部署手册」，而是**把本项目依赖的 Mem0 行为逐条验证清楚**。
> 部署细节以 Mem0 官方文档为准，版本差异较大，不在此固化命令。

---

## 一、为什么要自托管

SaaS 版的问题不是成本，是**数据出境与合规**：长期记忆里存的是用户身份、岗位、偏好、约束，属于个人信息。企业内网部署要求「数据不出网」时，SaaS 不可用。

`MEM0_HOST` 已预留自托管入口，代码侧无需改动 —— 只要自托管实例的 API 契约与 SaaS 一致。

## 二、本项目实际依赖的 Mem0 能力

切换前必须逐条验证，任何一条不满足都会导致功能静默降级（代码只 warn，不报错，很难发现）。

| # | 能力 | 用在哪 | 不满足的后果 |
| :--- | :--- | :--- | :--- |
| 1 | `add(messages, { userId })` | user 层写入 | 画像写不进去，`rememberTurn` 只留日志 |
| 2 | `add(messages, { userId, runId })` | session 层写入 | 会话上下文丢失 |
| 3 | `search(q, { filters: { user_id } })` | user 层检索 | 画像检索为空 |
| 4 | `search(q, { filters: { AND: [{ user_id }, { run_id }] } })` | session 层检索 | **最易出问题**：部分实现只支持单层平铺 filters，`AND` 被忽略后会把该用户全部记忆当会话记忆返回 |
| 5 | 返回条目含 `score`、`createdAt` / `updatedAt` | 时间衰减重排 | 衰减自动退化为原序（代码已做缺字段保护） |
| 6 | `get(memoryId)` 返回 `userId` | 删除前的归属校验 | 无法校验归属，只能放弃删除接口 |
| 7 | `delete(memoryId)` | 删单条 | 治理接口失效 |
| 8 | `deleteAll({ userId, runId })` | 删会话清会话层 | 会话层清不干净 |
| 9 | `deleteAll({ userId })` | 全清 | 全清不彻底 |
| 10 | `getAll({ filters, page, pageSize })` 返回 `{ count, results }` | 记忆列表分页 | 列表页永远空 |

## 三、接入步骤

1. 部署自托管实例，记录 base URL（下称 `MEM0_HOST`）。
2. 若实例要求鉴权，准备 API Key；无需鉴权的内网实例可填任意非空值 —— **代码以「`MEM0_API_KEY` 非空」作为启用开关**，空值会整条能力关闭。
3. 配置：

```dotenv
MEM0_API_KEY=<自托管实例的 key 或占位值>
MEM0_HOST=http://mem0.internal:8000
MEM0_TOP_K=5
```

4. 按 `apps/server/test/manual/mem0-contract.md` 跑契约测试，10 条全过再切流量。
5. 灰度：先单账号验证 `rememberTurn` 与 `search`，观察日志有无 `长期记忆检索失败` / `memory_write_failed`。

## 四、重点验证项与判据

### 4.1 `AND` 组合过滤（第 4 条）

这是唯一一条「不满足也不会报错、只会悄悄返回过多数据」的能力。

判据：给同一用户写入一条 user 层、一条 session 层，再用 `AND` 条件检索，**只应返回 session 那条**；若返回两条，说明 `AND` 被忽略，session 层检索会把长期画像当成本轮上下文注入。

兜底：若自托管不支持 `AND`，可改为「session 层写入时把 `run_id` 拼进 `userId` 命名空间」（如 `userId = ${userId}:${sessionId}`），但这会破坏 user 层与 session 层的统一检索，需要改代码，不建议。

### 4.2 日期字段（第 5 条）

判据：`search` 返回条目里有可解析的 `createdAt` 或 `updatedAt`。

不满足时不需要改代码：`CHAT_MEMORY_DECAY_HALF_LIFE_DAYS` 保持 0，衰减交给平台或直接不启用。

### 4.3 `get` 的归属字段（第 6 条）

判据：`get(memoryId)` 返回体里 `userId` 与写入时一致。

不满足时删除接口会一律返回 404（`memory.userId !== userId`），功能等于不可用但不会越权 —— 失败方向是安全的。

## 五、已知风险

- 自托管版本的 `memory` 字段路径可能与 SaaS 不同（SaaS 为 `memory`，部分版本为 `data.memory`）。代码两处都读（`memory.memory ?? memory.data?.memory`），但仍需实测确认非空。
- 自托管默认不启用平台级 decay，需要本地衰减兜底或接受无衰减。
- 自托管实例的向量库与 embedding 模型需与生产一致，否则换实例后历史记忆检索质量会突变。
- 未验证多租户隔离：若一个实例服务多个业务，`user_id` 冲突风险由部署方保证。

## 六、回滚

把 `MEM0_HOST` 改回 SaaS 地址（或清空 `MEM0_API_KEY` 关闭能力）即可。记忆是派生数据，切换不会影响会话历史（`kh_ai_message` 始终是完整原文）。

需要注意的是**两套实例的记忆不互通**：切换后 user 层画像需要重新积累，session 层上下文随会话自然重建。若必须迁移，按 `getAll` 导出后逐条 `add` 到新实例，并保留 `memory_id` 映射以便本地镜像对齐。
