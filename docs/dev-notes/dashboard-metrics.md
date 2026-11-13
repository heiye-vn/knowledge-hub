# 首页数据仪表盘与可观测性（kh-doc_view_log / kh_audit_log）

> **模块范围**：`apps/server/src/audit/`（审计日志）、`document/entities/document-view-log.entity.ts`、
> `document.service.ts`（statsOverview / statsByCategory / viewTrend / recordView / 审计埋点）、
> `apps/web/src/pages/DashboardPage.tsx`、`apps/web/src/layouts/AppLayout.tsx`（宽度与侧栏）。
> **表**：`kh_doc_view_log`、`kh_audit_log`（迁移 `1790000006000-observability`）。
> **时间**：2026-11-12

---

## 1.【实测】ECharts 容器不能随 loading 卸载，否则整页白屏

**现象**：首页点「近 30 日」，整页白屏，Console 报：

```
NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.
    at commitDeletionEffectsOnFiber → removeChild
```

**原因**：图表的渲染写法是"条件渲染"——`loading ? <Spin/> : <div ref={chartEl}/>`。
首次加载没问题（那时是**挂载**）；但切换区间时 loading 置 true，React 要**卸载**那个图表
div，而 ECharts 早已往里面注入了 canvas —— React 按自己的 fiber 记录找子节点，
发现结构被改过，`removeChild` 失败，错误冒泡到最近的边界（没有 boundary 就白屏）。

**解法**：**图表容器常驻，加载/空态用遮罩层覆盖**，绝不让 React 卸载它：

```tsx
return (
  <div className="kh-dash-chart-wrap">
    <div ref={ref} className="kh-dash-chart" />
    {loading || !data.length ? <div className="kh-dash-chart-mask">…</div> : null}
  </div>
)
```

配套三点：
1. 实例用 `useRef` 持有，**只 init 一次**（`echarts.init` 重复调用会告警并泄漏实例）；
2. 数据变化用 `setOption(option, true)`（notMerge）整体替换，而不是重新 init；
3. 仅在组件真正卸载时 `dispose()`（独立的空依赖 effect 里做）。

**如何验证**：`近 30 日 → 近 7 日 → 近 30 日` 连续切换三次，Console 应为
`Errors: 0, Warnings: 0`，且 30 天轴正常渲染（日期标签自动隔天显示）。

---

## 2.【易错】统计接口的可见性必须与列表一致

`GET /documents/stats/overview` 与 `/stats/categories` 都抽了私有方法
`applyVisibility(qb, user)`，条件与 `findAll` 完全相同：

```
doc.author_id = :me OR (doc.status = 已发布 AND (doc.is_public OR doc.team_id IN (:...teamIds)))
```

否则普通用户能从"总量"或"分类占比"里推断出私有文档的存在（数量侧信道）。
**任何新增统计接口都要复用这个方法，不要另写一套 where。**

---

## 3.【易错】三个数字必须同源：文档总数 = 分类合计

首页统计卡最初用 `GET /users/me/stats` 的 `documentCount`（= **我创建的**文档数），
而环形图用分类统计（= **可见范围**全部文档），导致「文档总数 15 / 环形图 14」对不上。
用户一眼就能看出矛盾。

解法：新增 `statsOverview`（COUNT + SUM，同一可见性），文档总数与分类合计同源。
`/users/me/stats` 保留给个人中心，语义是"我的贡献"。

**验证**：任意时刻 `overview.documentCount === Σ categories.count`。

---

## 4.【实录】软删文档被计入"我的文档数"

`user.service.getUserStatistics` 的 `count({ where: { createBy: userId } })` 漏了
`deleted: false`，删掉的文档仍算在个人统计里（本次实测 15 vs 14 暴露）。
修复后与其它统计口径一致。

**教训**：TypeORM 的 `count/find` 不会自动过滤软删标记，只要实体有 `deleted` 列，
每个查询都要显式带上——统计类接口尤其容易漏。

---

## 5. 审计日志的设计取舍

| 决策 | 做法 | 理由 |
| --- | --- | --- |
| 写失败怎么办 | `record()` fire-and-forget，catch 静默 | 审计是旁路能力，不能拖垮业务主流程 |
| 记录范围 | 只记写操作（8 种：创建/更新/删除/发布/提审/归档/审核通过/驳回） | 读操作量大且无审计价值 |
| 标题怎么存 | `target_name` 冗余存当时的标题 | 文档改名/软删后，历史记录不能失真 |
| 谁能看 | 管理员看全部，普通用户只看自己的 | 避免通过操作记录推断他人私有文档 |
| 是否建外键 | 不建 | actor/target 都可能被软删，历史必须保留 |
| 已删文档的链接 | 查询时批量判定 `targetExists`，软删则渲染为灰色「（已删除）」 | 审计记录保留但链接不可点——否则用户点进删除记录必然 404 |

---

## 6. 侧栏与宽度（前端布局）

- `.kh-page` 统一 `max-width: 1400px` 居中（1400 + content padding 20×2 = 1440 = 原型视口）；
  **图谱页例外**（`max-width: none`，画布需要空间）。
- 侧栏曾尝试"单菜单项模块自动隐藏"，被用户否决——**结构性导航元素的消失会破坏布局稳定感**，
  即使省下 220px 也不值得。结论：侧栏始终显示，可手动折叠，但不消失。

---

## 已知局限与后续待办

- 访问趋势粒度是"天"（`kh_doc_view_log` 按 created_at 聚合），没有小时级；原型的"今日"tab 因此未做。
- 浏览埋点是"每次读取详情写一行"，同一用户刷新会重复计数；量级上来后可加去重（Redis SETNX 或按分钟聚合）。
- 操作记录暂无独立列表页（首页只展示最近 8 条），"查看更多"未做。
- 埋点从 2026-11-12 上线，此前的浏览/操作没有历史数据，趋势图前期恒为 0 属正常。
