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

## 6.【实录】KhIcon 放进 AntD v6 顶栏 Menu 导致图标/文字换行、页面出滚动条

**现象**：顶栏横向菜单每个菜单项"图标一行在上、文字一行在下"，导航栏被撑高、
图标被 header 顶边裁掉，整页出现滚动条；侧边栏完全正常。

**原因**（读 antd 6.6.5 源码逐层确认，三层叠加）：

1. `.ant-menu-horizontal > .ant-menu-item` 是 `display: inline-block`
   （`es/menu/style/horizontal.js`）——不是 flex，icon 与文字靠 inline 布局同行；
2. antd v6 的 `MenuItem.js` 用 `cloneElement` 把 `.ant-menu-item-icon` class
   **直接加到 `items.icon` 根元素上**（不包 div），该 class 由 `resetIcon` 提供
   `display: inline-flex`；
3. AntIcon 根元素是 `span.anticon`（class 级样式，与 menu 样式合并后仍是
   inline-flex）→ 正常；而 KhIcon 根元素是 SVG 且内联 style 自带
   `display: block`（`KhIcon.tsx` 的 `style={{ display: 'block', flexShrink: 0 }}`）
   ——**内联样式无条件覆盖 class**，block SVG 在 inline-block 的 li 里独占一行，
   把 `.ant-menu-title-content` 挤到第二行。

侧边栏 vertical item 是 flex 容器，SVG 被当 flex item 块化，所以幸免——
这也是为什么同一个 icon 写法在侧栏正常、顶栏崩掉。

**解法**：`AppLayout.tsx` 加 `NavIcon` 包装组件（span 包 KhIcon），让
`.ant-menu-item-icon` 落到 span 上（span 无内联 display，resetIcon 的
inline-flex 生效），`index.css` 加 `.kh-nav-icon { display:inline-flex;
align-items:center; line-height:0 }` 兜底。全部 15 处菜单 icon 统一替换。
**不要改 KhIcon 的默认 style**——`display:block` 在卡片/过程条等 flex 容器里
是正确行为，且该文件由 build.mjs 生成、勿手改。

**如何验证**：`playwright eval` 实测 `iconTopAlignedWithText: true`（图标与
文字 top 差 < 20px）、各菜单项高度一致；DOM 快照中 icon 与文字同层渲染。

---

## 7.【实录】布局链 `height: 100%` 被 antd `flex: auto` 撑破，改 100vh 锚定

**现象**：菜单修好后 `documentElement.scrollHeight - clientHeight` 仍溢出 453px；
逐层 `getComputedStyle().height` 排查发现 `.kh-root` 高 1172.88px（视口仅 720px），
`.kh-content` 与 Sider 全被 dashboard 内容撑到 1117px，`.kh-content` 的
`overflow: auto` 完全失效。

**原因**：antd `.ant-layout` 自带 `flex: 1 1 auto`，`height: 100%` 百分比链在
"内容超一屏"场景被 flex 布局的 min-content 约束反向撑破（flex item 的尺寸
分配基于被撑大的父级），根容器 100% 失效、整页被内容顶出视口。

**解法**：`.kh-root { height: 100vh; min-height: 0; overflow: hidden }`——
100vh 是绝对值，不依赖父级解析，无歧义；`overflow: hidden` 保证页面级永不
滚动（登录页 `.kh-login` 不在 `.kh-root` 内，不受影响，超小屏仍可正常滚动）。
配套把 `.kh-page` 的 `min-height: calc(100vh - 88px)` 修正为
`calc(100vh - 96px)`（56 header + 16/24 content padding，原 88 会恒出 8px 滚动条）。

**如何验证**：`rootH=720px`、`contentClientH=664`、`contentScrollH=1117`
（内容区内部正常滚动、内容完整可达）、`pageOverflowY=0`、
`window.innerWidth - documentElement.clientWidth = 0`（无滚动条占位）。

---

## 8.【实录】菜单图标 14px 发灰/粘连：三层诊断与 compact 模式

**现象**：顶栏菜单图标"不好看"。结论是**适配错位**而非图形本身差——按 24px 设计，
14px 只是等比缩到 58%。

**诊断（可复用于任何小尺寸图标质疑）**：
1. **渲染层**：`strokeWidth 1.6 @ 24 网格` → 14px 实际笔画 `1.6×14/24 = 0.93px`，
   亚像素抗锯齿成 50% 灰线。经验阈值：小尺寸描边 ≥1.25px（24 网格 ≥2.14）。
2. **造型层**：14px 下元素间距 <2.5px 必然粘连——home 窗格 1.5px（粘成块）、
   documents 行线 2.1px、search 镜内线 1.6px、graph 7 元素小圆直径 2.2px（读作散点）。
3. **系统层**：6 个 KhIcon 描边 + 1 个 AntD `UserOutlined`（1024 网格 **fill path**，
   查 `@ant-design/icons-svg` 确认）混排，填充天然比描边"实"；且 admin 盾牌语义偏移。

**解法**：
- `KhIcon` 加 `compact` 属性（启用 small 变体 + 描边 2.1），**不做 size 自动判断**——
  16px 按钮图标与 12px 图例需要全量细节，自动切换会误伤；
- 5 枚导航图标定义 `small` 变体（home 去窗格 / documents 单行线 / search 去镜内线 /
  chat 星芒→3 点 / graph 7→5 元素）；
- 新增 `user` 图标；`admin` 重画为滑块（14px 齿轮会糊成太阳，滑块是唯一清晰形态）。

**如何验证**：`stroke-width` = 2.1、graph `<circle>` 数量 4→3；新排与旧排同屏
14px + 6× 放大对比，肉眼确认无粘连。

**教训**：图标"不好看"先量三件事——实际笔画像素、最密细节间距、同排是否混体系。
换图形排最后。

**后续定稿（2026-11-12）**：compact 优化完成后，观感仍未达预期。结论是问题不在
"画得多好"，而在"14px 本就不该放线性图标"——**顶栏与侧栏导航已改为纯文字**
（7 个菜单名自解释，图标属纯装饰）。`compact` 能力保留在 `KhIcon` / `icons.mjs`
中作为小尺寸场景的备用能力，导航不再调用；nav 组图标资产保留未删。
侧栏折叠时 AntD 回退显示菜单项首字（`inline-collapsed-noicon`），属可接受行为。

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
- 12px 场景（Agent 过程条节点、图谱图例、来源标记）暂无 small 变体，细节同样偏密；
  这些位置图标本身就是"信息编码"（形状承担语义），暂按全量细节使用，
  若后续反馈不清晰，可复用 `compact` 机制为 agent/state 组补 small。
- `admin` 已从盾牌改为滑块（`sliders` 语义），若业务更强调"权限/安全"，
  需另加一枚 `shield` 图标承担该语义，不要改回 `admin`。
