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
每个模块文件记录：遇到的疑难问题、关键决策与取舍、易错点、相对参考项目的改进，以及已知局限。

- 一个模块一个文件，**按模块划分，不要按子步骤拆得过碎**。
- 每条尽量写全：**现象 → 原因 → 解法 → 如何验证**。缺了「如何验证」价值大打折扣。
- **必须标注来源**：【实录】（实际遇到，附真实报错与验证数据）／【易错】（提炼的风险点）。
  不要把推测写成既成事实。
- 文件开头写清模块范围与对应代码路径，结尾写已知局限与后续待办。

### 4.3 与参考项目的差异
涉及与 `knowledge-hub-backend` 的差异，同时在 `docs/reference-mapping.md` 分叉表登记一行；
`dev-notes` 放更细的技术细节，两者互补，不要只写一处。

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

---

## 六、 分支迭代与参考项目对齐流程

**这是本项目的核心开发模式**：主项目的每个迭代分支，与参考项目 `knowledge-hub-backend`
的**同名分支**做功能对比；参考项目该分支已实现、而主项目尚未实现的功能，
即为本轮迭代要补齐的内容（例：主项目 `feat-v3` ↔ 参考项目 `v3`）。

- **对比产出登记**：
  - 模块映射 / 有意分叉 / 参考项目缺陷 → `docs/reference-mapping.md`（每次偏离追加一行）
  - 实现过程踩的坑 → `docs/dev-notes/<模块>.md`（完成一个模块记一个）
- **对比层次**：模式层照搬 / 实现层可换但必须登记 / 缺陷层必须改。
  判断方法与实例见 `docs/dev-notes/reference-project-alignment.md`。
- **遗漏也算偏差**：对照时若发现主项目**无意间**漏掉了参考项目已有的行为
  （如校验、守卫），按参考项目补齐并在 `reference-mapping.md` 标注「此前属无意偏离」。
  未登记的分叉无法区分是有意演进还是无意漂移。
- **先衡量再动手**：补齐时若涉及「引入新组件」或「改变接口语义」，
  先用真实数据实测再决定，不要凭感觉上方案。

**前端参考项目的定位**：`knowledge-hub-frontend` 对接的是参考后端（父代），
主项目 server 是其扩展演进版（子代），两边契约对不上是必然的。
后续开发前端 **接口契约以主项目 server 为准**，前端参考项目只作 UI / 交互 / 组件结构参考。
