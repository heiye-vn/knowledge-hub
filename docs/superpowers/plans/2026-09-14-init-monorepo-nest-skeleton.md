# 初始化 Monorepo 极简基础骨架与 Nest.js 后端实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建极简、易扩展的 Monorepo 项目基础骨架，前端目录占位，后端基于官方 `@nestjs/cli` 初始化原生 Nest.js 服务，并配置本地开发所需的基础依赖容器编排。

**架构：** 根目录使用 pnpm Workspace 统一管理工作区；`apps/web` 为前端占位；`apps/server` 为原生 Nest.js 单应用（保留官方原始架构，不预建空模块）；`docker/` 提供本地 Postgres (pgvector)、Redis、MinIO、MongoDB 一键编排。

**技术栈：** Node.js v22、pnpm v10、Nest.js 11、TypeScript、Docker Compose (Postgres 16 + pgvector, Redis 7, MinIO, MongoDB 7)。

**规格：** [docs/superpowers/specs/2026-09-14-knowledge-hub-architecture-design.md](file:///e:/Study/AI%20Agent/knowledge-hub/docs/superpowers/specs/2026-09-14-knowledge-hub-architecture-design.md)

## 全局约束

- 严禁过度设计：保持 Nest.js 官方初始结构的极简纯粹，禁止预先建立一堆空的业务目录或未实现的接口。
- 使用官方 `@nestjs/cli` 生成后端代码，避免手动拼凑产生依赖与配置版本不一致。
- 根目录使用 pnpm workspace 协调依赖，避免全局污染与幽灵依赖。
- 所有代码与文档注释使用中文，代码标识符使用英文。

---

### 任务 1：初始化 Monorepo 根配置与前端占位

**文件：**
- 创建：`.gitignore`
- 创建：`pnpm-workspace.yaml`
- 创建：`package.json`
- 创建：`README.md`
- 创建：`apps/web/README.md`

- [ ] **步骤 1：创建 `.gitignore` 规则文件**
配置忽略 `node_modules`、`dist`、`.env*`、`coverage`、`.DS_Store`、日志文件等。

- [ ] **步骤 2：创建 `pnpm-workspace.yaml`**
声明工作区匹配规则：
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **步骤 3：创建根 `package.json`**
配置私有属性与根级运行脚本（如 `dev:server`、`build:server`）。

- [ ] **步骤 4：创建项目根 `README.md` 与 `apps/web/README.md` 前端接入指南**
简要记录项目技术栈与前端接入说明。

- [ ] **步骤 5：验证并 Commit**
```bash
git add .gitignore pnpm-workspace.yaml package.json README.md apps/web/README.md
git commit -m "chore: 初始化 Monorepo 根工作区与前端占位目录"
```

---

### 任务 2：使用官方 Nest CLI 生成原生后端服务

**文件：**
- 创建：`apps/server/`（由 `@nestjs/cli new` 自动生成）
- 修改：`apps/server/package.json`（微调包名为 `@knowledge-hub/server`）

- [ ] **步骤 1：调用官方 Nest CLI 在 `apps/` 下生成 `server` 项目**
```bash
cd apps
pnpm dlx @nestjs/cli new server --package-manager pnpm --skip-git
```

- [ ] **步骤 2：适配 Monorepo 工作区命名**
将 `apps/server/package.json` 中的 `"name": "server"` 修改为 `"name": "@knowledge-hub/server"`。

- [ ] **步骤 3：验证 Nest.js 原生目录结构**
检查 `apps/server/src/` 是否包含 `app.controller.ts`, `app.service.ts`, `app.module.ts`, `main.ts`。

- [ ] **步骤 4：Commit**
```bash
git add apps/server
git commit -m "feat(server): 使用官方 Nest CLI 初始化后端服务骨架"
```

---

### 任务 3：编写本地开发基础依赖容器编排

**文件：**
- 创建：`docker/docker-compose.yml`
- 创建：`docker/postgres/init.sql`

- [ ] **步骤 1：创建 Postgres 初始化脚本 `docker/postgres/init.sql`**
编写自动启用向量扩展语句：`CREATE EXTENSION IF NOT EXISTS vector;`

- [ ] **步骤 2：编写 `docker/docker-compose.yml`**
编排以下服务（均配置好端口与持久卷映射）：
- `postgres` (镜像 `pgvector/pgvector:pg16`, 端口 5432)
- `redis` (镜像 `redis:7-alpine`, 端口 6379)
- `minio` (镜像 `minio/minio:latest`, 端口 9000 & 9001)
- `mongodb` (镜像 `mongo:7.0`, 端口 27017)

- [ ] **步骤 3：验证 Docker Compose 语法有效性**
```bash
docker compose -f docker/docker-compose.yml config
```

- [ ] **步骤 4：Commit**
```bash
git add docker/
git commit -m "chore(docker): 配置本地 Postgres(pgvector)、Redis、MinIO、MongoDB 容器编排"
```

---

### 任务 4：全局依赖安装与端到端运行验证

**文件：**
- 检查修改：`pnpm-lock.yaml`

- [ ] **步骤 1：根目录执行 `pnpm install` 关联工作区**
```bash
pnpm install
```

- [ ] **步骤 2：运行后端默认单元测试**
```bash
pnpm --filter @knowledge-hub/server test
```
预期：测试全部 PASS（`Hello World!` 测试通过）。

- [ ] **步骤 3：在后台启动 Nest.js 开发模式并验证 HTTP 响应**
执行 `pnpm --filter @knowledge-hub/server start:dev`，使用 HTTP 请求测试 `http://localhost:3000`，预期返回 `Hello World!`。

- [ ] **步骤 4：Commit 工作区锁文件**
```bash
git add pnpm-lock.yaml
git commit -m "chore: 更新 pnpm 工作区依赖锁定文件"
```
