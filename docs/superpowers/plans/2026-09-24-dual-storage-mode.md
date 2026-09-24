# 对象存储双模式（阿里云 OSS 与本地 RustFS）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 knowledge-hub 实现双对象存储驱动（Driver/Strategy 模式），支持通过配置一键切换 **阿里云 OSS** 与 **本地 RustFS**，完整保留 RustFS 代码以便随时查阅和回切，同时业务层（原文件归档、PDF 页面切图、图片解析）零感知无缝迁移。

**Architecture:** 
- 定义通用的 `StorageDriver` 接口与 `{ url, key }` 上传契约；
- 将现有的 RustFS 提取为 `RustfsDriver`（Path-Style 本地 Docker S3 模式）；
- 新增 `AliyunOssDriver`（基于项目已有的 `@aws-sdk/client-s3` 驱动阿里云 OSS，采用 Virtual-Hosted 风格生成规范公网直链，支持自定义域名/CDN，0 额外冗余依赖）；
- 核心门面 `StorageService` 根据环境变量 `STORAGE_DRIVER=oss|rustfs` 动态路由请求；
- `RustfsService` 保留为向下兼容代理，上层 `DocumentService` 与 `FileParserService` 平滑迁移；
- `.env.example` 补充完整的阿里云子账号与 RustFS 配置指引。

**Tech Stack:** NestJS 12, TypeScript, `@aws-sdk/client-s3` (阿里云 OSS S3 兼容协议), Vitest

---

## 全局约束与隔离原则

1. **依赖精简原则**：阿里云 OSS 原生完全兼容 AWS S3 API，直接使用项目已有的高性能 `@aws-sdk/client-s3`，**不额外引入体积庞大的第三方 SDK**（如 `ali-oss`），保持构建产物体积与 TypeScript 类型统一。
2. **完整保留历史实现**：`RustfsDriver` 完整保留现有的 Bucket 探测、创建与 Path-Style 上传代码，不使用注释或删除代码的方式，随时可切回。
3. **URL 规范标准**：
   - 阿里云 OSS 默认公网直链格式：`https://${bucket}.${endpointDomain}/${key}`（例如 `https://my-bucket.oss-cn-hangzhou.aliyuncs.com/documents/2026/09/24/uuid.png`）；
   - 支持 `OSS_CUSTOM_DOMAIN`（如绑定的 CDN/自定义域名），配置时优先使用。
4. **安全与隔离**：
   - 绝不在代码与版本库硬编码 Key，全部通过 `ConfigService` 动态注入；
   - 统一由门面服务处理各 Driver 的启停状态与错误降级。

---

## 文件变动清单

- **创建**:
  - `apps/server/src/storage/storage.interface.ts`：抽象存储契约接口与通用上传参数/响应定义
  - `apps/server/src/storage/drivers/rustfs.driver.ts`：本地 RustFS 存储驱动实现
  - `apps/server/src/storage/drivers/aliyun-oss.driver.ts`：阿里云 OSS 存储驱动实现
  - `apps/server/src/storage/drivers/aliyun-oss.driver.spec.ts`：阿里云 OSS 驱动纯离线 Mock 单元测试
  - `apps/server/src/storage/storage.service.ts`：统一存储门面服务（支持运行时驱动切换）
  - `apps/server/src/storage/storage.service.spec.ts`：存储门面服务单元测试
- **修改**:
  - `apps/server/src/storage/rustfs.service.ts`：重构为代理兼容层，继承/代理 `StorageService`，确保历史调用与单测零破坏
  - `apps/server/src/storage/storage.module.ts`：注册并导出 `StorageService` 及相关驱动
  - `apps/server/src/document/document.service.ts`：类型与注入无缝对接
  - `apps/server/src/document/parser/file-parser.service.ts`：类型与注入无缝对接
  - `apps/server/.env.example`：补充 `STORAGE_DRIVER`、阿里云 OSS 及 RustFS 配置规范
  - `docs/TODO.md`：记录双存储模式实施状态

---

### Task 1: 定义存储统一接口与提取 RustfsDriver

**Files:**
- Create: `apps/server/src/storage/storage.interface.ts`
- Create: `apps/server/src/storage/drivers/rustfs.driver.ts`

**Interfaces:**
- `StorageDriver`:
  - `isEnabled(): boolean`
  - `uploadBytes(bytes: Buffer | Uint8Array, options: UploadBytesOptions): Promise<UploadBytesResult>`

- [x] **Step 1: 创建 storage.interface.ts**
  - 定义 `UploadBytesOptions`, `UploadBytesResult`, `StorageDriver`。
- [x] **Step 2: 创建 drivers/rustfs.driver.ts**
  - 将现有的 RustFS S3 客户端初始化、`ensureBucket`、`uploadBytes` 逻辑封装为符合 `StorageDriver` 的驱动类。
- [x] **Step 3: 语法与类型校验**
  - 运行 `pnpm --filter @knowledge-hub/server typecheck`。

---

### Task 2: 实现 AliyunOssDriver 与编写离线单元测试 (TDD)

**Files:**
- Create: `apps/server/src/storage/drivers/aliyun-oss.driver.ts`
- Create: `apps/server/src/storage/drivers/aliyun-oss.driver.spec.ts`

**Interfaces:**
- Consumes: `ConfigService` (`OSS_REGION`, `OSS_BUCKET`, `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, `OSS_CUSTOM_DOMAIN`, `OSS_ENDPOINT`, `OSS_ENABLED`)
- Produces: `AliyunOssDriver` 实现 `StorageDriver`，上传文件并生成 OSS Virtual-Hosted 风格的 URL。

- [x] **Step 1: 编写 aliyun-oss.driver.spec.ts 离线测试用例**
  - 测试驱动启用判断（未配置 AccessKey 或 `OSS_ENABLED=false` 时 `isEnabled() === false`）；
  - Mock S3Client `PutObjectCommand`，验证发送的 Bucket、Key、ContentType 及 Body；
  - 验证标准公网直链生成规则（`https://<bucket>.oss-<region>.aliyuncs.com/<key>`）；
  - 验证配置 `OSS_CUSTOM_DOMAIN` 时的 URL 替换逻辑。
- [x] **Step 2: 实现 aliyun-oss.driver.ts**
  - 配置 `S3Client`，设置 `forcePathStyle: false`（阿里云标准虚拟主机模式）；
  - 组装对象 Key 与日期目录前缀（`documents/yyyy/mm/dd/name-uuid.ext`）；
  - 实现 `uploadBytes`，通过 `PutObjectCommand` 上传并返回对应直链。
- [x] **Step 3: 运行驱动单测验证通过**
  - 运行 `pnpm --filter @knowledge-hub/server test aliyun-oss.driver`。

---

### Task 3: 实现 StorageService 门面服务与 RustfsService 向下兼容层

**Files:**
- Create: `apps/server/src/storage/storage.service.ts`
- Create: `apps/server/src/storage/storage.service.spec.ts`
- Modify: `apps/server/src/storage/rustfs.service.ts`
- Modify: `apps/server/src/storage/storage.module.ts`
- Modify: `apps/server/src/document/document.service.ts`
- Modify: `apps/server/src/document/parser/file-parser.service.ts`

**Interfaces:**
- `StorageService`:
  - 门面注入 `RustfsDriver` 和 `AliyunOssDriver`；
  - 根据 `STORAGE_DRIVER`（默认 `oss`，若未配 OSS 则智能降级为 `rustfs`）将调用路由到目标驱动。
- `RustfsService`:
  - 作为别名或继承 `StorageService`，确保原有注入点完全兼容。

- [x] **Step 1: 编写 storage.service.spec.ts**
  - 验证 `STORAGE_DRIVER=oss` 时将调用委托给 `AliyunOssDriver`；
  - 验证 `STORAGE_DRIVER=rustfs` 时将调用委托给 `RustfsDriver`；
  - 验证默认与降级策略。
- [x] **Step 2: 实现 StorageService**
  - 实现根据配置路由的调度逻辑。
- [x] **Step 3: 改造 StorageModule 与 RustfsService 兼容代理**
  - 在 `StorageModule` 注册所有驱动，提供 `StorageService` 与 `RustfsService`；
  - 将 `DocumentService` 和 `FileParserService` 的注入平滑指向 `StorageService`。
- [x] **Step 4: 运行存储相关测试**
  - 运行 `pnpm --filter @knowledge-hub/server test storage`。

---

### Task 4: 补充环境配置规范与全量回归验证

**Files:**
- Modify: `apps/server/.env.example`
- Modify: `docs/TODO.md`

- [x] **Step 1: 更新 .env.example**
  - 增加对象存储（Storage）双模式配置段落，列出所有 OSS 与 RustFS 字段及说明。
- [x] **Step 2: 更新 TODO.md**
  - 标记双存储模式与阿里云 OSS 支持完成状态。
- [x] **Step 3: 全量测试与类型检查**
  - 运行 `pnpm --filter @knowledge-hub/server typecheck`
  - 运行 `pnpm --filter @knowledge-hub/server test`
- [x] **Step 4: 生成 Walkthrough 验证文档**
