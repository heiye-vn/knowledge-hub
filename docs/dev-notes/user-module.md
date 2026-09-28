# 用户模块完善：邮箱激活、验证码重置密码、用户/角色管理

> **模块范围**：Redis 薄封装（`src/redis/`）、邮件服务（`src/mail/`）、
> 邮箱激活与验证码重置密码（`src/auth/`）、用户与角色管理接口（`src/user/`）。
> 完成时间：2026-09-28。

---

## 一、 Redis 薄封装：从「三处各自连接」到一条连接

### 1.1 现状盘点

改造前 Redis 有三类使用方：

| 使用方 | 连接方式 | 是否可收敛 |
| :--- | :--- | :--- |
| BullMQ 两个 Publisher / 两个 Worker | 传 `{host, port}` 给 BullMQ，连接由 BullMQ 内部管理 | ❌ 没有裸客户端可收敛，强行抽象是过度设计 |
| `TokenRevocationService` | 裸 `new Redis()` + 40 行连接样板 | ✅ |
| 本轮新增的激活 token / 重置验证码 | —— | ✅ 直接复用 |

【易错】「统一封装」的真实收益不是少建几个连接，而是**消灭复制粘贴的连接样板**：
`lazyConnect` + `Promise.race` 限时探测 + `describeError` + `REDIS_ENABLED` 降级，
这段代码是踩坑换来的（见 `mq.constants.ts` 的【易错】注释），同一段脆弱逻辑抄三份，
下次 ioredis 升级要改三处。

### 1.2 解法

`RedisService` 只暴露 `get / set(带TTL) / del / ttl` 四个原语 + 两个策略入口：
`isAvailable()`（fail-open 场景自查）与 `assertAvailable()`（fail-closed 场景直接 503）。
连接样板全在这一个文件里，`TokenRevocationService` 瘦身为纯黑名单语义（~40 行）。

**验证**：`pnpm typecheck` + `pnpm test`（含既有 `task-status.spec` 全过），
`TokenRevocationService` 行为不变（fail-open 语义原样保留）。

---

## 二、 fail-open vs fail-closed：同一套 Redis，两种降级策略

### 2.1 【关键决策】

项目原有降级哲学是 fail-open（Redis 不可用 → 功能跳过 → 应用照常启动），
对队列、吊销黑名单成立——跳过的代价是「体验降级」。

但激活 token / 重置验证码是**安全闸门**：校验被跳过 = 验证码随便填都能改密码。
这类功能必须 fail-closed：Redis 不可用时 `assertAvailable()` 直接抛
`ServiceUnavailableException`（503），临时不可用，但防线没有洞。

最终格局：**吊销/队列 fail-open，验证类 fail-closed**，按功能性质区分而非全局统一。
理由写在这里，防止后来者「顺手统一」成一半。

### 2.2 【易错】如何验证降级方向没接反

- 停掉 Redis：`/auth/password/reset/send-code` 应返回 503，而不是 200 或「邮箱未注册」；
- refresh 接口在 Redis 挂时应**照常放行**（fail-open，与此前行为一致）。

---

## 三、 邮箱激活：双键互指与一次性消费

### 3.1 双键互指设计

- `kh_auth:activate:token:{token} → userId`：点链接时按 token 反查账号；
- `kh_auth:activate:user:{userId} → token`：保证同一用户只留一个有效 token，
  重发时先按 userId 找到旧 token 一并作废，防止旧链接复活。

单键设计的漏洞：如果只有 token→userId 一个键，重发激活邮件后旧 token 在 24h 内依然可用。

### 3.2 【易错】双键写入不是原子的

「读旧 token → 删 → 写新」存在 get-then-set 竞态，并发重发理论上可能短暂双有效。
实际不可达：触发点是注册（同一用户并发注册被用户名唯一索引挡住），且无重发入口。
如需加固，用 Lua 脚本把删旧+写新合成单命令——本期不做，单测里留了注释。

### 3.3 兼容存量数据

`email_verified SMALLINT NOT NULL DEFAULT 1`——默认 1 而不是 0，
三个预置账号（admin/reviewer/user）和既有用户不受影响；
只有 `REQUIRE_EMAIL_VERIFICATION=true` 之后的新注册才写 0。

**验证**：存量库手动执行
`ALTER TABLE kh_user ADD COLUMN IF NOT EXISTS email_verified SMALLINT NOT NULL DEFAULT 1;`
（init 脚本只在空卷首次建库时跑），然后存量账号应能正常登录。

### 3.4 【易错】email 唯一性与可空性

`kh_user.email` 本来是可选字段。开启邮箱验证后注册 email 必填（`UserService.register`
前置校验），且新增部分唯一索引 `WHERE deleted = false AND email IS NOT NULL`——
软删用户不算占用，未填邮箱的用户不参与约束。重置密码按邮箱找人依赖这个唯一性，
否则「查到多个用户」这一态没有合理语义。

### 3.5 登录拦截与防枚举

`validateCredentials` 中「用户名不存在/密码错误」统一报「用户名或密码错误」防止枚举；
未激活是**独立报错**（「账户未激活，请先验证邮箱」）——前提是账号密码已验证正确，
此时暴露「该账号存在且未激活」不构成新的信息泄漏。

---

## 四、 验证码重置密码：TTL 反推冷却

60 秒重发冷却**不单独存冷却键**，直接用验证码键的剩余 TTL 反推：
刚写入时 TTL≈600s，剩余 > 540s 说明距上次发送不足 60s。省一次 Redis 往返，
也避免「验证码删了但冷却键忘了删」这类双键一致性坑。

【易错】发码失败必须回滚：验证码先写 Redis 再发邮件，SMTP 挂了要**删掉刚写的码**，
否则用户拿到「已发送」假象，冷却 60s 后才能重试且永远收不到码。
激活邮件同理（发信失败删 token）。

---

## 五、 用户与角色管理接口

### 5.1 权限分级

- 登录即可：`PUT /users/me`、`GET /users/me/stats`、`PUT /users/password/change`
- 仅 ADMIN：分页/详情/增/改/删/管理员重置密码/查与分配角色（`@Roles(RoleCode.ADMIN)`）
- 整个 `/roles` controller 类级 `@Roles(RoleCode.ADMIN)`

服务层底层能力（`assignRole` 幂等、`getRoleCodes`、`getUserIdsByRoleCode`）
在此前版本已就绪，本轮只补了管理侧读写与 controller。

### 5.2 【易错】路由声明顺序

`@Get('page')` 必须声明在 `@Get(':id')` 之前，Nest 按声明顺序匹配，
反过来 `page` 会被 `:id` 吞掉。与 document.controller 的已知坑相同。

### 5.3 【决策】删除用户用软删

硬删会被 `kh_user_role` / 文档 `create_by` 外键绊住，且丢失创建人痕迹；
与全局软删约定一致（文档、审核流水同风格）。

### 5.4 【决策】角色删除不做级联解绑

`kh_user_role` 外键无 `ON DELETE CASCADE`，仍有用户引用的角色直接删除会 FK 报错——
这是**故意的**：删除在用角色是高危操作，应该先解绑再删，数据库层兜底比应用层放行安全。

---

## 六、 邮件服务与本地联调

- 用裸 `nodemailer` 而非 `@nestjs-modules/mailer`：只有两封纯文本邮件，
  不需要模板引擎那层抽象（贴合项目轻依赖风格）。
- 【易错】ESM 下 `import nodemailer from 'nodemailer'` 直接可用
  （Node ESM 对 CJS 的 default interop 拿到 `module.exports`），
  无需 `.default` 解构——与 AGENTS.md 2.4 提到的部分 CJS 库不同。
- 【实录】SMTP_USER/PASS 为空时**不能给 nodemailer 传空字符串 auth**：
  MailHog 日志显示 `250 AUTH PLAIN` 后客户端即被断开（`Connection closed by remote host`），
  注册接口报「激活邮件发送失败」。空凭据会触发 nodemailer 发起 AUTH 握手并失败；
  解法是仅在 user/pass 均非空时挂 `auth` 字段。已实机回归验证。
- 本地联调用 MailHog（compose 新增 `mailhog` 服务，SMTP 1025 / Web 8025），
  零真实发信；未配置 `SMTP_HOST` 时应用照常启动，验证类功能调用时报错。
- 【易错】MailHog API（:8025/api/v2/messages）里邮件正文可能是 **base64 或
  quoted-printable**（nodemailer 按内容自动选择），解析时按
  `Content-Transfer-Encoding` 分别处理——E2E 脚本提取激活 token / 验证码时踩过。

---

## 七、 单测与验证

- `email-activation.service.spec.ts`（6 例）：双键互指、重发作废旧 token、一次性消费、回滚、fail-closed
- `password-reset.service.spec.ts`（4 例）：邮箱归一、TTL 冷却判定、一次性、fail-closed
- `auth.service.spec.ts`（11 例）：注册开关两态、发信失败回滚、激活、冷却、重置全链路

全部纯 fake，不依赖真实 Redis / SMTP，0 Token 消耗（与图片解析单测同风格）。

**端到端实录（MailHog，2026-09-28）**：临时实例（3001 端口，
`REQUIRE_EMAIL_VERIFICATION=true` + MailHog SMTP）跑通两条完整链路——
①注册 → 收激活邮件 → `verify-email` 激活 → 登录成功 → token 复用失效（6 步）；
②`send-code` → 60s 冷却拦截重发 → 错码 400 → 正确码重置 → 旧密码 401 / 新密码登录 →
验证码复用失效（8 步）。两条链路的「失败分支」（发信失败回滚、token/码一次性）同样实测确认。

**验证命令**：`pnpm test:server`。
⚠️ 【实录】Docker 未启动时并行跑全量，`app.controller.spec`（Hello World）会因
worker 被 KG 等 spec（真实调 LLM）挤占而超时；单跑即过，串行 `--fileParallelism=false` 全过。
该 spec 与本模块代码无关，属环境资源争抢，非回归。

---

## 八、 已知局限与后续待办

1. **登录限流未做**（`authentication.md` 遗留）：重置密码的 60s 冷却只防「重发轰炸」，
   不防验证码暴力猜解（10 万组合 ÷ 10 分钟窗口，限流前可枚举）。待办：`send-code` /
   `reset` 接口加 IP+账号维度限流，或验证码错 5 次作废。
2. **无重发激活邮件入口**：激活邮件丢了只能等 24h 或找管理员删号重建。
3. **管理员不能给用户改 email 后重置验证状态**：改 email 不会置 `email_verified=0`。
4. **审计日志未做**：管理员重置密码、分配角色等敏感操作无留痕（`authentication.md` 遗留）。
5. **验证码短信通道未留**：当前仅邮件，接口语义（code + email）可平滑扩展。
