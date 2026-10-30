# AGENTS.md - Knowledge Hub 智能助手专有开发指南

本文件是针对 AI 编码助手的行为准则与项目专有架构规则。进入本项目工作前必须严格遵守。

---

## 一、 快速命令索引

在根目录下执行所有统一任务，严禁私自在子目录执行未约定的脚本：

```bash
# 启动本地开发依赖环境（PostgreSQL、Elasticsearch、Redis 等）
pnpm docker:up

# 启动服务端开发环境（带热重载 watch 模式）
pnpm dev:server

# 构建服务端
pnpm build:server

# 运行单元测试
pnpm test:server

# 运行前端单元测试
pnpm test:web

# 运行服务端 E2E 端到端测试
pnpm --filter @knowledge-hub/server test:e2e

# 运行代码规范检查
pnpm --filter @knowledge-hub/server lint

# 数据库迁移（表结构变更后执行 / 查看待办）
pnpm migration:run
pnpm migration:show
```

---

## 二、 架构与编码铁律

### 2.1 存储规范（单 PostgreSQL，2026-09-20 起）
- **元数据与正文**：统一存 PostgreSQL——`kh_document`（元数据）+ `kh_document_content`（正文，1:1，
  `document_id` 同时是主键与外键，DDL 层 `ON DELETE CASCADE`）。
- **大文本必须放独立内容表**，严禁往 `kh_document` 加正文列（列表查询会拖出几 MB 正文）；
  实体侧不建 ORM 级 `@OneToOne`，与 `category_id` 等一样作裸列按 ID 直查。
- **同库多表写入一律用 `em.transaction()`** 保证原子性。原「跨库双写补偿」规范随 MongoDB 下线而作废。
- 【易错】`em.update()` 不走实体生命周期，**不会自动更新 `@UpdateDateColumn`**，需手动带 `updatedAt`。
- **表结构变更必须新增 TypeORM migration**（`apps/server/src/database/migrations/`），并执行
  `pnpm migration:run` 验证；`init-scripts/postgresql/01-init.sql` 是本地空卷引导快照，**已冻结，禁止再改**。
- 运行时与迁移 CLI 共用 `src/database/typeorm.options.ts` / `entities.ts`；新增实体必须登记进 `ENTITIES`。
- **索引写入失败不得只记日志**：调用 `IndexOutboxService.record({ documentId, target, operation, error })`
  落库，由 Worker 退避重试；可见性同步失败同样记录。人工重建入口只作为兜底，不能替代自动补偿。

### 2.2 雪花 ID 与大整数处理
- 所有核心业务实体的主键 ID 必须由雪花算法生成（`nextSnowflakeId()`）。
- JavaScript 原生环境无法安全表示 64 位整型（`bigint`），因此在 TypeScript、DTO、接口入参和出参中，**ID 必须始终使用 `string` 类型**。
- TypeORM 实体主键列必须配置 `transformer: bigintTransformer`。

### 2.3 接口与统一响应规范
- **入参校验**：每个 Controller 接口的入参必须定义专用的 DTO 类，并使用 `class-validator` 装饰器进行严格校验；必须遵循部分更新继承模式（`PartialType` / `OmitType`）。
- **统一响应**：项目已配置全局 `TransformInterceptor` 和 `AllExceptionsFilter`。**Controller 中严禁手动封装 `{ code: 200, data: ... }`**，直接返回原始业务数据即可。

### 2.4 Node.js 原生 ESM 模式约束
- `apps/server/package.json` 配置了 `"type": "module"`。
- 本地模块导入必须包含 `.js` 扩展名（例如 `import { Foo } from './foo.js'`）。
- 引入 CommonJS 依赖时，注意处理 ESM/CJS interop（解构 `.default`），防止运行时抛出 `xxx is not a constructor`。

### 2.5 文件编辑操作规范（强制）
- ⚠️ **严禁在一条消息里对同一个文件发起多个 Edit**。Edit 是「读-改-写」非原子操作，
  并行调用时**全部返回成功，但只有最后写入的那份生效**，前面的修改被静默覆盖。
  - 实际事故（2026-09-23 存储切换）：`document.service.ts` 被改成新旧混合体，
    `publish` 调用了已被覆盖掉的 `loadContent` 方法，编译必然失败。
- 同一文件多处改动的**唯一两种可行做法**：
  1. **串行**：一条消息只发一个 Edit，确认生效后再发下一个；
  2. **Write 全量重写**：先 Read 通读整个文件，再一次性 Write 出目标状态 —— 改动点多时优先用这个。
- 不同文件之间可以并行（互不影响）。
- 收尾自查：`grep` 关键旧标识确认已清零，再跑 `pnpm typecheck:server` 兜底，不要只信 Edit 的 Successfully。

---

## 三、 接口联调与 Apifox 测试集合规范

### 3.1 存放位置（强制）
- **所有提供给 Apifox 导入的接口测试集合，一律放在 `docs/apifox/` 目录下**，禁止散落在其他位置。
- 命名：`<模块或域>.postman_collection.json`，例如 `knowledge-hub.postman_collection.json`。
- 当前已有集合：`knowledge-hub.postman_collection.json`（覆盖系统 / 文档管理 / 上传解析 / RAG 发布 / 知识检索）。

### 3.2 何时必须更新（强制）
新增、修改或删除任何 Controller 接口时，**必须在同一次改动中同步更新 `docs/apifox/` 下对应集合**，包括：
- 新增/变更的路径、HTTP 方法
- DTO 字段增删改（含是否必填、枚举取值、默认值）
- 新增业务模块的 folder 分组

不允许出现「代码已改但集合里接口过时或缺失」的情况。

### 3.3 集合编写约定
- **格式**：Postman Collection **v2.1**（Apifox 原生支持导入，零依赖、零侵入——不要为此引入 `@nestjs/swagger`）。
- **必须使用集合变量**，不得硬编码：至少包含 `baseUrl`（默认 `http://localhost:3000`）与关键路径参数（如 `docId`、`keyword`）。
- **每个请求必须写 `description`**：说明用途、预期返回、易踩的坑。
- **Body 需预填可直接运行的示例值**，并对可选参数使用 `disabled: true` 折叠，避免误传导致校验失败。
- 按业务域分 folder 组织（如「文档管理」「知识检索」），不要全部平铺。

### 3.4 与实际行为保持一致
集合描述中涉及的运行时行为必须与代码实现一致。已知易错点：
- 触发 RAG 索引的**唯一入口**是 `PUT /documents/:id/publish`；通过 `PATCH` 改 `status` **不会**重建向量。
- 阶段一发布与索引为**同步执行**（无消息队列），响应较慢属正常。
- `mode=hybrid` 返回的 `score` 是 RRF 融合分（量级 0.0x），原始分在 `scores.vector` / `scores.keyword`。

---

## 四、 开发笔记（docs/dev-notes）

### 4.1 记录时机（强制）
**每完成一个功能模块，必须为该模块在 `docs/dev-notes/` 下新增一个记录文件**，
并在 `docs/dev-notes/README.md` 的索引表中补一行。

- 完成 RAG 管线 → 新增 `rag-pipeline.md`；完成鉴权 → 新增 `authentication.md`，以此类推。
- **不预先规划、不事后凭空补写**：只有正在写这段代码时才清楚真正的坑在哪，
  事后回看补的"注意事项"会退化成正确废话。

### 4.2 内容要求
每个模块文件记录：遇到的疑难问题、关键决策与取舍、易错点、架构演化过程与优化，以及已知局限。

- 一个模块一个文件，**按模块划分，不要按子步骤拆得过碎**。
- 每条尽量写全：**现象 → 原因 → 解法 → 如何验证**。缺了「如何验证」价值大打折扣。
- **必须标注来源**：【实录】（实际遇到，附真实报错与验证数据）／【易错】（提炼的风险点）。
  不要把推测写成既成事实。
- 文件开头写清模块范围与对应代码路径，结尾写已知局限与后续待办。

---

## 五、 Git 提交规范

遵循 **Conventional Commits** 规范，提交说明必须使用 **中文描述**：

格式：`<type>(<scope>): <中文描述>`

常见类型：
- `feat`: 新增业务功能或接口
- `fix`: 修复缺陷或运行时报错
- `docs`: 文档变更或更新
- `refactor`: 代码重构（不改变外部行为）
- `test`: 增加或修改测试用例
- `chore`: 构建配置、依赖调整或环境脚本变动

示例：
- `feat(document): 支持文档模糊搜索与分类筛选`
- `fix(server): 修复 ESM 模式下导入 CommonJS 依赖的兼容性问题`
- `test(server): 补充统一响应拦截器的 E2E 断言用例`

### 5.1 提交信息规范（强制）

提交信息**只描述本次改动本身**，遵循严谨规范的工程化技术表述：
- 写清「为什么这么做」以及技术改动内容，保持专业、清晰的工程表述风格。
- 示例：
  - ✅ `fix(document): 补齐发布状态守卫，禁止归档文档重新发布`
  - ✅ `feat(storage): 引入策略模式支持本地与云端双存储驱动`
  - ✅ `docs: 更新系统模块设计笔记与待办清单`

---

## 六、 分支迭代与质量保障规范

本项目的迭代开发遵循特性分支与高质量工程规范：

- **分支管理**：新功能开发均在 `feat-*` 分支推进，经测试验证后合并入 `main`。
- **模块笔记沉淀**：实现过程踩坑与核心架构决策统一记录在 `docs/dev-notes/<模块>.md`。
- **先衡量再动手**：改动若涉及「引入新组件」或「改变接口语义」，先用真实数据实测再决定，严禁随意改变系统架构模式。
- **前后端契约统一**：接口契约以服务端 NestJS 实现为单一真理源（SSOT），前端开发严格对齐后端 DTO 与 Postman 集合定义。
