# LangFuse 观测与 Agent 评测

> 覆盖范围：`apps/server/src/observability/`、`apps/server/src/ai/eval/`，以及 AI 两条对话链路中的
> trace / snapshot 接线。目标不是只展示一次实验，而是建立可复现、可比较、默认不泄露正文的质量闭环。

---

## 一、关键决策

### 1. 默认不上传对话正文

`LANGFUSE_TRACE_CONTENT` 默认 `false`：

- 自定义 span 丢弃 `input/output`，metadata 只保留指标白名单（意图、检索次数、错误、工具状态等）；
- `userId` 默认 sha256 加盐哈希；
- 采样按用户/会话稳定哈希，同一 trace 不会只留半截。

【实录】最初只给 `withObservation` 做字段脱敏，但 LangChain `CallbackHandler` 会自动采集 prompt、
工具入参和回答，这条路径没有脱敏钩子。仅靠自定义 span 脱敏会形成「看起来安全、实际正文仍出网」的假象。
现策略是：**未显式开启正文采集时不挂自动回调**，只保留业务 span。开启后才创建 CallbackHandler。
代价是默认模式下看不到逐次 LLM token 明细，这是为敏感企业语料主动接受的取舍。

【实录】第二层泄露来自 LangFuse Experiment：SDK 会无条件把 `data.input`、`expectedOutput`
和 task 返回值写到 experiment-item 根 span，与 tracing 的内容开关无关。仅脱敏自定义 span
仍会把回答、检索摘录、联网内容和金标要点上传。现由 `experiment-privacy.ts` 单独构造出网载荷：
默认把问题替换为 `[content-hidden:<id>]`、金标只留 intent、task 输出只留意图/次数/长度；
`LANGFUSE_TRACE_CONTENT=true` 时才传完整数据。评估器回放按用例 id 取本地已算分数，不依赖出网 output。

### 2. 评测必须保留全轮次，而不是末轮快照

`RetrieveLoopResult.attempts` 保存每轮的 query、`rawHits`、`gradedHits` 与 `eval`；流式评测入口
`AgentEvalTrace` 同样逐次记录工具。因此可以同时计算：

- `first_hit_at_5`：检索器首轮能力；
- `final_hit_at_5` / `precision_at_5` / `mrr_at_5`：改写后的最终效果与排序；
- `rewrite_gain`：改写是否真的改善了命中；
- `rewrite_loop`：只认真实改写事件，不能把「直接换词再查」当成改写成功。

【易错】`eval.retried` 只表示第二次检索，不代表调用过 `rewrite_query`；若用它判断改写，会把直接换词误判为改写。

### 3. 工具状态拆成 success / useful

`ToolRun = { success, useful, error? }`：

- `success`：调用没有抛错且供应商未返回错误；
- `useful`：返回了实体/关系或网页结果；
- `tool_policy` 的 `requireGraph/requireWeb` 要求至少一次 success，禁止项则看是否实际调用。

【易错】只记录 `graphUsed: boolean` 会把「调用失败」和「成功检索」混为一谈，指标会虚高。

### 4. 评测执行不读写用户记忆

`AiStreamService.runForEval()` 复用线上 `createTurnAgent()`，但：

- `agent.invoke()`，不走 SSE；
- `silentWriter()` 丢弃所有 data-* 事件；
- 不创建/修改会话，不写短期/长期记忆；
- 不检索长期记忆，避免真实用户画像影响可复现性。

【实录】若复用线上 `streamChat()` 的 `onFinish`，会同时写 `kh_ai_session`、Redis 窗口和 Mem0；
评测多次运行后会污染记忆，也无法保证相同输入得到相同上下文。

### 5. 权限评测不能全用管理员

基础用例使用 `eval-admin` 读取公共制度，避免文档 ACL 把金标测成空召回；
`EVAL_ACL_USER_ID` + `EVAL_ACL_QUESTION` 同时配置时才追加 `acl` suite，以 `ROLE_USER` 和受限团队身份执行。
未配置不会伪造权限结论。受限用例的 `tool_policy` / `false_hit` / `refusal_quality` 为 0 会进入
`criticalFailures`。

### 6. 避免 Judge 双跑，报告可比较

LangFuse experiment 的 evaluator 回放 task 阶段已算好的本地分数，避免同一个 Judge 题目跑两遍。
本地 JSON 报告记录提交、数据集版本、模型/检索参数、逐题分数与指标聚合；`EVAL_BASELINE_REPORT`
存在时输出逐指标差值和逐题 improved/regressed。报告不含回答正文，且 `eval-reports/` 不提交。

---

## 二、在线实验流程

1. 在 `apps/server/.env` 配置 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`；
2. 默认先保持 `LANGFUSE_TRACE_CONTENT=false` 观察链路与错误；
3. 需要分析 prompt / token 时再临时开启正文采集，并确认 LangFuse 部署位置与访问权限；
4. 运行：

```bash
pnpm eval:rag
```

5. 产物：终端分数 + `apps/server/eval-reports/agentic-rag-latest.json` + LangFuse experiment（配置 Key 时）。
6. 与基线比较：

```bash
EVAL_BASELINE_REPORT=eval-reports/agentic-rag-baseline.json pnpm eval:rag
```

### 外部基线数据集

内置 9 条只用于冒烟；正式基线放 JSON，不把大量题目写进 TypeScript：

```bash
EVAL_DATASET_PATH=eval/datasets/knowledge-base-40.json pnpm eval:rag
```

- 路径相对 `apps/server`；
- 文件格式 `{ version, description?, items[] }`；
- 加载时用 zod 校验：意图枚举、未知字段、空问题、重复用例 ID 都会直接失败；
- `version` 自动写入 experiment metadata 和本地报告，`EVAL_DATASET_VERSION` 可覆盖；
- 配置 `EVAL_ACL_*` 时会自动给外部数据集追加 ACL 用例；
- 当前 `eval/datasets/knowledge-base-40.json` 基于本地两篇已发布文档，文档标题变化后需校准。

【易错】评测 CLI 使用 `tsc -p tsconfig.build.json` 编译后由 Node 执行，产物路径为
`dist/ai/eval/run-experiment.js`；没有引入 ts-node，符合项目 native ESM 约定。
`nest build` 会先清空 `dist`，在带批量删除保护的环境里会被拦截，因此脚本显式绕开该删除步骤。

---

## 三、验证与已知局限

已验证：

- `tsc --noEmit` 通过；
- `tsc -p tsconfig.build.json` 后 `node --check dist/ai/eval/run-experiment.js` 通过；
- 数据集加载、评测与观测相关 Vitest **38 用例**通过；
- 服务端全量 **51 个文件 / 416 个用例**通过；
- 新增生产代码 oxlint **0 warning / 0 error**；
- 覆盖默认脱敏、采样、Judge 失败跳过、全轮次保留、评测不写记忆、ACL 用例生成、Experiment input/output 脱敏与报告比较；
- 原有对话、检索、改写测试保持通过。

未验证：本轮未连接真实 LangFuse 项目、真实数据集和 LLM 运行在线 experiment；需要在有 Key 和业务语料
的环境完成一次基线实验，再按实际文档标题调整 golden dataset。

已知局限：

- 基础数据集中的文档标题是通用制度语义子串，换环境后可能出现“不是代码错，而是语料不匹配”；
- 默认关闭正文采集时没有 LangChain 自动 span，token/耗时细粒度分析需要显式开启；业务层已保留
  意图、知识库检索、评估、改写、图谱、联网的 span；
- 流式请求只有属性传播，没有贯穿整个 `writer.merge` 生命周期的 active root span；默认无 callback
  时 trace 可能分散，需在首次实机验收确认后调整 span 生命周期；
- 目前只有离线评测 CLI，没有前端评测后台和 CI 阈值门禁；
- 权限用例依赖外部真实账号配置，默认不跑，不能把管理员结果当权限结论。

## 四、首次基线实录（2026-10-27）

【实录】9 条冒烟集在本地真实语料上跑通（LangFuse 已配置，experiment 上传成功）：

- Agent 行为层全绿：intent 9/9、tool policy 9/9、rewrite 1/1、拒答 2/2、忠实度 5/5、false hit 3/3，
  `criticalFailures` 空；
- 检索类指标全 0 不是检索故障：金标写「差旅 / 信息安全 / 生产环境变更」，库内真实标题是
  `01-travel-expense-policy` / `新员工入职指南（研发中心）`，双向 `includes` 必然匹配不上；
- 逐题 comment 反向定位到数据层：两篇发布文档在 PG 的正文只有 1294 / 1395 字符，ES 4 个块与 PG
  完全一致（**不是索引丢块**）；入职指南缺二、三节，差旅文档没有「加签」条款，`张伟 / 李明 / 王芳`
  均不在库；
- 正文混有 PDF 抽取的康熙部首变体字（⽤ / ⼯ / ⽆），「无需发票」匹配不上「⽆需发票」，会同时污染
  BM25 与 Judge 的关键点判定。

【易错】金标必须来自当前语料原文，不能沿用「合理但不存在的制度」。校准后三条 kb-hit 改为真实条款
（差旅餐饮 100 元/天、VPN 排查 Buddy/hosts），无制度覆盖的灰度题降级为 kb-empty 拒答题。
`loadDotEnv` 已补行内注释剥除：实际运行时 `ConfigModule.forRoot` 会先用 dotenv v16 读过 `.env`，
自定义解析只是兜底，但不剥注释会把 `EVAL_JUDGE_MODEL=   # ...` 读成注释文本。
