# KH Icons · 图标资产与使用规范

Knowledge Hub 专用线性图标集，29 枚，面向「企业知识库 + Agentic RAG」界面。
本目录是**独立设计资产**，未接入 `apps/web`，可按需取用。

```
design/kh-icons/
├── icons.mjs         单一数据源（改图标只改这里）
├── build.mjs         构建脚本：node build.mjs
├── icons.svg         SVG Sprite
├── svg/              29 个独立 SVG 文件
├── KhIcon.tsx        React 组件
├── index.ts          组件 + 元数据出口
├── manifest.json     机器可读清单（命名 / 分组 / 用途）
├── preview.html      规范与预览页（浏览器打开）
├── audit.md          UI 图标落位分析
└── preview.tpl.html  预览页模板（构建时注入数据）
```

---

## 一、基础规格

| 项 | 值 |
| --- | --- |
| 画布 | `viewBox="0 0 24 24"` |
| 内容安全区 | 20 × 20（四周留 2px） |
| 描边宽度 | `1.6`，不随尺寸缩放 |
| 端点 / 拐角 | `round` / `round` |
| 实心点缀 | 每枚 ≤ 1 处（星芒、节点、锁孔） |
| 颜色 | `currentColor`，跟随父级 `color` |
| 命名 | `kh-<semantic>`，kebab-case，禁止序号 |

**为什么是 1.6**：项目大量使用 Ant Design 线性图标（视觉粗细约 1.5–1.6）。
取 1.6 可与 AntD 图标同尺寸并排而不跳；同时 24 网格下 1.6 在 16 / 20 / 24 / 32px 四档均有稳定抗锯齿表现。

---

## 二、尺寸档位

| 尺寸 | 用途 |
| --- | --- |
| 14px | Agent 过程条节点、Tag 内 |
| 16px | 侧栏菜单、按钮内图标 |
| 20px | 主按钮、卡片右上操作 |
| 24px | 顶栏导航、页面标题 |
| 32px | 详情页文档类型、空态 |

同一行（同一按钮组 / 同一列表行）的图标尺寸必须一致；图标与文字间距取 6px（紧凑）或 8px（常规）。

---

## 三、颜色语义

| 语义 | 色值 | 令牌 |
| --- | --- | --- |
| 默认 / 可交互 | `#1677ff` | `colorPrimary` |
| 成功 / 通过 / 已发布 | `#52c41a` | `colorSuccess` |
| 处理中 / 待审核 | `#faad14` | `colorWarning` |
| 失败 / 危险 | `#ff4d4f` | `colorError` |
| 次要 / 禁用 | `#8c8c8c` / `#bfbfbf` | `colorTextSecondary` |
| 图谱 / 标签 | `#9254de` | 主题紫 |

规则：
1. **颜色不单独承担语义**。同一含义必须同时有形状差异（这是本套图标替换过程条彩色圆点的核心理由）。
2. 装饰性用色禁止。一个屏幕内出现超过 4 种图标色时，先问「这个颜色在编码什么」。
3. 危险操作的图标必须同时是 danger 色 + 垃圾桶/警告形状，不允许只靠颜色。

---

## 四、三种落地方式

### 1. React 组件（推荐）

把 `KhIcon.tsx` 与 `index.ts` 复制到 `apps/web/src/components/icons/`：

```tsx
import { KhIcon } from '@/components/icons'

<KhIcon name="retrieve" size={16} />
<KhIcon name="success" size={16} color="#52c41a" />
```

组件内联 path，无运行时请求；`name` 为字面量联合类型，拼错会编译报错。

### 2. SVG Sprite

把 `icons.svg` 放到 `public/`：

```html
<svg width="24" height="24"><use href="/icons.svg#kh-retrieve" /></svg>
```

注意：跨文件 `<use>` 在部分旧版浏览器有兼容问题；若需兼容 IE / 老版 Safari，
请改用组件方式或把 sprite 内联到 HTML 顶部。

### 3. 独立文件

`svg/kh-*.svg` 可直接拖入 Figma / Sketch，或用 `<img src>` 引用（此时 `currentColor`
不生效，会渲染为黑色，需在文件内改成具体色值）。

---

## 五、在 Ant Design 中使用

图标可以直接塞进 AntD 组件：

```tsx
<Button icon={<KhIcon name="publish" size={16} />} type="primary">发布</Button>

<Menu items={[{ key: '/chat', icon: <KhIcon name="chat" size={16} />, label: 'AI智能问答' }]} />
```

与 AntD 图标共存时：
- 同尺寸、同语义层级；
- 不要在同一按钮组里混用「AntD 实心图标 + 本套线性图标」；
- AntD 图标默认 `1em`，本套默认 24px 固定值，放进 Menu 时显式传 `size={16}`。

---

## 六、扩展新图标

1. 在 `icons.mjs` 的对应分组里追加一条：

```js
{
  name: 'sync-status',
  zh: '同步状态',
  group: 'state',
  use: '索引同步状态徽标',
  keywords: ['sync', '同步'],
  shapes: [
    { t: 'p', d: 'M...' },
    { t: 'fc', cx: 12, cy: 12, r: 1.4 },
  ],
}
```

2. 执行 `node build.mjs`，六个产物全部自动更新。
3. 打开 `preview.html`，切到 48px + 开「24 网格」，检查：
   - 是否触及安全区边界（虚线框）；
   - 描边是否与其他图标等重；
   - 16px 下是否仍可辨认。

形状类型：`p` 描边路径 / `c` 描边圆 / `r` 描边圆角矩形（支持 `dash`）/ `f` 填充路径 / `fc` 填充圆。

---

## 七、校验清单（交付前）

- [ ] 24 网格内，内容不越出 2px 安全区
- [ ] 描边全部 1.6，端点全部 round
- [ ] 实心元素 ≤ 1 处
- [ ] 16px 下语义仍可辨认（缩小到 16px 看不出来的图标要重画）
- [ ] 黑白打印 / 色盲模拟下，形状仍可区分
- [ ] 命名符合 `kh-<semantic>`，无 `icon1` `new` `final` 之类
- [ ] `manifest.json` 数量与 `svg/` 文件数一致

---

## 八、已知取舍

- **图标集不覆盖通用操作**（返回、编辑、删除、下载、放大）。这些继续用 AntD 图标，
  避免为了「统一」而重造 200 个轮子。
- **文件类型徽标另属一套体系**。`FileTypeIcon` 是「彩色底 + 扩展名字母」的 badge 逻辑，
  与线性图标不冲突，不建议强行统一为线性风格 —— 类型识别的第一诉求是色彩区分度。
  但需要补齐 `png` / `jpg` / `jpeg` / `webp` / `svg` 映射，并修正未知扩展名回退为 `md` 的问题。
- **未提供位图导出**。如需 PNG，从 `svg/` 批量导出即可，建议 1x / 2x / 3x 三档。

---

## 九、版本

`1.0.0` · 2026-11-12 · 29 枚 / 6 组
修改 `icons.mjs` 后务必重跑 `node build.mjs`，不要手改生成产物。
