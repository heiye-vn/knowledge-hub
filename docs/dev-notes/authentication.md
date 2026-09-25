# 用户鉴权（feat-v7）：JWT 双令牌 + 全局守卫 + 审核人收口

> **模块覆盖范围**：用户 / 角色 / 关联三表、`auth` 模块（注册 / 登录 / 刷新 / 登出 / me / 审核员列表）、
> 全局 `JwtAuthGuard` + `RolesGuard`、文档模块接入（操作人自动填充 + 审核人从登录态取）。
> **对应代码路径**：`apps/server/src/auth/`、`apps/server/src/user/`、
> `src/common/constants/roles.ts`、`init-scripts/postgresql/01-init.sql`（用户段）。
> 完成时间：2026-09-25。与参考项目 v7 的分叉登记见 [reference-mapping.md](../reference-mapping.md)。

---

## 一、 设计决策

### 1. 双令牌独立密钥【易错】

基线实现 access / refresh **共用一个 `JWT_SECRET`**，仅靠 payload 里的 `type` 字段区分用途。
本项目改为 `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` 两把独立密钥：

- 任一把泄露不再殃及另一类令牌，可独立轮换；
- JwtStrategy 用 access 密钥验签，refresh token 即使 type 字段没校验也过不了验签层，
  「拿 refresh 调业务接口」从逻辑防御升级为密码学防御。

两把密钥都走 ConfigService（缺省 dev 值，生产必须覆盖），`JwtModule` 故意**不注册全局 secret**，
签发与验签时显式传入，避免「注册处一个 secret、使用处又一个」的漂移。

### 2. 登出吊销：Redis 黑名单 + jti【易错】

refresh token 签发时带 `jti`（`crypto.randomUUID()`）。`POST /auth/logout` 验签通过后，
以 `SETEX kh_auth:revoke:{jti} <剩余秒数> 1` 拉黑；`refresh()` 在发新令牌前先查黑名单。

- TTL 取「refresh 剩余有效期」，标记到期自动清除，不需要清扫任务；
- **fail-open**：Redis 不可用时 `isAvailable()` 为 false，refresh 放行并告警——
  与重建索引队列同一降级风格（可用性优先，登出场景可接受）；
- access token 短期有效（默认 2h）且不落黑名单，自然过期即可，不给每请求加一次 Redis 查询。

【实录】ioredis **v6 没有 `waitUntilReady`**（BullMQ 的 Queue/Worker 才有），直接复用
`mq-error.util.ts` 的 `waitUntilReady` 会报 `Property 'waitUntilReady' is missing`。
解法：`new Redis({ lazyConnect: true })` + `Promise.race([connect(), timeout])` 限时探测。
另注意 v6 的导入是**具名导出** `import { Redis } from 'ioredis'`，
默认导入拿到的是模块对象，`new` 会报 not constructable。

### 3. 全局守卫的上线策略

`@Public` 白名单：`GET /`、`GET /health`（探活不带 token）与
`/auth/register|login|refresh|logout`。其余全站接口默认要求登录。

角色标注只加了三处，坚持「最小标注」原则，避免角色蔓延：
- 审核工作台 4 端点（待办 / 待审数 / approve / reject）→ `ROLE_REVIEWER | ROLE_ADMIN`；
- `GET /auth/reviewer-ids` → 同上；
- **高危运维端点** `POST /kg/build`、`DELETE /kg/documents/:id`、`POST /rag/reindex` → `ROLE_ADMIN`
  （全量重建 / 删图等于管理员操作，只要求登录等于全员可触发，基线实现未标）。

`RolesGuard` 在 `JwtAuthGuard` 之后执行（同为 APP_GUARD，按 providers 声明顺序）；
接口未标 `@Roles` 时放行——**角色是加法，登录是底座**，避免每加一个接口都要想角色。

### 4. 审核人收口：从「信前端」到「信令牌」

v6 遗留的「审核人由请求体传入」在本轮收口：

- `ReviewDecisionDto` 删除 `reviewerId` / `reviewerName`，客户端无法伪造审核人；
- `DocumentReviewService.approve/reject` 审核人参数由可选改**必填**，
  删掉 `?? '审核员'` 兜底（来历不明的审核记录比报错更糟）；
- Controller 用 `@CurrentUser()` 组装 `{ reviewerId: user.userId, reviewerName: user.realName ?? user.username }`。

### 5. 操作人字段：actor 注入 + DTO 显式覆盖

`create` / `update` / `uploadAndCreateDocument` 注入 `actor?: AuthUser`，
`authorId` / `createBy` / `updateBy` 在 DTO 未显式传时自动落登录用户（DTO 优先）。
保留显式覆盖是为脚本 / 管理端代录场景；`create` 的第二参已被存储 `fileInfo` 占用，
**actor 只能放第三位**，controller 里显式传 `create(dto, undefined, user)`。

---

## 二、 实现层易错点

1. **ESM import 必须带 `.js` 后缀**（`./auth-user.interface.js`），漏了编译期不报、运行期才炸。
2. **每请求回库重建 AuthUser**：`JwtStrategy.validate` 里 `getMe(payload.sub)`（查用户 + 角色），
   不信任 token 里的角色快照——角色变更 / 禁用即时生效。代价是每请求 +2 次查询，当前量级可接受。
3. **`forbidNonWhitelisted: true` 的连带效应**：DTO 删字段后，前端仍传 `reviewerId` 会直接 400。
   前端调用点与 Apifox 集合必须同步（本次已同步）。
4. **passport-jwt 需要 `@types/passport-jwt`**（dev 依赖），否则 typecheck 报 TS7016；
   bcryptjs 3.x 自带类型，无需 `@types/bcryptjs`。
5. 用户名唯一用**部分唯一索引** `WHERE deleted = false`，注册查重同步只查未删除用户，
   两层语义一致（软删后允许同名重建）。

## 三、 验证

- `pnpm typecheck:server` ✅（修掉 2 处 ioredis v6 类型问题 + 1 处缺失 types）
- `pnpm test:server` ✅ 95 passed / 23 skipped（ES 集成用例按惯例跳过）；
  审核用例同步更新为传入 `ReviewActor`
- `pnpm lint`（oxlint）✅ 0 errors / 11 warnings，警告全部位于既有文件，新增代码零告警
- 预置账号：`admin / reviewer / user`，密码均 `123456`（仅本地开发；admin 同时持有管理员 + 审核员）

## 四、 已知局限与后续待办

- **数据权限未做**：文档读接口只要求登录，没有作者级 / 团队级可见性过滤（TODO §3「鉴权过滤」）；
- **refresh 未轮换**：refresh 可重复使用直到过期；上轮换需处理「响应丢失导致客户端被踢」的边界；
- **账户管理接口缺失**：改密 / 禁用 / 角色分配后台未实现（`UserService` 已具备底层能力）；
- **登录限流未做**：账号枚举防护已有（统一报错），但无 IP / 账号维度的失败次数限制；
- **审计日志未做**：approve / reject / reindex 等高危操作暂无操作流水表。
