# 待实现项（Pending Improvements）

记录已识别、暂缓实现的设计缺口。每项包含背景、候选方案与触发条件，业务涉及时再扩展。

---

## 1. 文档与源文件的关联缺失

> 记录时间：2026-09-17
> **状态：✅ 已解决（2026-09-19）**

**解决方案**：采用原「方案 A + object_key 兼容」的组合——`kh_document` 新增 5 个可空列
`file_url / object_key / file_name / file_size / file_extension`，
上传链路（`DocumentService.uploadAndCreateDocument`）经内部参数 `DocumentFileInfo` 写入。
`RustfsService.uploadBytes` 改为返回 `{ url, key }` 以取得 object_key。

> 以下为原始记录，保留作决策背景。

### 现状

`POST /documents/upload-parse`（`DocumentService.uploadAndCreateDocument`）解析文件后，
`fileUrl / fileSize / fileExtension` **只拼进了上传接口的响应体，未持久化**：

- `CreateDocumentDto` 与 `DocumentEntity`（`kh_document`）均无文件相关字段；
- 因此 `GET /documents`（列表）与 `GET /documents/:id`（详情）无法返回文件的任何信息；
- 已上传文件的对象地址只存在于"上传那一刻的响应"里，无法程序化反查。

### 影响评估（保持现状的风险）

- 功能主链路（上传 → 解析 → 双库落库）不受影响；
- 损失点：① 列表/详情无法展示文件图标、大小、原文下载入口；② 文档删除后无法反查
  RustFS 中的对象，将来清理孤儿文件只能人工到控制台按 key 查找。

### 候选方案

**方案 A：`kh_document` 加列（轻量，推荐先做）**

- 新增可空列：`file_url`、`file_name`、`file_size`、`file_extension`；
- 同步修改 `CreateDocumentDto` / `UploadParseDto` 链路，上传时写入；
- 列表、详情零额外查询即可带出文件信息。

**方案 B：独立附件表 `kh_document_file`（1:N，一步到位）**

- 雪花 ID 主键，字段含 object_key / file_url / file_name / file_size / file_extension / 类型（原文件、抽图等）；
- 天然支持一个文档多个附件（原文件 + PDF 抽图页面图）；
- 列表展示需 join 或二次查询，改动面较大（实体 + DTO + service + 建表 SQL）。

### 触发条件（满足其一再实施）

- 前端列表/详情需要展示文件信息或提供原文下载；
- 启动「PDF 抽图」功能（届时直接上方案 B，不必先做 A）；
- 需要文档删除时联动清理 RustFS 对象。

---

## 2. fileUrl 的存储形态依赖访问策略决策

> 记录时间：2026-09-17
> **状态：⏳ 待决策（2026-09-19 更新：表结构已兼容两种方案，仅剩策略选择）**

**进展**：第 1 项落地后，`file_url`（直链）与 `object_key`（对象 Key）**两列都已存在**，
即「方案 A 存直链」与「方案 B 存 key + 动态签名」两种模式在存储层都已支持，无需再改表。
剩下的只是运行时策略选择：**本地开发配匿名只读即可直访；上线前切预签名，读 `object_key` 动态签名。**
在此之前，`fileUrl` 字段已写入库但浏览器直开仍会返回 AccessDenied（bucket 私有）。

> 以下为原始记录，保留作决策背景。

### 现状

`RustfsService.uploadBytes` 返回 `{RUSTFS_PUBLIC_URL}/{bucket}/{key}` 形式的直链，
但 bucket 为私有（`ensureBucket` 仅创建、未设匿名策略），浏览器直接打开返回
S3 风格 XML 错误 `AccessDenied`。该问题与上面第 1 项联动：**决定"存什么"之前，
先要决定"URL 以什么方式可访问"**。

### 候选方案

**方案 A：bucket 匿名只读（download 策略）**

- 允许匿名 `s3:GetObject`，上传/删除仍需签名；
- 落地二选一：RustFS 控制台（localhost:9001）手动配置，或 `ensureBucket()`
  创建成功后追加 `PutBucketPolicyCommand`（代码固化，环境可复现）；
- 库里存完整 `file_url` 直链即可；
- 适用：本地开发 / 内容公开场景。

**方案 B：bucket 保持私有，返回预签名 URL**

- `getSignedUrl(client, new GetObjectCommand(...), { expiresIn })`，URL 带签名、到期失效；
- **库里必须存对象 key（如 `documents/2026/09/17/xxx.pdf`），不能存签名 URL**，
  每次需要时动态签名；
- 适用：生产 / 私有知识库，与"文档删除联动清理对象"配合最好。

### 决策原则

- 本地开发先跑通：控制台手动配匿名只读（零代码）；
- 一旦面向真实用户/上线：切方案 B，并同步实施第 1 项时按"存 key"设计字段
  （方案 A 的 `file_url` 列可保留，另加 `object_key` 列兼容两种模式）。

---

## 3. RAG 阶段一遗留项

> 记录时间：2026-09-19（阶段一实现完成时）

阶段一（同步管线 + 混合检索）已打通，以下为**明确推迟**的事项，触发条件达成时再实施。

| 项 | 说明 | 触发条件 |
| :--- | :--- | :--- |
| **Embedding Key 待配置** | `.env` 中 `EMBEDDING_API_KEY` 为空，混合/向量检索当前会降级返回空 | 拿到阿里云百炼 Key 后填入即可生效，无需改代码 |
| **换模型后需全量重索引** | 切换 `EMBEDDING_MODEL` 后，旧向量与新查询不在同一向量空间，检索结果无意义 | 每次换模型（含 2026-09-19 的 v3→qwen3.7-flash）后，重跑全部已发布文档索引；阶段二可做批量重建任务 |
| **`RAG_MIN_SCORE` 需按真实语料重校准** | 0.72 由 3 篇文档的实测得出，样本极小；相关(0.7478~0.8050)与不相关(0.6519~0.7081)区间接近 | 用真实语料重测分布后再定；换 embedding 模型必须重测 |
| **向量召回质量待提升** | 口语化查询（如「东西误删了还能找回来吗」）相似度仅 0.62 且召回错文档；BM25 侧无阈值，偶然词项匹配仍会召回 | 阶段三引入 Rerank 模型做精排，或用 LLM 改写查询；必要时加 `RAG_MIN_KEYWORD_SCORE` |
| **异步化（阶段二）** | `publish` 目前同步跑管线，长文档会阻塞请求数秒～数十秒 | 实测发布耗时不可接受，或出现批量重建需求时引入 BullMQ |
| **失败重试** | 阶段一索引失败直接上抛，客户端需自行重试（管线幂等，重试安全） | 随异步化一起做重试退避 |
| **Kibana 验证** | 容器已编排但未启动验证 | 需要做检索效果调优/DSL 调试时启动 |
| **分块效果调优** | `ik_max_word` 索引期膨胀率、1024 字符块大小均为初始经验值 | 用真实语料实测召回质量后调整 |
| **父子分块** | 当前为平面 overlapping-window，命中精确但上下文不足 | 实测发现上下文不足时加 `parent_id`，成本很低 |
| **鉴权过滤** | 检索不区分可见性，仅按 `doc_status=1` 过滤 | 随 RBAC 一起做，纳入 `team_id` / 可见性 |
| **超长单段切分单测** | 单测未覆盖「无分隔符的超长段落」降级路径 | 补测试时顺手加 |

---

## 4. RAG 已识别的环境约束（非缺口，但需知晓）

- **ES 免费版不支持 RRF**：原生 `retriever.rrf` 抛 `security_exception`，已改为应用层 RRF（见 `RetrievalService` 注释）。
- **`dims: 1024` 不可原地修改**：换 embedding 维度必须删索引重建 + 全量重索引。
- **IK 与 ES 版本强绑定**：当前 8.17.0 ↔ 8.17.0，由 `elasticsearch/Dockerfile` 固化。
- **ES 客户端 8.19.2 / 服务端 8.17.0**：实测兼容（ES 保证 8.x 内互通），如需严格对齐需同步升级镜像与 IK。
- **Embedding 模型为 `qwen3.7-text-embedding-flash`**（1024 维 / 单批 ≤20 / 128K 上下文 / 0.125 元每百万 tokens）。
  原定 `text-embedding-v3` 因账号无额度弃用。**换任何模型都必须全量重索引**，维度相同也不例外。
