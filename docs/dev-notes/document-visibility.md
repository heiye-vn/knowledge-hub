# 文档检索可见性控制（feat-v15）

> **模块覆盖范围**
>
> - `apps/server/src/document/document-access.ts`：可见性规则 SSOT（作用域构造 / 读写判定 / ES 与 Cypher 过滤片段）
> - `apps/server/src/auth`、`user`、`team`：`AuthUser.teamIds` 装配与 `GET /teams/mine`
> - `apps/server/src/document`：列表 SQL 过滤、详情 403、写守卫、可见性变更识别
> - `apps/server/src/rag`、`search`、`kg`、`ai`：三套索引的检索过滤与就地更新
> - `apps/web`：编辑页团队选择、列表 / 搜索 / 详情 / 图谱 / 仪表盘 / 顶栏 / 个人页的可见性展示与权限收敛

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

解法：`RagOrchestrator.backfillVisibility(docs)` + `graphBuildService.updateVisibility` 一次性回填，启动幂等执行。若不做回填则必须依赖全部重新发布，易引发存量断层。

**如何验证**：回填前后各统计一次「缺 `is_public` 的 chunk 数」，确认归零；再用「非作者且非团队」的普通用户检索一条**历史**已发布公开文档，回填前不可见、回填后可见。

---

## 三、 【易错】Cypher 里实体与关系不能直接判字段

实体节点与关系边本身没有 `is_public` / `team_id` 属性。Cypher 过滤必须沿图结构**穿透到来源文档**：

```cypher
MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(c:KnowledgeChunk)-[:MENTIONS]->(e:KnowledgeEntity)
WHERE (d.is_public = true OR d.author_id = $userId OR d.team_id IN $teamIds)
  AND d.status = 'Published'
RETURN e
```

- **三段检索均需带此条件**：实体搜索、邻居展开、图统计；
- 漏掉 `d.status = Published` 会导致已下架/归档的文档残留节点仍被查出；
- 性能影响：多一次跳跃，但实体已有索引，百万以下规模无感知。

---

## 四、 【实录】就地更新 vs 重建索引的互斥

可见性变更是轻量更新（只改 `is_public` / `team_id`），调用 `updateVisibility` 只需就地更新元数据：
- ES：`updateByQuery` 批量更新 `kh_chunk` 与 `kh_document`；
- Neo4j：`MATCH (d:KnowledgeDocument {id: $id}) SET d.is_public = ..., d.team_id = ...`。

切忌走全量重建（重新切块、Embedding、LLM 抽取实体），否则改个可见性会消耗数十秒时间并浪费模型 Token。

---

## 五、 【易错】无 scope 时的 fail-open 风险

`buildFilters` 中 `scope ? esVisibilityFilter(scope) : null`——无 scope 时**不加可见性子句、返回全量数据**（fail-open），而不是报错，与「缺省即收紧」的直觉相反。任何**忘记传 user** 的调用方（未来的 worker / 后台任务 / 脚本）会静默拿到未过滤结果。

排查特征：某条新链路的检索结果「比预期多」（能看到他人私有 / 团队文档）且日志无异常。新增检索调用方必须显式传 `accessFromUser(user)`；确需全量的内部任务应显式构造 `unrestricted` scope，把意图写进代码而不是靠缺省。

---

## 六、 架构设计与工程增强

- **统一 snake_case 单套字段映射**：两套索引同为 snake_case 规范命名，避免多套映射带来的维护成本
- **`teamIds` 每请求重算**：沿项目既有的权限码即时生效策略，成员变动无需重新登录
- **kg 扩展接口的可见性覆盖**：`stats` / `entities` / `neighbors` 等接口均统一接入 scope 过滤
- **关系级可见性强化**：`RELATED_TO` 写入 `sourceChunkIds`，查询严格沿来源块回查文档可见性，不再只校验两端实体各自可见
- **图谱发布状态兜底**：Cypher 文档过滤统一附加 `status = Published`，与 ES / PG 口径一致

---

## 七、 已知局限与后续待办

- 回填目前为启动幂等执行的一次性逻辑，未做成可重试的管理端点；数据量大时建议改为分页 + 进度记录
- 可见性变更的就地更新失败仅记 warn 日志，缺少自动补偿；可考虑把失败文档投递到重建索引队列
- 团队负责人若不在成员表中，依赖 `kh_team.leader_id` 单独查询，后续若引入「团队继承 / 父团队可见」需一并扩展 `listAccessibleTeamIds`
- 关系已记录 `sourceChunkIds` 并严格过滤，但存量边在升级前没有来源；上线后必须执行一次全量图谱重建（`POST /kg/build`）补齐，否则旧边不会返回
