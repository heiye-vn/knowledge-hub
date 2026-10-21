# 数据库迁移（TypeORM migrations）

> 代码路径：`apps/server/src/database/`（`typeorm.options.ts` / `entities.ts` / `migrations/` / `migrate.ts`）
> CLI：`pnpm migration:run` / `migration:revert` / `migration:show`

## 一、背景与职责划分

**现象**：表结构变更此前靠手改 `init-scripts/postgresql/01-init.sql`。该脚本只在空数据卷首次启动时执行，
已有卷不会重跑，团队协作时"DBA 改了、别人库里没有"，且无法回溯某个结构是哪次改动引入的。

**决策**：

| 文件 | 定位 |
| :--- | :--- |
| `init-scripts/postgresql/01-init.sql` | 本地空卷引导快照，**已冻结**，只保留历史形态 |
| `database/migrations/` | 唯一的结构演进入口，每次变更新增一个迁移 |
| `database/typeorm.options.ts` | 运行时与 CLI 共用的连接配置（含 `migrationsRun` 开关） |
| `database/entities.ts` | 实体清单单一事实源，避免运行时与 CLI 各写一份 |

## 二、基线迁移的幂等设计【易错】

**现象**：已由 init 脚本初始化的开发库里，直接跑"建全部表"的基线迁移会因为预置数据主键冲突失败，
或者反过来把 `content_id` 之类的历史列 DROP 掉。

**解法**：`Baseline1780000000000.up()` 先查 `to_regclass('public.kh_document')`：

- 表已存在 → 直接 `return`，TypeORM 只把基线登记为已执行（**只登记、不执行**）；
- 空库 → 执行内嵌的完整 DDL + 预置数据（与 init.sql 同源）。

判断必须写在 `up()` 里而不是只在 CLI 里做——手工执行 `migration:run` 同样要幂等。

**验证**：本地已有库上 `migration:show` 显示两个迁移待执行 → `migration:run` 依次 ✓ →
再次 `show` 显示"已执行 2，待执行 0"，数据未被重置。

## 三、部分唯一索引承接 outbox 合并【易错】

`kh_index_outbox` 的唯一索引必须带 `WHERE status IN ('pending','retry')`：
同一文档同一目标允许保留多条 `succeeded` / `dead` 历史，只约束未完成任务。
`IndexOutboxService.record` 的 `ON CONFLICT (document_id, target, operation) WHERE ...`
依赖这条部分索引，写成普通唯一索引会让"失败→成功→再失败"的第二次记录直接冲突。

## 四、为什么不用 typeorm CLI

项目是原生 ESM（`"type": "module"`），typeorm CLI 需要额外的 data-source 文件与 ts-node，
ESM 下易踩 `Cannot use import statement outside a module`。`migrate.ts` 直接复用
`buildTypeOrmOptions()`，编译后由 node 执行，零额外依赖，且能自己实现 `.env` 读取
（CLI 场景没有 ConfigModule）。

## 五、已知局限

- `migration:revert` 会回滚最后一个迁移，生产执行前需人工确认；基线迁移的 `down()` 故意为空（回滚等同删库）。
- 预置数据（演示账号 / 团队）只存在于基线迁移与 init.sql，后续新增种子数据应另开迁移。
- 迁移文件命名 `{timestamp}-{name}.ts`，timestamp 需保持升序；新增后必须在 `migrations/index.ts` 登记。
