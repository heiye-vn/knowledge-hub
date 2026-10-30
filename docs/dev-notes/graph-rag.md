# Graph RAG：知识图谱进对话（feat-v18）

> **模块覆盖范围**
>
> - `apps/server/src/kg/chat-graph.ts`（+ spec）：分词 / 图谱上下文格式化（纯函数）
> - `apps/server/src/kg/types/kg.types.ts`：`GraphChatHit` 对话命中契约
> - `apps/server/src/kg/graph-build.service.ts`：`retrieveForChat` 三段 Cypher 对话检索（+ e2e）
> - `apps/server/src/ai/chat-query-rewrite.service.ts`：路由新增 `graph_queries` / `allowGraph`
> - `apps/server/src/ai/ai-stream.service.ts`：`retrieve_graph` Agent 工具 + 首次并行调用
> - `apps/server/src/ai/ai-chat.service.ts`：非流式图谱与知识库并行检索
> - `apps/web/src/chat-message-utils.ts`：`graphHitToView` 命中转力导图节点/边
> - `apps/web/src/components/ChatMessageParts.tsx`：GraphCard / GraphToolCard 过程卡
> - `apps/web/src/components/ForceGraph.tsx`：`compact` 模式（对话画布内嵌）

---

## 一、 链路形状（在 v17 Agentic RAG 之上加图谱分支）

```text
classify：意图 + standalone_query + graph_queries（2~4 字短实体名，仅 kb / kb_then_web）
→ 流式：按意图挂 retrieve_graph 工具，模型首次与 retrieve_knowledge 并行调用
   非流式：plan.graphQueries 非空时与知识库检索 Promise.all
→ retrieveForChat 三段查询（同一 session 顺序执行）：
   ① 实体：name/aliases 相等/前缀/后缀匹配（禁 CONTAINS）+ 可见性穿透
   ② 关系：只取本轮命中实体之间的 RELATED_TO
   ③ 来源文档：沿 MENTIONS 回查可见文档
→ 流式：写 data-graph；工具返回 context（只含关系与来源，不含 chunk 正文）
   非流式：图谱文本作为独立 SystemMessage 注入（【本轮知识图谱】）
→ 图谱空命中不触发「知识库里没有相关内容」收口（除非知识库也不足）
```

## 二、 关键决策

### 2.1 实体匹配禁用 CONTAINS，只做相等 / 前缀 / 后缀

- **现象**：如果沿用 `searchGraph` 的 CONTAINS 匹配，用户问「发票报销」，短词「发票」
  会命中整篇《差旅费用报销管理办法》标题类节点，图谱检索退化成全文搜索。
- **原因**：对话检索的关键词是 2~4 字实体名，而实体名 / 文档标题里混着大量长制度名；
  CONTAINS 对短词几乎必然误命中长串。
- **解法**：`retrieveForChat` 实体匹配只做 `name = kw` / 去书名号后 `STARTS WITH` /
  `ENDS WITH`，别名同规则；排序上全名相等 > 前后缀 > 别名命中，同档取更短名字
  （短名更可能是用户口中的实体本体）。《》剥离让「差旅」能前缀命中《差旅管理办法》。
- **如何验证**：`graph-build.e2e.spec.ts` 对话检索用例断言「财务部」能命中实体与来源文档，
  未知实体返回空且无 error；`graph-chat-retrieval.spec.ts` 覆盖 Neo4j 禁用 / 空关键词路径。

### 2.2 三段查询共用一个 session 顺序执行

【易错】Neo4j driver 的 session 非并发安全，把实体/关系/文档三段查询并发共用
同一 session 会丢边。顺序 await 同一 session；每段查询本身就是毫秒级，并发没有收益。

### 2.3 图谱是 Agent 工具，首次必须与知识库并行

- **解法**：`modelKwargs` 显式开 `parallel_tool_calls: true`（百炼默认对带工具调用
  可能不并行），同时 system prompt 写明「首次检索知识库必须与 retrieve_graph
  在同一次并行调用」。`modelCallLimitMiddleware` 从 6 提到 8，为图谱分支的
  「并行检索 × 2 → 评估/改写 → 再检索 → 作答」留空间。
- **原因**：图谱与知识库检索互不依赖，串行等于白等一轮 RTT；且先看图谱能让模型
  在知识库不足时早点决定是否再查其它实体。
- **如何验证**：`ai-stream.service.spec.ts` 断言 kb 意图挂 3 个工具、kb_then_web 挂 4 个；
  system prompt 分支断言并行调用指令存在。

### 2.4 图谱上下文只写关系，不当制度原文

`formatGraphContext` 只输出「关系列表 + 来源文档标题」，明确告知模型
「以上只说明实体之间的关系，不能当制度原文；制度/流程以知识库检索资料为准」。

- **原因**：图谱边是 LLM 抽取的二手结论，可能带噪声；若当作原文引用，
  答案会出现无出处的断言，且引用溯源（`[n]`）完全对不上。
- **如何验证**：`chat-graph.spec.ts` 断言格式化文本含「不能当制度原文」提示；
  `ai-chat.service.spec.ts` 断言图谱文本以独立 SystemMessage（【本轮知识图谱】）注入。

### 2.5 图谱空命中不等于「库里没有」

非流式的「知识库里没有相关内容」收口条件从 `kb 不足` 收紧为
`kb 不足 && 图谱也无实体/关系命中`。

- **原因**：知识库分块检索不足时，图谱可能仍有「财务部 → 负责差旅审批」这类
  有用关系；直接收口会丢掉这半份答案。
- **如何验证**：`ai-chat.service.spec.ts` 两条用例分别覆盖「检索不足但图谱命中 → 正常生成」
  与「双空 → 收口」。

### 2.6 图谱失败可观测，但不阻断回答

- **解法**：`GraphChatHit` 增加 `error` 字段；`retrieveForChat` catch 后返回
  `{...empty, error: message}`。流式工具层再包一层 try/catch 写 `data-graph`；
  非流式 catch 后置 `undefined`（当作没查到）。
- **原因**：图谱是增强通道，Neo4j 抖动不应让整轮对话失败；但不能静默吞错（若仅返回空 hit 无任何标记）会让「无匹配图谱」和「服务异常」无法区分，影响排障与模型判断。
- **如何验证**：`graph-chat-retrieval.spec.ts`、`ai-stream.service.spec.ts`（rejection →
  error/insufficient）、`ai-chat.service.spec.ts`（rejection → 回答不受影响）。

### 2.7 图谱可见性多重安全防线

- **发布状态**：`neo4jDocumentAccessWhere` 统一附加 `status = Published`，避免撤稿 / 归档清理失败时残留节点凭旧可见性字段回流。
- **关系严格溯源**：建图时为每条 `RELATED_TO` 写入 `sourceChunkIds`；`neo4jRelationAccessWhere` 只沿来源块回查所属文档的可见性，不再用「两端实体共现」近似。无来源块的存量边不会返回。
- **如何验证**：`document-access.spec.ts` 断言 Cypher 片段；`graph-build.e2e.spec.ts` 验证真实 Neo4j 下对话检索返回的每条关系都带非空 `sourceChunkIds`，普通用户只能读到公开来源块支撑的关系。
- **升级动作**：部署后必须调用 `POST /kg/build` 全量重建图谱，为存量边补齐来源块；未重建前旧边不会出现在任何图谱查询结果里。

## 三、 实现层的坑

### 3.1 工具入参关键词在服务端才分词【实录】

`retrieve_graph` 工具把 `plan.graphQueries` 与模型入参 `input.query` 简单拼接传入
`retrieveForChat`，**分词发生在 `splitGraphKeywords` 内部**。单测曾错误地期望
`['发票','报销','差旅','住宿']`，实际调用收到的是 `['发票','报销','差旅 / 住宿']`
（`input.query='差旅 / 住宿'` 作为整体字符串传入）。
修正方式：单测按「传参边界」断言，分词正确性由 `chat-graph.spec.ts` 单独覆盖。

### 3.2 ECharts 力导图 layoutAnimation 不能关【易错】

对话画布内嵌图谱用了紧凑布局（更小节点、更大斥力），曾考虑关
`layoutAnimation` 省性能——关掉后新节点会全部叠在原点不散开。
结论：`layoutAnimation: true` 必须保留，性能靠减少节点数（mention 边阈值，见 3.3）。

### 3.3 mention 边爆炸防护【易错】

前端把「文档 → 提及其的实体」合成 mention 边。若 N 篇文档 × M 个实体全连，
一次命中就能画出 N×M 条边（5 文档 × 6 实体 = 30 条）直接糊掉画布。
规则：`docIds.length * entityIds.length <= 16` 才全连；否则每篇文档只连第一个实体。
`graphHitToView` 单测覆盖阈值两侧与悬空边丢弃、节点去重。

### 3.4 data-graph 与 retrieve_graph 工具 part 去重【易错】

流式链路里图谱命中既写 `data-graph`（自定义事件）又出现在 `retrieve_graph` 工具
输出 part。前端若两处都渲染会出现两张一模一样的图卡。规则：存在
`retrieve_graph` 工具 part 时跳过 `data-graph` part（工具 part 自带输入参数，信息更全）。

### 3.5 E2E 测试文件必须走 e2e 配置【实录】

默认 `vitest.config` 的 include 排除 `**/*e2e*.spec.ts`，直接
`vitest run src/kg/graph-build.e2e.spec.ts` 会报 "No test files found"。
必须 `--config ./vitest.config.e2e.ts`（即 `test:e2e` 脚本走的配置），且用例
`skipIf` Neo4j / LLM 不可用。

### 3.6 流式长期记忆检索与意图分类并行【易错】

图谱工具挂载依赖 `plan`，但长期记忆检索不依赖路由结果。流式链路在 `classify` **之前**
用原问题启动 `longMemory.search`，再 `await` 分类结果，两者重叠降低首字延迟；
不能在分类后才发起记忆检索，否则白白多一次串行 RTT。

## 四、 核心架构设计与工程优化

| 关注维度 | 传统/简化实现 | 本系统设计与工程优化 |
| :--- | :--- | :--- |
| 命中类型命名 | 容易与既有图谱搜索契约冲突 | 独立归入 `kg/types/kg.types.ts`，与 `/kg/search` 契约严格隔离 |
| 纯函数归属 | 格式化/分词内联在长文件服务中 | 抽离至 `kg/chat-graph.ts` 独立纯函数并配备单测 |
| 中文标点分词 | 仅按基础空白或斜杠拆分 | 扩展支持全角/半角逗号、顿号、分号（如「发票、报销」） |
| 失败可观测 | catch 后返回空，无任何标记 | `GraphChatHit.error` 显式字段 + 工具/服务两层 catch 兜底 |
| 关系可见性 | 仅校验两端实体各自可见（容易越权穿透） | 建图写入 `sourceChunkIds`，查询严格沿来源块所属文档穿透过滤（`neo4jRelationAccessWhere`） |
| 图谱发布状态 | Cypher 未校验文档发布状态 | 统一约束 `status = Published`，避免下线文档图谱回流 |
| 前端 tooltip | HTML 字符串直接拼接未转义 | `escapeHtml` 严格转义节点名、类型、描述与关系，规避 XSS 风险 |
| 非流式检索编排 | 裸并发 | 统一复用 `RetrievalService` 基座与 `accessFromUser` 安全 scope |

## 五、 验证结果

【实录】2026-10-25 本地验证：

- `typecheck:server` / `typecheck:web` 通过；
- server 单测 43 个文件、369 条全通过（含 chat-graph 9 条、graph-chat-retrieval 2 条、
  路由图谱词 6 条、流式图谱工具 6 条、非流式并行 5 条、可见性 Cypher 片段 3 条）；
- web 单测 4 个文件、30 条全通过（含 graphHitToView 6 条、HTML 转义 1 条）；
- 全量 `oxlint` 0 error / 56 warning（均为拆文件前已存在的 parser / AI 日志风格告警，
  本轮新增代码无新增告警）；
- Neo4j + 真实 LLM 集成用例 `graph-build.e2e.spec.ts` 4 条通过（含真实建图、
  `retrieveForChat` 对话检索、每条关系带非空 `sourceChunkIds`、普通用户严格来源过滤
  与全景查询）。

【易错】浏览器可视化验收未做：与 feat-v17 相同，环境的浏览器自动化策略要求显式授权。
图谱过程卡（pending / 失败 / 空命中 / 命中四态）、力导图紧凑模式与 mention 阈值
目前由类型检查、工具函数单测与 SSE 契约验证覆盖，仍需在浏览器里人工走一遍。

## 六、 已知局限与后续待办

1. **图谱词质量依赖路由模型**：`graph_queries` 只有 2~4 字实体名约束靠提示词保证，
   模型写出整句或泛词（「流程」「如何」已列入禁词）时会检索不到实体。
   观察点：`data-intent` 里的 `graphQueries` 是否常态为短实体名。
2. **图谱只读一轮**：工具设计允许模型改词再调 `retrieve_graph`，但 runLimit 8 与
   提示词（「仅当还要查其他实体名时再调」）共同约束下通常只调一次；多实体追问
   的效果未充分实测。
3. **关系类型仍是属性**：对话检索按命中实体集合查边，`r.relation` 噪声边（如错误的
   「关联」）会原样进上下文，见 kg-graph.md 局限 2。
4. **历史回放看不到图谱卡**：`data-graph` 与工具事件不落库，与 v17 过程卡同一局限。
5. **acceptance 矩阵**：六篇 PDF / 全场景矩阵仍未补齐（语料只有两篇），图谱分支
   追加了「实体关系型问题」一类场景待测。
6. **存量关系缺来源**：升级前的 `RELATED_TO` 没有 `sourceChunkIds`，所有图谱查询都会过滤掉；需执行 `POST /kg/build` 全量重建补齐。重建时同一对实体只保留权重最高的一种关系语义，来源块与该语义同步保留。
