# Knowledge Hub（企业级知识库与智能问答系统）开发上下文

## 一、 项目定位与愿景
`knowledge-hub` 是一个现代化的企业级知识库与智能问答（RAG, Retrieval-Augmented Generation）系统。旨在提供大规模文档协作、多格式知识解析、向量与全文混合检索，以及基于大语言模型的严谨知识库智能问答。

---

## 二、 架构全景与技术栈

### 2.1 工程结构 (Monorepo)
项目采用 `pnpm workspace` 管理的多包单体仓库（Monorepo）：
- `apps/server`: 后端核心微服务（NestJS + Node.js 原生 ESM 模式）。
- `init-scripts/`: 数据库初始化脚本（PostgreSQL 扩展与初始表结构、MongoDB 索引）。
- `docs/`: 架构设计文档（`docs/superpowers/specs/`）与实施任务计划（`docs/superpowers/plans/`）。
- `contexts/`: 项目上下文沉淀文件（`contexts/context.md`）。

### 2.2 核心技术栈
- **服务端框架**：NestJS v12 + Express（`"type": "module"` 原生 ESM）
- **数据库**：
  - **PostgreSQL 16 + pgvector**：存储文档元数据（`kh_document` 表）、权限、分类、标签及未来的嵌入向量。
  - **MongoDB 7**：存储超长 Markdown 正文（`document_content` 集合），支持灵活的版本与变动历史。
- **ORM / ODM**：TypeORM（Postgres）+ Mongoose（MongoDB）
- **ID 生成**：Snowflake（雪花 ID 64 位整型，TypeScript/JS 侧一律用 `string` 承载，PostgreSQL 侧使用 `bigint`）
- **测试框架**：Vitest + Supertest（单元测试与 E2E 测试）
- **代码规范**：Oxlint + Prettier

---

## 三、 核心架构规范与设计约定

### 3.1 元数据与正文双写隔离架构
- **写入链路**：
  1. 生成雪花 ID (`nextSnowflakeId()`)；
  2. 先写入 MongoDB `document_content` 集合，获取其 `_id`；
  3. 将该 `_id` 转换为字符串写入 PostgreSQL `kh_document.content_id`（有唯一键约束）；
  4. 若 Postgres 事务写入失败，补偿删除刚才写入的 Mongo 记录，杜绝脏数据。
- **查询链路**：
  - 列表分页查询：只查 PostgreSQL，极大减轻正文大字段的 I/O 负担；
  - 详情查询：先根据主键查 PostgreSQL，再根据 `contentId` 查询 Mongo 正文拼接返回。

### 3.2 全局切面（AOP）标准
- **成功响应**：由 `TransformInterceptor` 统一包装为标准信封格式：
  ```json
  {
    "code": 200,
    "message": "success",
    "data": { ... },
    "timestamp": 1726405550715
  }
  ```
- **异常响应**：由 `AllExceptionsFilter` 统一拦截捕获，对齐 HTTP 状态码并友好展开 `ValidationPipe` 参数校验错误信息：
  ```json
  {
    "code": 400,
    "message": "title 不能为空",
    "error": "Bad Request",
    "path": "/documents",
    "timestamp": 1726405550715
  }
  ```

### 3.3 大整数处理
- Snowflake 生成的 64 位 ID 在 JavaScript 原生 Number 中会精度溢出。
- 数据库字段类型为 `bigint`，TypeORM 实体统一应用 `bigintTransformer`，保证实体层与 DTO 一律为 `string` 类型。

---

## 四、 当前模块实施现状

| 模块名称 | 状态 | 关键实现 |
| :--- | :--- | :--- |
| **基础骨架** | ✅ 已完成 | Monorepo、Docker Compose 编排、PostgreSQL + MongoDB 容器健康就绪 |
| **全局切面** | ✅ 已完成 | 全局校验管道、`TransformInterceptor`、`AllExceptionsFilter`、健康检查 `/health` |
| **文档模块 (Document)** | ✅ 已完成 | 创建（双写+补偿）、列表分页模糊搜索、详情读取、部分字段更新（PATCH）、软删除 |
| **测试与调试** | ✅ 已完成 | Vitest 单元测试、E2E 测试、`test/manual/document-curl.md` 联调脚本 |
| **向量检索与 RAG** | ⏳ 规划中 | pgvector 索引构建、文本分块管道（Chunking）、Embedding 模型接入 |
| **鉴权与团队管理** | ⏳ 规划中 | RBAC 权限控制、JWT 认证、分类团队管理 |

---

## 五、 开发环境与已知注意点
1. **ESM/CJS 兼容**：项目处于 Node.js 原生 ESM 模式，引入旧版仅支持 CJS 导出的第三方库（如 `snowflake-id`）时，需解构其 `.default` 属性，避免 `TypeError: xxx is not a constructor`。
2. **本地调试启动**：
   - 启动外部基础设施：`pnpm docker:up`
   - 启动服务端热重载：`pnpm dev:server`
   - 执行单元测试：`pnpm test:server`
