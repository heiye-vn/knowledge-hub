# RBAC 权限系统与团队模块（feat-v9）

> **模块范围**
> 权限三表（`kh_permission` / `kh_role_permission` / `kh_user_permission`）的 CRUD 与绑定、
> 第三层全局守卫 `PermissionsGuard` + `@RequirePermission()`、
> 独立团队组织架构模块（`kh_team` / `kh_team_member`）。
>
> **对应代码路径**
> `apps/server/src/user/permission.service.ts`、`user/permission.controller.ts`、
> `user/dto/permission.dto.ts`、`user/entities/permission|role-permission|user-permission.entity.ts`、
> `auth/permissions.guard.ts`、`auth/decorators/require-permission.decorator.ts`、
> `common/constants/permissions.ts`、`team/**`、`init-scripts/postgresql/01-init.sql`

---

## 一、 三层 Guard 流水线的落点

`JwtAuthGuard → RolesGuard → PermissionsGuard`，均在 `AuthModule` 用 `APP_GUARD` 注册，
按数组顺序执行、任一失败短路拦截（401 / 403 / 403）。

**关键取舍：权限码校验要真正生效，就不能再叠 `@Roles`。**

参考项目 v9 给权限、角色、团队三个 controller 都同时标了 `@Roles(ADMIN)` 和
`@RequirePermission(...)`——RolesGuard 先执行，非管理员在角色层就被 403，
**权限码比对分支永远走不到**，等于花力气建了细粒度模型、实际还在做粗粒度角色判断。
更糟的是这会堵死「给非管理员直接授权 `system:xxx`」这条扩展路径（参考项目自己强调
「支持用户直接赋权」，实现上却让它对接口鉴权完全无效）。

本项目做法：**系统管理类接口只用权限码**（`@RequirePermission('system:user' / 'system:role' /
'system:permission' / 'system:team')`），`@Roles` 只留在角色语义明确的场景
（文档审核工作台仍用 `@Roles(ROLE_REVIEWER, ROLE_ADMIN)`）。
管理员由 `PermissionsGuard` 的 `ADMIN_ROLES` 短路保证访问，库里不必给管理员逐条绑定权限。

如何验证：把某个非管理员账号直接绑上 `system:user` 权限（`PUT /users/:id/permissions`），
用它调 `GET /users/page` 应当 200——参考项目同样操作会返回 403。

---

## 二、 【实录】`@Public` 与类级角色声明冲突，公开接口返回 403

**现象**：团队树想做成免登录公开接口，标了 `@Public()` 却仍 403。

**原因**：`@Public()` 让 `JwtAuthGuard` 直接 return true、**不挂 `request.user`**；
随后 `RolesGuard` 用 `getAllAndOverride([handler, class])` 仍能从类上取到
`@Roles(ADMIN)` 声明，此时 `user` 为 `undefined` → `!user?.roles?.length` → 抛 403。
（参考项目 v9 的 `TeamController` 正是这个组合，`curl-rbac.md` 里写的
「团队树公开无需登录」实际跑不通。）

**解法**：团队 controller 类上不标任何角色声明，`tree` 只标 `@Public()`；
管理接口各自标 `@RequirePermission('system:team')`。
`PermissionsGuard` 同样按「未标注即放行」处理，公开接口不带权限码声明即可正常返回。

**如何验证**：不带 `Authorization` 头直接 `GET /teams/tree`，应返回团队树而非 403。

---

## 三、 【易错】多权限码是「或」不是「且」

`@RequirePermission('a', 'b')` 命中其一即放行（与 `@Roles` 语义一致），
实现是 `required.some((p) => owned.has(p))`。

注意课程讲义 58 的 mermaid 图写的是「包含全部所需权限码」——**与参考项目代码实现不一致**
（参考项目用的是 `.some()`）。当前所有接口都只传单个权限码，二者无差异；
将来出现多码场景时必须明确选一种，别默认。

---

## 四、 【实录】权限绑定必须事务化

**现象**：整体替换绑定 = 「先 delete 全部，再逐条 insert」。参考项目无事务，
中途抛错会留下「旧绑定已清空、新绑定没补完」的中间态——用户权限被静默清零。

**解法**：`assignRolePermissions` / `assignUserPermissions` 包进 `em.transaction`，
且**先校验后写入**：`validatePermissionIds` 在事务外先确认所有权限 ID 存在且启用，
不通过则直接 404、一行都不写。团队删除（软删团队 + 清成员，两表写）同样事务化。

**如何验证**：构造一个「一半 ID 合法、一半不存在」的请求，应返回 404，
且该角色原有绑定保持不变（查 `GET /roles/:id/permissions` 仍是旧值）。

---

## 五、 【实录】权限 ID 校验的重复元素陷阱

参考项目用 `found.length !== ids.length` 判断「是否所有 ID 都有效」。
若入参含重复 ID（前端勾选重复、或重试叠加），`In(ids)` 查询去重后返回条数变少，
**明明都是合法权限却被误判成 404**。

解法：先 `[...new Set(ids)]` 去重再比对，插入时也用去重后的列表（UNIQUE 约束本就拦重复）。

---

## 五之二、 【实录】登录链路的重复角色查询

**现象**：`buildAuthUser` 每请求 5 条 SQL，其中一条是纯重复。

```
findByIdOrThrow                                  → 1
getRoleCodes(userId)                             → 1  ← A
getUserPermissionCodes(userId)
  ├ direct   (user_perm ⋈ perm)                  → 1
  ├ viaRole  (user_role ⋈ role_perm ⋈ perm)      → 1
  └ roleCodes (user_role ⋈ role)                 → 1  ← B（与 A 是同一条 SQL）
```

**原因**：权限服务判断「是否管理员」需要角色编码，`UserService` 组装 `AuthUser.roles`
也需要它，两边各查了一次，SQL 完全相同。

**解法**：`getUserPermissionCodes(userId, knownRoleCodes?)` 增加可选入参，
`buildAuthUser` / `validateCredentials` 把已查到的 roles 传进去。
不传时仍自行查询，保证服务可独立调用（单测与管理接口不受影响）。

**如何验证**：`permission.service.spec.ts` 断言传入角色时
`userRoleRepo.createQueryBuilder` 只被调 1 次，不传时 2 次。

---

## 五之三、 【易错】树构造的 O(n²)

`permission.getTree` / `team.getTree` 初版是每层 `items.filter(p => p.parentId === id)`，
n 个节点每个都扫一遍全量 → O(n²)。改为**先按 parent_id 分组（Map）再递归**，整体 O(n)：

```ts
const byParent = new Map<string, PermissionEntity[]>();
for (const p of perms) { /* 按 parentId 入桶 */ }
const build = (parentId: string) => (byParent.get(parentId) ?? []).map(...)
```

组内顺序依赖查询的 `ORDER BY sort, created_at`，Map 保持插入顺序，展示顺序不变。
权限/团队都是几十到几百条的规模，收益不在绝对耗时而在**别把 O(n²) 写进习惯**。

---

## 五之四、 通配符与保留权限码

管理员的 `permissions` 里会注入 `'*'`（`PERMISSION_WILDCARD`），
前端见此码即全放行——动态新建的菜单/按钮不必回头补 `ADMIN_OPERATION_PERMISSIONS` 常量池。

**后端不受影响**：`PermissionsGuard` 比对的是接口声明的具体权限码，
`'*'` 与 `'system:user'` 不相等，拿到通配符也换不来任何接口放行。

【易错】因此 `'*'` **不能**被业务权限占用：若允许新建 `code='*'` 的权限并赋给普通用户，
后端鉴权虽然拦得住，但前端全放行语义会被误用。
`create` / `update` 均调用 `assertNotReserved()` 拒绝保留码
（`RESERVED_PERMISSION_CODES`），非法编码返回 400。

**配套约定**：前端 `hasPermission()` 必须识别 `'*'`，否则通配符形同虚设、
动态新建的权限管理员仍然看不见（问题回归）。

---

## 六、 权限码的合并与生效时机

`getUserPermissionCodes(userId)` = 直接赋权 ∪ 角色间接权限，管理员再并入
`ADMIN_OPERATION_PERMISSIONS` 常量。只并入 `status=1` 且未删除的权限——
**禁用一个权限即全局收权，不需要逐个解绑角色/用户**。

合并发生在 `UserService.buildAuthUser()` / `validateCredentials()`，
而 `JwtStrategy.validate()` 每请求都调 `buildAuthUser`，因此
**管理端改完权限，下一次请求即生效**，不等 token 过期。
代价是每请求多 2~3 条 SQL（当前量级可接受；真到高并发再按 userId 加短 TTL 缓存）。

常量 `ADMIN_OPERATION_PERMISSIONS` 的存在理由：库里不给管理员逐条绑 `system:*`
（Guard 已短路），但 `/auth/me` 返回的 `permissions` 要完整，否则前端菜单、
按钮的显隐判断会因「库里没绑」而缺项。

---

## 七、 数据库约束优化：条件部分唯一索引

**背景**：参考项目在 `kh_permission` 的 `permission_code` 字段上设置了全局 `UNIQUE` 约束，而业务层采用逻辑软删除（`deleted = true`）。一旦管理员软删某个权限后再以相同编码重建，会直接触发 PostgreSQL 数据库级 `duplicate key value violates unique constraint` 错误。

**解法**：在 DDL 中移除字段级全局 `UNIQUE`，改用条件部分索引（Partial Index）：
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_permission_code
    ON kh_permission(permission_code) WHERE deleted = false;
```
同时在 TypeORM 实体 `PermissionEntity` 上声明 `@Index('uk_kh_permission_code', ['permissionCode'], { unique: true, where: 'deleted = false' })`，彻底规避软删除后的冲突风险。

---

## 八、 已知局限与后续演进

- **每请求权限计算的高并发缓存（Redis）**：目前每请求通过 2~3 条 SQL 连表计算权限（`direct ∪ role`），以此换取改完权限「即时生效」的极致一致性。后续进入高并发压测阶段时，可引入 Redis 缓存键 `user:perm:${userId}`（短 TTL 10~30 分钟），并在角色/用户权限分配时主动淘汰（Cache Eviction）。
- **树形结构的构建复杂度优化**：当前 `PermissionService.getTree()` 与 `TeamService.getTree()` 采用内存递归 `filter`（$O(N^2)$），在当前几十至几百个节点规模下耗时小于 1ms。若后续组织架构和权限节点规模扩展至数千级，可重构成基于 `Map<parentId, children[]>` 的单次遍历构建（$O(N)$）。
- **超管通配权限码与动态扩展**：`getUserPermissionCodes` 在用户是管理员时，除了注入预置常量权限集合，额外追加了 `'*'` 通配符，便于前端统一识别超管对后台动态新增菜单/按钮的全量放行。
- **权限树只做分类，不继承**：`parent_id` 无业务含义，拥有父权限 ≠ 拥有子权限。目前前端需要自己按 code 枚举，后续若要「授予父即含子」需改数据模型。
- **`document:*` 权限码当前只有前端语义**：文档模块的接口鉴权仍按 `@Roles`（发布/审核用 `ROLE_REVIEWER/ADMIN`），没有用 `@RequirePermission`。等第 64 讲做可见性过滤时再统一，避免现在就动文档主链路。
- **团队模块与检索可见性尚未接线**：`kh_team` / `kh_team_member` 已就绪，但 `kh_document.team_id` 的召回期过滤属于第 64 讲，本轮未改检索链路。（`docs/TODO.md` §3「鉴权过滤」条目已可开工。）
- **无权限变更审计**：谁在什么时候给谁加了什么权限，目前不落日志；等有合规需求时补一张操作流水表。
