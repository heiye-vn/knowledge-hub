# 账号激活治理：重发激活邮件 + 未激活账号过期清理

> **模块范围**：TODO §8.2（重发激活邮件入口）与 §8.4（未激活账号过期清理），
> 是 [user-module.md](./user-module.md) 邮箱激活流程的配套治理。
>
> **代码路径**：
> - `apps/server/src/auth/auth.service.ts`（`resendActivation` / `resendActivationForUser` / `sendActivation`）
> - `apps/server/src/auth/auth.controller.ts`、`auth/dto/auth.dto.ts`（`ResendActivationDto`）
> - `apps/server/src/auth/email-activation.service.ts`（新增 `getTtlByUser`）
> - `apps/server/src/user/user.service.ts`（`purgeInactiveAccounts`）
> - `apps/server/src/user/user-cleanup.service.ts`（启动时惰性清理）
> - `apps/server/src/user/user.controller.ts`（`POST /users/purge-inactive`）
>
> **接口**：
> - `POST /auth/activation/resend`（`@Public`，body `{ username, password }`）
> - `POST /auth/activation/resend/:userId`（`@Roles(ADMIN)`，管理员代发）
> - `POST /users/purge-inactive?days=7`（`system:user`）
>
> 完成时间：2026-10-05。

---

## 一、 重发激活邮件为什么必须是「公开端点 + 密码」

**背景**：开启 `REQUIRE_EMAIL_VERIFICATION=true` 后，激活邮件丢失只能等 24h token 过期后
重新注册——而重新注册会撞「用户名/邮箱已被注册」，用户实际上被卡死。

【易错】**不能挂在登录态下**：未激活账号（`email_verified=0`）在
`UserService.validateCredentials` 就被拒，根本拿不到 accessToken。
入口只能是 `@Public` 端点。

【易错】**公开端点不能只收用户名或邮箱**：若只凭邮箱触发，任何人都能拿他人邮箱
反复调用，接口沦为邮件轰炸入口。解法是要求「用户名 + 密码」证明账号归属，
密码错误与账号不存在**统一返回 401「用户名或密码错误」**，不泄露账号是否存在。

**校验顺序**（`resendActivation`）：密码 → 账号状态（禁用 401）→ 已激活（400）
→ 未绑邮箱（400）→ 冷却（400）→ 建 token → 发信。
先验密码再暴露「已激活 / 未绑邮箱」等状态信息，避免未认证者探测账号状态。

**如何验证**：`auth.service.spec.ts` 中 `AuthService.resendActivation` 用例组覆盖
密码错误 / 账号不存在 / 已激活 / 未绑邮箱 / 冷却中 / 正常发送 / 发信失败回滚 7 条路径。

---

## 二、 60 秒冷却：TTL 反推，不新增 Redis 键

沿用 [user-module.md](./user-module.md) 中验证码冷却的思路：激活 token 写入时 TTL = 24h，
若 `剩余 TTL > 24h - 60s`，说明距上次发送不足 60 秒，直接 400。

- 新增 `EmailActivationService.getTtlByUser(userId)`，读的是 `userId → token` 反向键的 TTL；
  无 token 时 Redis 返回 `-1`（不存在为 `-2`），都小于阈值，自然放行。
- `createToken` 自带「同用户旧 token 作废」语义，所以**重发后旧邮件里的链接立即失效**，
  只有最新一封可用——这是预期行为，接口返回文案里不需要额外提示。

【易错】冷却只对自助入口生效，管理员代发 `skipCooldown=true`：
管理员是在处理用户工单，被冷却挡住只会增加沟通成本；管理员身份已经提供了防滥用保障。

---

## 三、 发信失败必须回滚 token

与注册链路同一原则：token 已写 Redis 而邮件没发出去，冷却会把用户挡 60 秒，
且 Redis 里留下一个永远没人能点到的链接。
`sendActivation` 在 `mail.sendActivationEmail` 抛错时调用 `deleteByToken` 清理双键，
再抛 400「激活邮件发送失败，请稍后再试」。

**如何验证**：用例「发信失败 → 回滚 token，不留下点不开的激活链接」断言 `deleteByToken` 被调用。

---

## 四、 未激活账号清理：软删 + 启动时惰性执行

### 4.1 为什么软删就够

用户名 / 邮箱的唯一索引是部分索引（`WHERE deleted = false`），
软删后被占位的标识**自动释放**，真实邮箱主人可以重新注册；同时保留记录便于追溯滥用。
物理删除没有额外收益，反而丢失审计线索。

### 4.2 为什么不上定时任务

项目目前没有 `@nestjs/schedule`，清理是低频、幂等的一条 `UPDATE`。
为它引入调度依赖属于过度设计，选择 `UserCleanupService.onModuleInit` 在**进程启动时顺手执行一次**，
配合 `POST /users/purge-inactive` 作为管理员手动兜底。

- 开关：`PURGE_INACTIVE_ON_BOOT`（默认 `true`）
- 天数：`INACTIVE_ACCOUNT_TTL_DAYS`（默认 7，非法值回退默认）
- 清理失败**只 warn 不阻断启动**：这是治理动作，不是服务可用的前置条件。

### 4.3 【易错】清理条件必须确认「正常账号不会是 0」

`WHERE email_verified = 0` 这个条件要安全，前提是**只有「待激活」账号才会是 0**。
落地前逐一核对了所有写入点：

| 写入点 | `email_verified` |
| :--- | :--- |
| DDL 默认值（`01-init.sql`） | `1`（兼容存量账号） |
| 注册，验证开关关闭 | `1` |
| 注册，验证开关打开 | `0`（唯一会产生 0 的路径） |
| 管理员创建用户 | `1` |
| 激活成功 | 置 `1` |

结论：关闭验证开关的环境里不会产生 0，启动清理不会误删正常用户。
**后续若新增任何写 `email_verified=0` 的路径（如 TODO §8.3 改邮箱重置验证状态），
必须重新评估本清理逻辑**——改邮箱的老用户 `created_at` 早已超过 7 天，
会在下次重启时被直接软删。

### 4.4 【易错】QueryBuilder update 不会自动刷新 `updatedAt`

与 `em.update()` 同理，`createQueryBuilder().update()` 不走实体生命周期，
`@UpdateDateColumn` 不会生效，`set({ deleted: true, updatedAt: new Date() })` 必须手动带上。

### 4.5 天数兜底

`purgeInactiveAccounts` 对入参做 `Math.max(1, Math.floor(days))`：
0 / 负数 / 小数都不会变成「清理所有未激活账号」（cutoff = now），最少保留 1 天。
Controller 层对非法 `days` 回退到默认 7 天。

**如何验证**：`user.service.spec.ts` 4 条用例覆盖：返回清理数量、WHERE 条件与 cutoff 推算、
非法天数兜底 1 天、默认 7 天。本次提交前 `auth.service.spec.ts` + `user.service.spec.ts`
共 23 条用例全部通过，`pnpm typecheck:server` 通过。

---

## 五、 已知局限与后续待办

- **管理员代发用的是 `@Roles(ADMIN)` 而非权限码**：与 [rbac.md](./rbac.md) 推崇的
  「细粒度权限码」不一致，而同批的 `purge-inactive` 用的是 `system:user`。
  后续可统一改为 `@RequirePermission('system:user')`。
- **计时侧信道**：账号不存在时不执行 bcrypt `compare`，响应比「密码错误」快，
  理论上可通过响应时间枚举用户名。公网暴露前可对不存在账号也跑一次假 `compare` 拉平耗时。
- **IP 维度限流未做**：密码校验挡住了邮件轰炸，但挡不住对 `/auth/activation/resend` 的
  密码爆破，与登录接口同属 TODO §8.1。
- **多实例启动会并发执行清理**：`UPDATE` 幂等、无副作用，可接受；若后续清理逻辑变重
  （如联动删除对象存储），需加分布式锁或迁移到独立调度任务。
- **激活 token 不联动删除**：auth 依赖 user，反向依赖会造成循环依赖；token 24h 自然过期，
  且激活一个已软删账号无实际效果（软删账号无法登录）。
- **TODO §8.3（改邮箱重置验证状态）未实现**，与本模块联动时注意 4.3 的误删风险。
