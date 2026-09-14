# Knowledge Hub 知识库系统

企业级知识库与智能问答系统，采用 Monorepo 统一架构管理。

## 目录布局

- `apps/server`: 基于 Nest.js 的原生后端 API 服务（知识库管理、文档解析、RAG 向量检索与流式对话）
- `apps/web`: 前端工作台应用（占位中，后续使用 React + Tailwind CSS 构建）
- `packages/`: 共享工具库与类型定义（按需扩展）

## 快速开始

### 1. 依赖安装
```bash
pnpm install
```

### 2. 启动后端开发服务
```bash
pnpm dev:server
```
服务启动后可访问：`http://localhost:3000`

### 3. 本地基础设施容器管理 (PostgreSQL + MongoDB)
```bash
# 后台一键启动所有基础数据库及 Web 管理面板
pnpm docker:up

# 查看容器运行状态
pnpm docker:ps

# 跟踪查看容器日志
pnpm docker:logs

# 停止基础服务
pnpm docker:down
```

- PostgreSQL pgAdmin 管理面板：`http://localhost:8088`（账号：admin@admin.com / admin）
- MongoDB mongo-express 管理面板：`http://localhost:8081`（账号：me_admin / me_123456）

### 4. 运行后端测试
```bash
pnpm test:server
```
