# 文档检索可见性控制（feat-v15）

> **模块覆盖范围**
>
> - `apps/server/src/document/document-access.ts`：可见性规则 SSOT（作用域构造 / 读写判定 / ES 与 Cypher 过滤片段）
> - `apps/server/src/auth`、`user`、`team`：`AuthUser.teamIds` 装配与 `GET /teams/mine`
> - `apps/server/src/document`：列表 SQL 过滤、详情 403、写守卫、可见性变更识别
> - `apps/server/src/rag`、`search`、`kg`、`ai`：三套索引的检索过滤与就地更新
> - `apps/web`：编辑页团队选择、列表 / 搜索 / 详情 / 图谱 / 仪表盘 / 顶栏 / 个人页的可见性展示与权限收敛
>
> **对应参考基线**：`knowledge-hub-backend` / `knowledge-hub-frontend` 分支 `v15`
> **分叉总表**：[docs/reference-mapping.md](../reference-mapping.md) 第三节

---

## 一、 判定规则的收敛方式与取舍

三态可见性（公开 / 团队可见 / 仅自己）在 `document-access.ts` 集中实现，不做散落判定。

- **作者本人无视发布状态**：`canReadDocument` 先判作者再判状态，草稿 / 待审 / 归档的写作者始终可见。顺序写反会让作者自己看不到自己的草稿。
- **管理员 / 审核员 `unrestricted`**：返回 `null` 由调用方「不加过滤」，而不是拼一条恒真条件。恒真条件会被 ES 优化器当成普通 filter 参与，纯属白给开销。
- **非发布文档对他人一律不可见**：只靠 ES 侧的 `doc_status` 兜底不够，PG 侧也要显式判 `status = Published`——两条索引的可见性口径必须一致。

### 【实录】ES 过滤必须挂在 filter 上下文

可见性条件若参与 `must`，会并入 BM25 打分，导致「权限条件影响相关度」。本项目 `runKeywordSearch` 原本就是 `bool.must + filter` 结构，可见性子句直接并入既有 `filterClauses` 即可；**`wrapEsQuery` 只作为无既有过滤架构场景的兼容工具保留，不作为主路径**。

验证：同一查询在打开 / 关闭可见性过滤时，命中集合应缩小但**命中文档内部的相对分数顺序不变**。

---

## 二、 【易错】存量索引的可见性字段必须回填

新增 `is_public` 只影响**之后**写入的数据。存量 `kh_chunk` 数据块与 Neo4j 旧 `KnowledgeDocument` 节点都没有该字段值。

后果：过滤上线后，`term: { is_public: true }` 不命中「字段缺失」的旧数据 → **历史已发布的公开文档被整体误杀**（仅作者与管理员可见），且不报任何错。

解法：`RagOrchestrator.backfillVisibility(docs)` + `graphBuildService.updateVisibility` 一次性回填，启动幂等执行。参考项目未做此步（依赖重新发布），本项目主动补齐。

**如何验证**：回填前后各统计一次「缺 `is_public` 的 chunk 数」，确认归零；再用「非作者且非团队」的普通用户检索一条**历史**已发布公开文档，回填前不可见、回填后可见。

---

## 三、 【易错】Cypher 里实体与关系不能直接判字段

`KnowledgeEntity` 节点上没有 `authorId` / `teamId`，必须沿提及路径反查可见文档：

```
EXISTS { MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e) WHERE <可见性> }
```

关系边要**双端实体**都落在可见文档内。`getStats` 的统计数字同样只计可见范围，否则数字本身构成侧信道泄露。

> ⚠️ `EXISTS { ... }` 子查询需 **Neo4j 5+**；低版本需改用 `size([...]) > 0` 写法。

---

## 四、 【实录】就地更新与重建必须互斥

已发布文档更新时，两条路径同时命中会双写索引：

- 内容变更（免审模式）→ 整篇重建，重建本身已写入最新 `is_public` / `team_id`
- 仅可见性变更 → 轻量就地刷新

正确顺序：**先判内容重建，仅当「内容未变 && 已发布 && 可见性变更」时才就地更新**。

验证：一次「只改公开性」的请求，日志里应只出现 `同步可见性`；一次「改正文 + 改团队」的请求只应出现重建索引日志。

---

## 五、 【易错】scope 缺省是静默 fail-open

`buildFilters` 中 `scope ? esVisibilityFilter(scope) : null`——无 scope 时**不加可见性子句、返回全量数据**（fail-open），而不是报错，与「缺省即收紧」的直觉相反。任何**忘记传 user** 的调用方（未来的 worker / 后台任务 / 脚本）会静默拿到未过滤结果。

排查特征：某条新链路的检索结果「比预期多」（能看到他人私有 / 团队文档）且日志无异常。新增检索调用方必须显式传 `accessFromUser(user)`；确需全量的内部任务应显式构造 `unrestricted` scope，把意图写进代码而不是靠缺省。

---

## 六、 本模块相对参考基线的增强

- **统一 snake_case 单套字段映射**：参考项目因 `kh_chunk`(snake) 与 `kh_document`(camel) 命名不一致而维护两套映射；本项目两索引同为 snake_case，只保留一套
- **`teamIds` 每请求重算**：沿项目既有的权限码即时生效策略，成员变动无需重新登录
- **kg 扩展接口的可见性覆盖**：`stats` / `entities` / `neighbors` 是主项目相对参考的扩展接口，本轮同步补上 scope 过滤

---

## 七、 已知局限与后续待办

- 回填目前为启动幂等执行的一次性逻辑，未做成可重试的管理端点；数据量大时建议改为分页 + 进度记录
- 可见性变更的就地更新失败仅记 warn 日志，缺少自动补偿；可考虑把失败文档投递到重建索引队列
- 团队负责人若不在成员表中，依赖 `kh_team.leader_id` 单独查询，后续若引入「团队继承 / 父团队可见」需一并扩展 `listAccessibleTeamIds`
