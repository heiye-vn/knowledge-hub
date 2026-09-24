# 图片类文档多模态解析（VLM Qwen3.8-Flash）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 knowledge-hub 接入图片类文档解析能力（支持 `.png`, `.jpg`, `.jpeg`, `.webp`），使用视觉模型 `qwen3.8-flash` 提取结构化 Markdown 正文与图意摘要，并严格采用独立的 `VLM_API_KEY` 鉴权。

**Architecture:** 在 `document/parser/parsers/` 中新增 `image.parser.ts` 专职负责将图片 Buffer 编码为 Base64 Data URL 并请求兼容 OpenAI 格式的多模态端点；在 `file-parser.service.ts` 中注册图片扩展名并由 NestJS `ConfigService` 注入独立环境变量 `VLM_API_KEY`；解析生成的 Markdown 正文与原图直链无缝复用单库 PostgreSQL 双表落库及下游 RAG / KG 管线。

**Tech Stack:** NestJS 12, TypeScript, 原生 Fetch API (带 AbortSignal 超时), Qwen3.8-Flash (兼容 OpenAI Vision 格式), Vitest

---

## 全局约束与隔离原则

1. **API Key 严格隔离**：必须从 `ConfigService` 读取 `VLM_API_KEY`，**严禁回退或静默复用 `DASHSCOPE_API_KEY` / `LLM_API_KEY`**。未配置时明确提示错误。
2. **端点与模型可配置**：
   - `VLM_MODEL`：默认 `qwen3.8-flash`
   - `VLM_BASE_URL`：默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`
   - `VLM_TIMEOUT_MS`：默认 `60000` (60秒)
3. **零引入冗余依赖**：利用 Node.js 18+ 原生 `fetch` 与 `AbortSignal.timeout()` 进行 HTTP 通信，保持依赖精简。
4. **现有架构零破坏**：不改动数据库 DDL，原图依然上传至 RustFS 对象存储，正文依然落入 `kh_document_content`。

---

## 文件变动清单

- **创建**:
  - `apps/server/src/document/parser/parsers/image.parser.ts`：图片视觉大模型解析器
  - `apps/server/src/document/parser/parsers/image.parser.spec.ts`：图片解析器纯离线 Mock 单元测试（0 Token 消耗）
- **修改**:
  - `apps/server/src/document/parser/file-parser.service.ts`：白名单扩充（png/jpg/jpeg/webp）与路由分支接入
  - `.env.example`：补充 `VLM_API_KEY` 与模型配置模板
  - `docs/TODO.md`：标记图片多模态解析实施状态

---

### Task 1: 编写纯离线 Mock 单测与解析器骨架 (TDD)

**Files:**
- Create: `apps/server/src/document/parser/parsers/image.parser.spec.ts`
- Create: `apps/server/src/document/parser/parsers/image.parser.ts`

**Interfaces:**
- Consumes: Buffer, mimeType, options
- Produces: `parseImageWithVlm(buffer: Buffer, extension: string, options: VlmParserOptions): Promise<string>`

- [x] **Step 1: 编写离线 Mock 测试用例（image.parser.spec.ts）**
  - 使用 `vi.spyOn(globalThis, 'fetch')` 彻底拦截外网请求，0 Token 消耗
  - 覆盖测试点 1：未提供 `VLM_API_KEY` 时立即抛出明确异常，绝不静默使用其他 Key
  - 覆盖测试点 2：正常图片 Buffer 转为 Base64 并组装正确 Payload 成功返回 Markdown
  - 覆盖测试点 3：正确识别 `png`、`jpg`、`jpeg`、`webp` 对应的 MIME 映射
  - 覆盖测试点 4：Mock fetch 返回 401/500 或空 choices 时抛出友好异常

- [x] **Step 2: 编写最小桩代码（image.parser.ts）并运行测试**
  - 确认测试失败（红灯）

- [x] **Step 3: 运行验证**
  - 运行: `pnpm --filter @knowledge-hub/server test image.parser`

---

### Task 2: 完整实现图片解析器 (image.parser.ts)

**Files:**
- Modify: `apps/server/src/document/parser/parsers/image.parser.ts`

- [x] **Step 1: 实现 MIME 类型推断与 Base64 转换**
  - 支持 `png` -> `image/png`, `jpg` / `jpeg` -> `image/jpeg`, `webp` -> `image/webp`
- [x] **Step 2: 构造专业的知识库多模态 System Prompt**
  - 规则：文本逐字还原、表格强制 GFM Markdown、公式识别 LaTeX、架构与时序图输出 Mermaid 及图意说明
- [x] **Step 3: 实现带有超时保护的原生 fetch 请求**
  - 注入 `VLM_API_KEY`、`VLM_MODEL`、`VLM_BASE_URL`
  - 使用 `cleanMarkdown` 规范化返回正文
- [x] **Step 4: 运行单元测试**
  - 运行: `pnpm --filter @knowledge-hub/server test image.parser`
  - 预期: 全部 PASS（绿灯）

---

### Task 3: 接入 FileParserService 并注入独立环境变量

**Files:**
- Modify: `apps/server/src/document/parser/file-parser.service.ts`
- Modify: `.env.example`

- [x] **Step 1: 在 FileParserService 扩充白名单与注入 ConfigService**
  - `SUPPORTED_EXTENSIONS` 集合加入 `png`, `jpg`, `jpeg`, `webp`
  - 读取独立配置项：`VLM_API_KEY`、`VLM_MODEL`、`VLM_BASE_URL`
- [x] **Step 2: 更新 switch 分支分发图片解析**
- [x] **Step 3: 更新 .env.example 模板**
  - 增加 `VLM_API_KEY` 注释与说明，突出与 `DASHSCOPE_API_KEY` 的物理隔离
- [x] **Step 4: 运行单元测试**
  - 运行: `pnpm --filter @knowledge-hub/server test image.parser`

---

### Task 4: 端到端集成验证与质量保障

**Files:**
- Modify: `docs/TODO.md`

- [x] **Step 1: 运行全量 Server 单元测试**
  - 运行: `pnpm --filter @knowledge-hub/server test`
  - 确保全部测试通过（70 passed | 23 skipped）
- [x] **Step 2: 代码规范检查**
  - 运行: `pnpm --filter @knowledge-hub/server lint`（0 error）
- [x] **Step 3: 更新架构进展文档（docs/TODO.md）**
  - 记录 `feat-v2-img` 多模态解析与 Key 隔离的落地实现


