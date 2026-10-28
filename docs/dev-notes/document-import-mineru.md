# 文档导入：MinerU 扫描件解析与持久化异步任务

> 类型：功能模块 · 文档导入（分支 `feat-v20`）
> 代码路径：`document/parser/mineru*.ts`、`document/parser/{file-parser,file-signature,image-references,parse-result}.ts`、
> `document/document-import.{service,queue,controller}.ts`、`document/entities/document-{import,resource}.entity.ts`、
> `storage/resource-crypto.ts`、`web/src/{components/DocumentImports,DocumentMarkdown,AuthenticatedImage,SourceFileAction}.tsx`、
> `web/src/document-imports.ts`、迁移 `1790000002000-document-imports.ts`

---

## 覆盖范围

把 PDF / DOCX / PPTX 的解析切到 MinerU 精准解析，覆盖扫描件 OCR、公式、HTML 表格和图片；TXT/MD/XLSX 与独立图片保留本地解析。上传接口改为返回持久化任务，解析在 BullMQ 后台执行；原文件和图片加密保存，正文通过鉴权资源接口读取，而不是把对象存储直链写进内容。

导入记录支持软隐藏：`DELETE /documents/imports/:id` 隐藏单条、`DELETE /documents/imports` 清空已完成/失败记录（`dismissed` 字段，迁移 `1790000003000`），只影响列表展示，不删除草稿文档、加密资源与原文件，进行中任务返回 409。前端导入记录改为折叠面板：有进行中/失败任务时自动展开，其余时间只保留一行摘要，避免大量已完成记录把文档列表顶下去。

---

## 核心决策

### 1. 云端 MinerU 是 HTTP 服务，不是 Node SDK

**【实录】** 参考实现的 Node 后端直接用 `fetch` 调 `/api/v4/file-urls/batch`，没有安装任何 MinerU 包；本项目沿用该模式，并补上地址校验、DNS 固定、响应体上限和重定向限制。Python 只存在于开源自建形态；云端精准解析 API 与语言无关。

### 2. 扫描件必须显式区分解析后端

**【易错】** 参考 v20 只对图片扩展名传 `is_ocr=true`，PDF 依赖 `model_version=vlm` 隐式 OCR。本项目对 PDF 也显式传 `is_ocr=true`，Office 文档传 `false`，避免把「扫描件识别」变成不可解释的模型默认行为。

### 3. 解析必须异步，且状态要能跨进程恢复

**【实录】** 参考实现同步等待 MinerU，最长 10 分钟，前端必须停留在页面。本项目：

- `POST /documents/upload/parse` 先把原文件加密落存储，再写 `kh_document_import`，立即返回 202 + taskId；
- `DocumentImportQueue` 用 BullMQ + 5 秒补偿扫描；任务进度写在 PG，不依赖 Redis 保存文件 Buffer；
- PG advisory lock 保证同一任务只会被一个 Worker 处理；`requestId + 文件哈希` 保证网络重试幂等；
- MinerU 的 batchId/uploadUrl 存入 checkpoint，重试优先续跑已有 batch；POST 结果不确定时禁止盲目重提。

### 4. 私有文档不能再走公开对象直链

**【实录】** 以往 PDF 图片直接上传对象桶并写公开 URL，文档 ACL 管不住图片。本项目：

- 资源和密钥分别落 `kh_document_resource`（密钥按资源随机生成），密文写对象存储；
- 正文只写 `/documents/{docId}/assets/{assetId}`；
- `GET` 资源接口先做文档可见性检查，再读取、解密、以 `StreamableFile` 返回；
- `TransformInterceptor` 必须放行 `StreamableFile`，否则二进制会被包成 JSON 信封。

### 5. 代理 fake-IP 与安全校验的边界

**【实录】** 本机 Clash/TUN 会把 `mineru.net`、`cdn-mineru.openxlab.org.cn` 解析到 `198.18.0.30` / `2001:2::19`，安全校验起初把这些地址当成内网地址，导致 `MINERU_UNSAFE_URL`。修复方式：**域名白名单仍然先于 DNS 校验**，只对已通过白名单的 MinerU 域名放行 198.18.0.0/15 与 2001:2::/48；RFC1918、回环、链路本地、云元数据地址仍拒绝。这样兼容本地代理，又不放开任意 URL 下载。

### 6. 检索上下文按预算保留完整块

**【实录】** MinerU 的表格/公式长度增加后，原有 800/180 字截断会把 HTML 表和公式拦腰截断。本项目：

- 分块器保护 fenced code、`$$` 公式和 HTML/GFM 表格；超长表格按行拆分并重复表头；
- 问答、改写、相关性判断共用 `context-budget.ts`，按保守的 UTF-8 字节预算保留完整块，超预算跳过整块并保留原引用编号；
- 不把截断后的片段塞给模型。

---

## 关键易错点

1. **签名上传 URL 不要带 `Content-Type`**：MinerU 的 PUT 上传链接可能因额外头拒绝；只保留必要的 `Content-Length`。
2. **POST 没有幂等键**：请求发出后网络断开，云端可能已创建任务，不能自动重放；必须要求 checkpoint 或明确失败。
3. **资源下载 URL 不能直接信任**：即使来自 MinerU API，也要限制 HTTPS、可信域名后缀、公网 DNS、响应大小和重定向；API 请求的 Bearer 绝不能跟着 302 走到资产域名。
4. **ZIP 元数据会撒谎**：先检查中央目录/本地头与总解压上限，再用 `inflateRawSync(maxOutputLength)` 和 CRC 校验；禁止路径穿越、符号链接、嵌套 SVGA 和未引用的图片。
5. **扫描件“成功”不等于有文字**：没有有效文本、只剩图片占位时必须失败，不能生成空正文草稿。
6. **MinerU 与 Object Storage 的失败要分类**：Token 缺失、文件格式错误是终止性；429/5xx/网络是可重试；重试不得重复创建草稿。
7. **`timestamp` 时区会漂移**：导入表统一用 `TIMESTAMPTZ`；历史 `kh_document` 仍是 `TIMESTAMP`，列表时间显示可能相差时区，属于既有问题。

---

## 验证记录

- `pnpm test:server`：637 passed / 7 skipped（含新增 MinerU、导入、存储加密、分块、上下文预算与记录隐藏用例；集成套件默认跳过）
- `RUN_IMPORT_INTEGRATION=true pnpm --filter @knowledge-hub/server test src/document/document-import.integration.spec.ts`：8 passed；使用真实 PostgreSQL 隔离 schema，覆盖加密原文件、幂等提交、非本人访问、失败重试、软删除后资源拒绝、记录隐藏不影响文档资源
- `pnpm test:web`：71 passed；覆盖 XSS 清洗、KaTeX、HTML/GFM 表格、私有图片 Blob 与下载、折叠面板、记录隐藏/清空、单请求轮询
- `pnpm build:server`、`pnpm build:web`：通过
- `pnpm migration:run`：`DocumentImports1790000002000` 执行成功
- 接口实测：MD 上传 → 202 → 3 秒内 completed → 文档正文、表格、公式落库；同 requestId 重试同任务，内容变化返回 409；原文件下载 200
- **扫描件实测**：`scanned-1page.pdf` → parsing → downloading → completed，生成 1471 字符正文；未配置 Token 时返回“未配置 MinerU 解析服务”
- **复杂 PDF 实测**：`example.pdf`（公式/表格/图片）解析出 50,692 字符、HTML 表格、图片资源；鉴权 asset 接口返回 `image/jpeg` 200
- 浏览器实测：登录 → 文档页 → 上传 MD → 最近导入显示“已完成” → 详情页 KaTeX 与表格渲染；复杂 PDF 页面渲染 65 个 KaTeX 公式、5 张表格，图片以 Blob URL 加载，无加载失败回退
- **未实测**：P1 的文档内嵌图片 VLM 语义描述未实现

---

## 已知局限与后续待办

- 失败任务留下的已上传图片资源没有自动清理 Worker；当前靠重试复用，后续补按任务/文档的孤儿资源清理。被隐藏（dismissed）的失败任务资源同样等待清理。
- 任务队列依赖 Redis；`REDIS_ENABLED=false` 或队列启动失败时上传返回 503（控制器检查 `queue.isReady()`），已排队任务需等队列恢复或进程重启后的补偿扫描。
- 旧文档的公开图片 URL 仍保留；新导入资源才走加密鉴权链路。
- `kh_document` 的 `timestamp` 历史时区问题未迁移，导入任务表已使用 `timestamptz`。
- MinerU 云端解析会发送文档到外部服务；涉密环境需改为自建兼容网关并重新验证协议差异。
