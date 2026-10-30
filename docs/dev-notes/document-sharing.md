# 文档分享链接（feat-v21）

> 模块范围：`kh_document_share`、分享创建/列表/关闭、公开预览与访问、密码失败限流、私有图片签名访问、前端分享弹窗与公开分享页。
> 代码路径：`apps/server/src/document/document-share.service.ts`、`share.controller.ts`、`document-resource.reader.ts`、
> `dto/social.dto.ts`、`dto/share-asset.dto.ts`、`apps/web/src/components/DocumentEngagement.tsx`（分享弹窗）、
> `components/ShareImage.tsx`、`components/DocumentMarkdown.tsx`、`pages/SharePage.tsx`。

## 关键决策

### 1. 创建分享必须严格校验写权限

创建公开分享链接若仅校验「文档可读」，会导致任何能读到文档的成员都能越权生成外部公开链接，造成敏感信息外泄。
本项目在 `requireWritableShareable()` 里严格校验 `canWriteDocument`（仅作者与管理员）与「已发布」状态，与列表/撤销的权限边界保持严格对称。

【实录】使用普通用户对他人已发布文档调用创建接口，正确返回 403 Forbidden 拦截越权。

### 2. 带密码的链接在预览阶段不返回标题

`GET /shares/:code` 只返回 `needPassword` / `expireAt`；设置密码时 `title` 为 null。
公开页在验密前显示「文档分享」，验密成功后才展示真实标题。避免未验证就把文档主题泄露给拿到短码的人。

### 3. 密码与有效期

- 密码 bcrypt（cost 10），库里只存 hash；
- `expireDays` 1~365，不传长期有效；
- 关闭是软关闭（`revoked=true`），关闭后访问 404「分享链接不存在或已关闭」；
- 过期但未关闭的链接仍在列表里，返回 `expired=true`，前端打红标，仍可手动关闭。

### 4. 短码生成

`randomBytes(9).toString('base64url').slice(0, 12)`（72 bit 熵），插入前查重，最多重试 5 次；
表上 `token` 唯一约束兜底。

### 5. 公开访问不经过登录守卫

`ShareController` 的 `preview` / `access` / `assets` 都标 `@Public()`，全局 JwtAuthGuard 直接放行；
服务层自行校验链接状态与文档是否仍为已发布（文档下架/删除后链接立即失效）。

### 6. 密码失败限流：Redis + fail-closed

`access()` 在 bcrypt 比对前先查 `kh:share:pwd:<code>:<ip>` 的失败次数：
- 未达上限才允许比对；
- 失败一次用 `RedisService.incrementWithTtl` 原子 +1（窗口 `SHARE_ATTEMPT_WINDOW_SECONDS`，默认 600s）；
- 成功登录立即删除计数；
- 达到 `SHARE_MAX_ATTEMPTS`（默认 10）后，即使密码正确也返回 429，直到窗口过期。

**为什么 fail-closed**：密码是公开链接的唯一门禁，Redis 不可用时跳过计数等于允许无限爆破。
因此这里不套用吊销黑名单的 fail-open，而是让密码链接直接 503（免密链接不访问 Redis，不受影响）。

【实录】连续 10 次错误返回 403，第 11 次即使密码正确也返回 429；联调脚本验证通过。

### 7. 私有图片签名访问

分享正文里的图片原本是 `/documents/:id/assets/:assetId`（登录 + 文档 ACL），公开页无法加载。
验密成功后 `signContentImages()` 把正文中的资源地址重写为：

```
/shares/<code>/assets/<assetId>?exp=<秒级时间戳>&sig=<HMAC-SHA256 hex>
```

- 签名内容 `${code}:${assetId}:${exp}`，密钥优先 `SHARE_ASSET_SECRET`，未配置回退 `JWT_ACCESS_SECRET`；
- 有效期 `SHARE_ASSET_TTL_SECONDS`（默认 900 秒）；
- 公开资源接口 `GET /shares/:code/assets/:assetId` 每次请求都校验：分享仍有效（未关闭/未过期/文档已发布）→ 签名未过期且 timing-safe 匹配 → 资源确属该文档；
- 资源读取复用 `readDocumentResource()`（`document-resource.reader.ts`），与登录态读取共用解密逻辑，不放开 `/documents/:id/assets` 本身；
- 前端 `DocumentMarkdown` 新增 `assetMode="share"`，`ShareImage` 只接受符合正则的签名地址并补 API 前缀（外部 HTTPS 图片仍按既有白名单放行），直接用 `<img>` 加载，不附带 Bearer。

【实录】用一篇带 8 张私有图片的真实文档分享：正文 8 条地址全部重写，匿名请求 8/8 返回 200 且 Content-Type 为 image/*；篡改签名 403、过期签名 400。
【易错】签名 URL 必须由前端补 `API_BASE`（开发环境是 `/api`），后端只回传站内相对路径，不能写死前端地址。

## 验证

- 单测：`document-share.service.spec.ts`（14 项：越权创建、草稿分享、密码 hash、预览脱敏、密码错误/成功清零、10 次后 429、Redis 不可用 503、免密不依赖 Redis、图片签名重写/读取、篡改/过期、关闭/过期、列表权限）。
- 单测：`document-resource.reader.spec.ts`（解密读取、资源不存在、assetId 命中源文件拒绝）。
- 联调：真实文档发布 → 创建免密分享 → 匿名访问 → 8 张图片全部 200 → 篡改/过期拒绝；密码分享 10 次错误后 429。
- 浏览器：清空 localStorage 打开 `/share/:code`，验密后正文图片实际渲染（首屏图片 naturalWidth > 0，其余懒加载）。

## 已知局限

- 签名 URL 在有效期内可以被转发，无法绑定具体浏览器；缩短 TTL 只能降低窗口。
- 资源接口返回 `Cache-Control: private, max-age=300`，关闭分享后已缓存的图片最多还能在浏览器本地显示 5 分钟；需要更强即时性时改 `no-store`。
- 分享链接没有访问统计（次数/最后访问时间），当前只做内容外发。
- 限流按 code + IP，NAT/代理后多人共享 IP 会互相影响；按 IP 伪造 `X-Forwarded-For` 也依赖反向代理正确配置。上线时应在网关层再加一层全局限流。
