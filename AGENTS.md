# AGENTS.md - Knowledge Hub 智能助手专有开发指南

本文件是针对 AI 编码助手的行为准则与项目专有架构规则。进入本项目工作前必须严格遵守。

---

## 一、 快速命令索引

在根目录下执行所有统一任务，严禁私自在子目录执行未约定的脚本：

```bash
# 启动本地开发依赖环境（PostgreSQL、MongoDB 等）
pnpm docker:up

# 启动服务端开发环境（带热重载 watch 模式）
pnpm dev:server

# 构建服务端
pnpm build:server

# 运行单元测试
pnpm test:server

# 运行服务端 E2E 端到端测试
pnpm --filter @knowledge-hub/server test:e2e

# 运行代码规范检查
pnpm --filter @knowledge-hub/server lint
```

---

## 二、 架构与编码铁律

### 2.1 双存储隔离规范（PostgreSQL + MongoDB）
- **元数据**：必须放入 PostgreSQL（`kh_document` 表及相关关系表）。
- **超长大文本正文**：必须放入 MongoDB（`document_content` 集合）。
- **数据一致性保证**：新增业务实体时，若涉及跨库写入，必须编写异常补偿逻辑（如 Postgres 写入失败时，补偿物理删除刚写入的 Mongo 记录）。

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

---

## 三、 Git 提交规范

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
