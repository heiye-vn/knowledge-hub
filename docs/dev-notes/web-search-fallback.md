# 联网搜索多提供商降级（Bocha / Tavily）

> **模块覆盖范围**
>
> - `apps/server/src/ai/web-search.service.ts`：提供商链、Bocha/Tavily 适配、失败切换与合并错误
> - `apps/server/src/ai/web-search.service.spec.ts`：顺序、降级、空结果、合并错误、无 Key
> - `apps/server/.env.example`：`WEB_SEARCH_PROVIDERS` / `TAVILY_API_KEY`
> - `apps/web/src/components/ChatMessageParts.tsx`：联网卡展示实际 provider

---

## 一、 问题与目标

博查额度耗尽时接口返回 HTTP 403 / `quota exhausted`，联网问答只能得到一条错误文案。
目标是让搜索后端可配置、可降级：第一个提供商失败时自动尝试下一个，不让单一供应商的额度
或故障直接废掉整个联网能力。

## 二、 配置

```dotenv
# 按顺序尝试，前一个失败自动切换下一个；只启用已配置 Key 的提供商
WEB_SEARCH_PROVIDERS=bocha,tavily
BOCHA_API_KEY=
TAVILY_API_KEY=
```

- 默认顺序 `bocha,tavily`；博查额度耗尽后可改成 `tavily,bocha`，无需改代码。
- 只把 Key 非空的提供商加入链路；第一个没配 Key 会直接跳到下一个。
- 两个 Key 都没配时返回配置错误，不发请求。

## 三、 失败语义

| 情况 | 行为 |
| :--- | :--- |
| HTTP 非 2xx（含 403 配额、401 Key 无效、5xx） | 记录失败原因，切下一个 |
| 网络异常 / JSON 解析异常 | 记录失败原因，切下一个 |
| 接口返回业务错误（Bocha `code != 200` / Tavily `detail`） | 记录失败原因，切下一个 |
| 成功但结果为空 | **不切下一个**，直接返回空结果，避免双份计费 |
| 全部失败 | 返回 `Bocha：...；Tavily：...` 合并错误，不抛异常 |

成功结果增加 `provider: 'bocha' | 'tavily'`，前端联网卡显示
「已搜索公开信息 · Tavily」，日志也打印实际提供商与条数。

## 四、 Tavily 适配

- `POST https://api.tavily.com/search`
- 鉴权：`Authorization: Bearer <TAVILY_API_KEY>`（官方文档已不支持 body `api_key`）
- 请求体：`{ query, topic:'general', search_depth:'basic', max_results: 1..10,
  include_answer:false, include_raw_content:false }`
- 响应映射：`results[].title / url / content` → `title / url / snippet`；
  `siteName` 由 URL hostname 推导。

## 五、 【易错】两个实现细节

1. **不要只在外层 catch 网络错误**：每个 provider 都要独立 try/catch，否则第一个
   网络异常会直接冒泡，第二个提供商根本没机会执行。
2. **不要按「结果为空」降级**：空结果是合法搜索结论，按空降级会让每次冷门查询
   都调用两家引擎，成本和延迟翻倍。降级条件是「错误」，不是「没搜到」。

## 六、 验证

【实录】2026-10-24 本地验证：

- `web-search.service.spec.ts` 8 条用例通过：
  Bocha 成功不调 Tavily、Bocha 403 切 Tavily、Bocha 无 Key 直接用 Tavily、
  Bocha 网络异常切 Tavily、双失败合并错误、双无 Key 不发请求、顺序反转、
  空结果不切第二个。
- 临时脚本将 `BOCHA_API_KEY` 置为无效、保留真实 `TAVILY_API_KEY`：
  `Bocha 401 Invalid API KEY` → `Tavily` 约 2 秒后返回 3 条结果，
  `provider=tavily`，无错误。
- 本地 SSE 联网问答实测：Bocha 当前可用时 `provider=bocha`；工具输出包含
  `provider` 字段，前端可展示实际来源引擎。

## 七、 已知局限与后续待办

- 只在“失败”时降级，**空结果不降级**；若需要“空结果也补搜”，应加显式开关而不是改默认。
- 单次搜索没有独立超时；任一提供商网络挂起会拖慢降级，后续可加
  `WEB_SEARCH_TIMEOUT_MS` + `AbortSignal.timeout`。
- 多个联网工具调用会分别走一遍完整提供商链，模型侧仍由 `modelCallLimit(6)` 收口。
- 提供商顺序是请求级配置，修改 `.env` 后需要重启服务；没有做运行时热更新。
