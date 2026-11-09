# Mem0 契约测试（切换 SaaS ↔ 自托管前必跑）

> 配套文档：[docs/dev-notes/mem0-selfhost.md](../../../docs/dev-notes/mem0-selfhost.md)
>
> **用法**：先设环境变量，再按序执行。每条都写清「期望」，不符合就是该能力不可用。
> 路径以目标实例的 OpenAPI 为准：SaaS 为 `/v1/memories/`，部分自托管版本为 `/memories`。

```bash
export MEM0_HOST=http://localhost:8000     # SaaS 用 https://api.mem0.ai
export MEM0_KEY=<api-key>
export UID_TEST=990001                     # 测试用户
export RID_TEST=880001                     # 测试会话
export MID_USER=                            # 第 1 步返回的 user 层 id
export MID_SESSION=                         # 第 2 步返回的 session 层 id
```

---

## 1. 写入 user 层（能力 1）

```bash
curl -s -X POST "$MEM0_HOST/v1/memories/" \
  -H "Authorization: Token $MEM0_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"我是成都研发中心的后端\"}],\"user_id\":\"$UID_TEST\"}"
```

**期望**：HTTP 200，返回数组，元素含 `id` 与 `memory`（或 `data.memory`）。
把 `id` 记到 `MID_USER`。

## 2. 写入 session 层（能力 2）

```bash
curl -s -X POST "$MEM0_HOST/v1/memories/" \
  -H "Authorization: Token $MEM0_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"本轮只看住宿标准\"}],\"user_id\":\"$UID_TEST\",\"run_id\":\"$RID_TEST\"}"
```

**期望**：同上。记 `id` 到 `MID_SESSION`。

## 3. 检索 user 层（能力 3）

```bash
curl -s -X POST "$MEM0_HOST/v1/memories/search/" \
  -H "Authorization: Token $MEM0_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"岗位\",\"filters\":{\"user_id\":\"$UID_TEST\"},\"top_k\":5}"
```

**期望**：`results` 至少 1 条，内容含「后端」。

## 4. 检索 session 层（能力 4，最关键）

```bash
curl -s -X POST "$MEM0_HOST/v1/memories/search/" \
  -H "Authorization: Token $MEM0_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"住宿标准\",\"filters\":{\"AND\":[{\"user_id\":\"$UID_TEST\"},{\"run_id\":\"$RID_TEST\"}]},\"top_k\":5}"
```

**期望**：只返回 session 层那 1 条，**不得包含「我是成都研发中心的后端」**。
若返回两条，说明 `AND` 被忽略 —— session 层检索会把长期画像当本轮上下文注入，视为不兼容。

## 5. 返回字段（能力 5）

看第 3、4 步的返回体。

**期望**：条目含 `score`（数字）与 `createdAt` 或 `updatedAt`（可被 `new Date()` 解析）。
缺 `score` 或缺时间只影响时间衰减，可接受；两者都缺则 `CHAT_MEMORY_DECAY_HALF_LIFE_DAYS` 必须保持 0。

## 6. 单条读取与归属字段（能力 6）

```bash
curl -s "$MEM0_HOST/v1/memories/$MID_USER/" \
  -H "Authorization: Token $MEM0_KEY"
```

**期望**：返回体 `userId`（或 `user_id`）等于 `$UID_TEST`。
若字段缺失，删除接口会一律 404（安全但不可用）。

## 7. 删除单条（能力 7）

```bash
curl -s -X DELETE "$MEM0_HOST/v1/memories/$MID_USER/" \
  -H "Authorization: Token $MEM0_KEY"
```

**期望**：HTTP 200。再用第 6 步读一次应 404。

## 8. 会话层清空（能力 8）

```bash
curl -s -X DELETE "$MEM0_HOST/v1/memories/" \
  -H "Authorization: Token $MEM0_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$UID_TEST\",\"run_id\":\"$RID_TEST\"}"
```

**期望**：只清掉 session 层；第 3 步的 user 层检索仍应命中。

## 9. 全清（能力 9）

```bash
curl -s -X DELETE "$MEM0_HOST/v1/memories/" \
  -H "Authorization: Token $MEM0_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$UID_TEST\"}"
```

**期望**：user 层与 session 层全部清空，第 3 步检索返回空。

## 10. 分页列表（能力 10）

```bash
curl -s "$MEM0_HOST/v1/memories/?user_id=$UID_TEST&page=1&page_size=20" \
  -H "Authorization: Token $MEM0_KEY"
```

**期望**：返回 `{ count, results }`（`results` 数组）。
若返回的是裸数组或缺 `count`，记忆列表接口会永远显示空页，需要在服务层适配。

---

## 判定

10 条全过 → 可直接切 `MEM0_HOST`。
第 4 条不过 → **不要切**，会污染 session 层检索。
仅第 5 / 6 / 10 条不过 → 可切，但对应功能降级（衰减关闭 / 删除不可用 / 列表为空），需在发布说明里标注。
