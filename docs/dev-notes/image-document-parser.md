# 图片类文档解析：视觉大模型驱动与多模态知识入库

> 完成时间：2026-09-24  
> 类型：功能模块 · 文档解析（分支 `feat-v2-img`）  
> 代码路径：`document/parser/parsers/image.parser.ts`（新增）、`document/parser/parsers/image.parser.spec.ts`（新增）、
> `document/parser/file-parser.service.ts`（路由白名单扩充）、`document/document.service.spec.ts`（单测追加）、
> `.env.example`（环境变量）

---

## 覆盖范围

支持图片格式（`.png`、`.jpg`、`.jpeg`、`.webp`）上传并解析为结构化 Markdown，无缝沉淀至单 PostgreSQL 架构（`kh_document` 与 `kh_document_content` 表），并自然接入下游 Elasticsearch 向量检索与 Neo4j 知识图谱抽取。

---

## 核心决策依据与架构考量

### 1. 为什么选视觉大模型（Qwen3.8-Flash）而非传统 OCR（PaddleOCR）？

传统 OCR（如 PaddleOCR、Tesseract）在很多 Python 老项目中很常见，但在 RAG 知识库场景存在本质硬伤：
- **PaddleOCR（“打字员”）**：只做几何切字与字符匹配。遇到一张微服务架构图，它只能吐出零散单词 `["网关", "鉴权", "MySQL", "Redis"]`，**根本不知道箭头往哪指、谁调用谁**；遇到无框表格或折线图更是排版碎裂。
- **Qwen3.8-Flash（“架构师”）**：整张图作为视觉 Token 输入，能深度理解全局流转逻辑。不仅还原文字与标准 GFM 表格（`| 列1 | 列2 |`），还能将架构图时序关系提取为等效的 Mermaid 代码块，并在文末生成 **Visual Summary（视觉语义摘要）**。
- **对 RAG 的核心收益**：Visual Summary 会被一同向量化进入 ES `kh_chunk`。当用户提问“*系统的订单流转架构是怎样的？*”，向量检索能直接命中这张图片文档！

### 2. 为什么传 Base64 Data URL 而非二进制或公网 URL？

大模型接收图片有三种形式：Base64 Data URL、公网直链 URL、以及厂商二进制 Files API。本模块选型 Base64 的根本原因：
- **【易错】本地/内网对象存储的“云端无法访问”陷阱**：
  若先把图片传到本地 RustFS（`http://localhost:9000/documents/xxx.png`），再将 URL 传给云端百炼，百炼云端服务器**根本无法反向访问开发者的 localhost 或企业内网**，直接报 `URL unreachable`。
- **Base64 的绝对安全性**：图片字节直接装在 JSON Body 内发送，零公网暴露要求，内网、本地、开发机 100% 成功。
- **体积与性能权衡**：知识库图通常在数百 KB 到 2~3 MB，Base64 膨胀 33% 仅增加几百毫秒网络传输，换来的是极致的部署鲁棒性。

### 3. API Key 严格物理隔离原则

- **决策**：读取独立的 `VLM_API_KEY`，**严禁静默回退或复用 `DASHSCOPE_API_KEY` / `LLM_API_KEY`**。
- **原因**：视觉大模型与纯文本大模型的计费阶梯、用量配额、权限归属通常在企业内是独立审计的。未配置 `VLM_API_KEY` 时明确抛出 `400 BadRequestException` 提示，防止因隐式复用导致非预期的费用开销或权限越界。

### 4. 单测“零 Token 消耗”防线（Mock 隔离）

- **【易错】严禁在日常单测中真实请求大模型**：
  每次 `pnpm test` 若真实请求外部大模型，不仅产生不必要的 Token 计费，还会因外网抖动造成随机失败（Flaky Tests）。
- **解法**：`image.parser.spec.ts` 中通过 `vi.spyOn(globalThis, 'fetch')` 彻底拦截网络调用，纯在内存中验证 Payload 拼装、MIME 识别、Base64 转换与异常捕获。整个单测套件耗时仅 18ms，**外部请求 0 次，Token 消耗为 0**。

---

## 关键改动与实现细节

1. **统一扩展名路由**：
   在 `FileParserService.SUPPORTED_EXTENSIONS` 注册 `png/jpg/jpeg/webp`，并在 `parse()` 增加分支调用 `parseImageWithVlm()`。
2. **专业级 System Prompt 约束**：
   强制模型输出规整 Markdown、GFM 表格、LaTeX 公式（`$...$` 与 `$$...$$`）以及 Mermaid 流程图代码，严禁输出无意义客套话。
3. **超时保护**：
   使用 Node.js 原生 `fetch` + `AbortSignal.timeout(timeoutMs)`（默认 60s），避免视觉大模型慢请求挂死 Node 事件循环。
4. **下游透明无缝复用**：
   解析出的 Markdown 正文直接入库 `kh_document_content`，发布后（`PUT /documents/:id/publish`）自动切块嵌入 Elasticsearch `kh_chunk` 与 Neo4j 建图，原图直链通过 `file_url` 永久可反查。

---

## 已知局限与后续待办

- **超大高清原图压缩**：对于数千万像素、超过 10MB 的超大原图，未来可引入 `sharp` 库在转 Base64 前进行等比降采样，节省网络带宽。
- **双模自适应（URL vs Base64）**：若未来图片已直接上传至公网 CDN/OSS，可允许直接传公网 URL，免去 Base64 转换开销。
