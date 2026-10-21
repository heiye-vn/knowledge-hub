# Knowledge Hub 知识库与智能问答系统

面向企业知识管理场景的 RAG 知识库系统：支持多格式文档解析、审核发布、混合检索、知识图谱与流式 AI 问答，前后端一体化交付。

- **后端**：NestJS 12 + TypeScript（原生 ESM）
- **前端**：React 19 + Ant Design 6 + Vite 8
- **检索**：Elasticsearch 8.17（IK 中文分词 + kNN 向量）
- **数据**：PostgreSQL 16 / Redis + BullMQ / Neo4j
- **AI**：LangChain + OpenAI 兼容接口（Embedding / Chat / Rerank / VLM）

## 功能一览

| 模块 | 能力 |
| :--- | :--- |
| 文档摄取 | PDF、Word、PPT、Excel、TXT、Markdown 解析；图片文档通过 VLM 多模态识别；原文件写入阿里云 OSS 或本地 RustFS |
| 文档管理 | 创建、编辑、分页与模糊搜索、详情查看、软删除；元数据与正文分离存储 |
| 审核流转 | 草稿 → 待审核 → 已发布 → 归档；审核流水、待审数量、并发提审防重 |
| RAG 检索 | 文档分块、Embedding、块级索引 `kh_chunk` 与文档级索引 `kh_document`；kNN + IK 中文 BM25 双路召回、RRF 融合、Rerank 精排、引用溯源 |
| AI 问答 | SSE 流式输出、多轮查询改写、短期/长期记忆、知识库检索 + `web_search` 工具、`[n]` 引用定位 |
| 知识图谱 | LLM 结构化抽取实体关系、Neo4j 建图、实体检索、邻居查询、图谱全景可视化 |
| 权限与组织 | JWT 双令牌、RBAC 权限码、团队组织架构；公开/团队/作者三级文档可见性 |
| 账号体系 | 邮箱激活、密码重置、未激活账号清理、登出吊销 |
| 异步任务 | BullMQ 批量重建索引与 KG 建图，支持重试、退避、任务状态查询 |

## 功能截图

> 截图整理中，以下界面将陆续补充：

| 界面 | 说明 | 预览 |
| :--- | :--- | :--- |
| 文档工作台 | 文档列表、上传与审核状态 | 待补充 |
| 检索结果 | 混合检索结果与命中高亮 | 待补充 |
| AI 问答 | 流式回答、检索过程与引用溯源 | 待补充 |
| 知识图谱 | 实体关系与全景视图 | 待补充 |

<!-- 截图就绪后，将图片放到 docs/assets/screenshots/ 下，替换为：
![AI 问答](docs/assets/screenshots/chat.png)
-->

## 架构

```mermaid
flowchart LR
  Web["React 19 + Ant Design<br/>文档 / 检索 / 问答 / 图谱"] -->|REST + SSE| API["NestJS 12 API"]
  API --> PG[("PostgreSQL 16<br/>元数据 + 正文")]
  API --> ES[("Elasticsearch<br/>kh_chunk + kh_document")]
  API --> Redis[("Redis + BullMQ<br/>异步任务")]
  API --> Neo4j[("Neo4j<br/>知识图谱")]
  API --> Storage[("OSS / RustFS<br/>原文件")]
  API --> LLM["OpenAI 兼容接口<br/>Embedding · Chat · Rerank · VLM"]
  Redis --> Worker["Index / KG Worker"]
  Worker --> ES
  Worker --> Neo4j
```

### 核心链路

1. **文档入库**：上传 → 多格式解析 → 原文件写对象存储 → PostgreSQL 单事务写入元数据与正文。
2. **发布索引**：发布 → 分块 → Embedding → 写入 `kh_chunk`；同步更新 `kh_document` 搜索索引；KG 抽取任务进入 BullMQ。
3. **检索召回**：可见性过滤 → kNN + BM25 双路召回 → 应用层 RRF 融合 → Rerank 精排 → 回查 PostgreSQL 过滤已失效文档。
4. **问答生成**：查询改写 → 知识库检索 → Agent 生成 → SSE 流式返回 → 前端渲染引用卡片与原文定位。

## 技术栈

| 层次 | 技术 |
| :--- | :--- |
| 前端 | React 19、Ant Design 6、React Router 7、Vite 8、AI SDK、ECharts |
| 后端 | NestJS 12、TypeScript、原生 ESM、TypeORM、Vitest、Oxlint |
| 关系库 | PostgreSQL 16 + pgvector；`kh_document` 元数据 + `kh_document_content` 正文（1:1） |
| 检索 | Elasticsearch 8.17、IK 中文分词、dense_vector、BM25、RRF、Rerank |
| 异步 | Redis 7 + BullMQ（`rag.reindex`、`kg.graph` 两个队列） |
| 图谱 | Neo4j：Document → Chunk → Entity → RELATED_TO |
| 对象存储 | 阿里云 OSS / 本地 RustFS（S3 兼容），统一 StorageDriver 接口 |
| 大模型 | LangChain、OpenAI 兼容协议、Mem0 长期记忆 |
| 本地设施 | Docker Compose：PostgreSQL、Elasticsearch、Kibana、Redis、RustFS、Neo4j、MailHog |

## 快速开始

### 环境要求

- Node.js 20+（开发环境使用 24）
- pnpm 10+
- Docker Desktop

### 启动步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 准备应用配置（应用读取 apps/server/.env，不是根目录 .env）
cp apps/server/.env.example apps/server/.env

# 3. 启动本地基础设施
pnpm docker:up

# 4. 启动后端（watch 模式）
pnpm dev:server

# 5. 另开终端启动前端
pnpm dev:web
```

### 访问地址

| 服务 | 地址 |
| :--- | :--- |
| 前端工作台 | http://localhost:5173 |
| 后端 API | http://localhost:3000 |
| 健康检查 | http://localhost:3000/health |
| pgAdmin | http://localhost:8088（admin@admin.com / admin） |
| Kibana | http://localhost:5601 |
| Neo4j Browser | http://localhost:7474（neo4j / 12345678） |
| MailHog | http://localhost:8025 |
| RustFS Console | http://localhost:9001（rustfsadmin / rustfsadmin） |

### 配置说明

- 应用配置统一放在 `apps/server/.env`，参考 [`apps/server/.env.example`](apps/server/.env.example)。
- 根目录 `.env` 只供 `docker-compose` 使用（当前仅配置数据卷路径），应用不会读取。
- 未配置 `EMBEDDING_API_KEY` / `LLM_API_KEY` 时应用仍可启动，但 RAG 与 AI 问答会降级。
- 本地开发默认 `DOCUMENT_REQUIRE_APPROVAL=true`（需审核）与 `REQUIRE_EMAIL_VERIFICATION=false`（注册即启用），可按需调整。
- PostgreSQL 初始化脚本只在空数据卷时执行；已有数据卷不会重复建表，调整表结构需使用迁移或重建开发库。
- 资源紧张时可只启动必要服务：

```bash
docker compose up -d postgres es redis rustfs neo4j mailhog
```

## 目录结构

```text
knowledge-hub/
├── apps/
│   ├── server/src/
│   │   ├── ai/          # AI 问答、流式输出、短期/长期记忆、查询改写
│   │   ├── auth/        # JWT 双令牌、激活、重置密码、守卫
│   │   ├── document/    # 文档 CRUD、审核流转、多格式解析、可见性
│   │   ├── kg/          # LLM 实体关系抽取、Neo4j 建图与查询
│   │   ├── mq/          # BullMQ 队列、任务状态
│   │   ├── rag/         # 分块、Embedding、混合检索、Rerank
│   │   ├── search/      # 文档级 ES 搜索索引
│   │   ├── storage/     # OSS / RustFS 双存储驱动
│   │   ├── team/        # 团队组织架构
│   │   └── user/        # 用户、角色、权限
│   └── web/src/
│       ├── pages/       # 工作台、文档、搜索、问答、图谱、管理后台
│       ├── components/  # 引用卡片、流式消息、文件图标、图谱
│       └── api/         # 接口封装与鉴权刷新
├── docs/
│   ├── dev-notes/       # 各模块实现笔记与踩坑记录
│   └── apifox/          # Postman Collection v2.1 接口集合
├── init-scripts/postgresql/01-init.sql
├── docker-compose.yml
└── package.json
```

## 工程实践

- **单 PostgreSQL 事务**：元数据与正文同库写入，避免跨库双写补偿；正文独立成表，列表查询不拖出大字段。
- **混合检索**：ES 免费版不支持原生 RRF，改为应用层双路召回后融合，同时保留原始分数便于调优。
- **一致性兜底**：ES 与 PostgreSQL 无法共享事务，检索后回查文档存活状态，删除/下架同步清理索引。
- **跨存储权限**：公开/团队/作者可见性规则收敛为单一事实源，同时作用于 PostgreSQL、两套 ES 索引和 Neo4j，并提供存量索引回填。
- **异步与降级**：KG 抽取与批量重建走 BullMQ，配置重试与指数退避；ES、Redis、Neo4j、SMTP 缺失时不阻断应用启动。
- **测试与文档**：33 个 Vitest 测试文件；20 篇开发笔记记录关键决策、易错点与验证方式。

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev:server` | 启动后端开发服务 |
| `pnpm dev:web` | 启动前端开发服务 |
| `pnpm build:server` | 构建后端 |
| `pnpm build:web` | 构建前端 |
| `pnpm test:server` | 运行后端单元测试 |
| `pnpm --filter @knowledge-hub/server test:e2e` | 运行 E2E 测试（需基础设施） |
| `pnpm typecheck:server` | 后端类型检查 |
| `pnpm typecheck:web` | 前端类型检查 |
| `pnpm --filter @knowledge-hub/server lint` | 后端代码规范检查 |
| `pnpm docker:up` / `docker:down` / `docker:ps` / `docker:logs` | 本地基础设施管理 |

