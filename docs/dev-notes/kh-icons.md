# kh-icons 图标体系接入（前端语义图标）

> **模块范围**：`apps/web/src/components/icons/`（图标组件）、`KhEmpty`、
> `ChatMessageParts` 过程条、文档/图谱/搜索各页面的图标接入、`FileTypeIcon` 类型徽标修复。
> **设计资产**：`design/kh-icons/`（`icons.mjs` 单一数据源 + `build.mjs` 生成器）。
> **时间**：2026-11-12 · 分支 `feat-ui-icons`

---

## 1.【实录】AntD Menu 里放自定义 SVG，尺寸不能超过 14px

**现象**：导航图标最初按"视觉补偿"选了 16px（本套图标内容区 20/24，16px 内容约 13.3px，
直觉上等于 AntD 图标 14px 的观感）。实测发现图标在 Menu 里偏大、且与保留的 AntD 图标
（用户/权限/团队）并排时明显不齐。

**原因**：查 `antd/es/menu/style/index.js` 源码：

```js
iconSize: fontSize,          // 即 14px（默认 fontSize）
// 且 icon 容器样式：
minWidth: iconSize,
fontSize: iconSize,
```

AntD 图标走 `1em`（容器 font-size 14px），自定义固定尺寸 SVG 不受 font-size 影响，
但容器的 `min-width: 14px` 会对 16px 的 svg 产生挤压/顶宽。

**解法**：`NAV_ICON = 14`。此时本套图标实际内容 11.7px vs AntD 约 12.0px，视觉等重。

**如何验证**：侧栏同时放 KhIcon（如"全部文档"）与 AntD 图标（如"审核工作台"），
缩放到 80% / 125% 浏览器缩放对比两者大小——应始终一致。

---

## 2.【实录】KhEmpty 初版漏了 children，typecheck 才暴露

**现象**：`DocumentDetailPage` 的空态里放了一个"返回列表"按钮作为 Empty 的 children，
首版 `KhEmpty` 只声明了 `description / icon / size` 三个 props，`tsc -b` 直接报
`Property 'children' does not exist`。

**原因**：AntD `Empty` 本身支持 children（渲染在描述下方的操作区），包装组件没有透传。

**解法**：补 `children?: ReactNode` 并透传给 `Empty`。

**如何验证**：`pnpm typecheck:web`；访问一个不存在的文档 id（如 `/documents/0`），
空态里应出现可点的"返回列表"按钮。

**教训**：包装 antd 组件时，先枚举原组件会被用到的 prop 面，再裁剪——
否则第一个使用方就会替你发现遗漏。

---

## 3.【易错】过程条节点从圆点换图标，坐标要按中心重算

原 `.kh-trace-node` 是 10×10 圆点（`left: -20px; top: 10px`），中心在
item 坐标 `(-15, 15)`，正好压在时间线（`.kh-trace::before`，left 5px + 宽 2px）上。
换成 18×18 图标时**不能只改宽高**：要维持中心不变，需 `left: -24px; top: 6px`。

节点带 `background: #f5f7fa`（聊天区背景色）+ 3px 同色 `box-shadow`，
用于遮住图标底部穿过的竖线——图标内部有透明区域（如地球图标的留白），
没有实底背景时竖线会从图形缝隙里透出来。

颜色规则从 `background: <语义色>` 整体改为 `color: <语义色>`（图标描边继承），
原 9 种节点色值全部保留，形状成为主编码、颜色退为辅助——
这是本次改造的核心动机（纯色编码在色弱 / 黑白打印场景不可读）。

**如何验证**：发起一次问答，观察过程条：每个节点应显示对应图标
（意图=靶心、知识库=文档+放大镜、评估=仪表盘、改写=循环、联网=地球、思考=灯泡），
pending 状态呼吸动画不丢；把浏览器对比度调到最高 / 截图转灰度，
仅凭形状仍能区分节点类型。

---

## 4.【实录】FileTypeIcon 把上传的图片标成 MD

**现象**：上传 PNG/JPG/WEBP 后，文档列表和详情页都显示紫色 "MD" 徽标。

**原因**：`extFromName` 对无法识别的扩展名一律回退 `'md'`：

```ts
return ext in ICONS ? ext : 'md'   // png 不在 ICONS → 显示 MD
```

而上传区（`UPLOAD_ACCEPT`）明确支持 PNG/JPG/JPEG/WEBP——支持列表与
徽标映射表长期脱节，谁改了一边都会静默出错。

**解法**：未知扩展名回退中性 `file` 徽标（灰色 FILE）；补
`png/jpg/jpeg/webp/svg` 映射（青绿 IMG/SVG）。无后缀（在线新建文档）
仍按 md——这是产品默认格式，语义正确。

**如何验证**：`extFromName('photo.png') === 'png'`，
`extFromName('data.bin') === 'file'`，`extFromName('需求文档') === 'md'`；
上传一张 PNG，列表应显示 IMG 徽标。

---

## 5.【易错】AntD Empty 换自定义 image 要覆盖默认高度

`Empty` 的 `.ant-empty-image` 容器有固定高度（约 40px），直接塞 44px 的
KhIcon 会被裁切。传 `imageStyle={{ height: 'auto', display: 'flex', justifyContent: 'center' }}`
解决。图标色固定 `#bfbfbf`（AntD 空态插图同款灰），不要跟语义色。

---

## 已知局限与后续待办

- 过程条节点 9 种颜色未收敛到语义色板（成功/警告/危险三色之外还有青、橙、靛蓝、灰），
  形状成为主编码后可以安全收敛，留给后续主题化时处理。
- `DocumentDetailPage` 工具条是 AntD（返回/编辑/下架/删除）与 KhIcon（版本/发布/归档）混排，
  16px 下两者线宽差 0.1px 肉眼不可辨；若实际观察觉得不齐，再补 back/edit/delete 三枚
  成套工具条图标，不要预先做。
- 本套图标不覆盖通用操作语义（返回/编辑/删除/下载/缩放），继续用 AntD；
  判断口诀：产品在讲自己的故事用 KhIcon，用户在操作系统用 AntD，
  需要认出文件类型用彩色徽标。
- `design/kh-icons/` 改图标后必须重跑 `node build.mjs` 并把生成的
  `KhIcon.tsx` / `index.ts` 同步到 `src/components/icons/`（目前是复制，未做构建联动）。
