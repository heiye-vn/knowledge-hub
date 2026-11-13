# 对象存储双模式（阿里云 OSS / 本地 RustFS）

> 模块范围：`apps/server/src/storage/`（`storage.service.ts` 门面 + 策略路由、
> `drivers/aliyun-oss.driver.ts`、`drivers/rustfs.driver.ts`、`storage.types.ts`）。
> 环境变量见 `apps/server/.env.example` 的 Storage 段，此处不重复。

## 关键决策

### 1. 0 冗余依赖：用 `@aws-sdk/client-s3` 驱动阿里云 OSS

OSS 原生兼容 S3 API，直接复用项目已引入的 SDK，不安装 `ali-oss`：
省一个体积包、统一 TypeScript 严格类型、复用 S3 Client 原生连接池与超时重试。

### 2. 向下兼容用「代理」而不是重写调用点

历史组件 `RustfsService` 保留并实现 `StorageDriver`，内部委托给 `StorageService`，
历史调用零改动。这类"旧入口包新门面"的做法，比全局改调用点风险低得多。

### 3. 驱动选择必须有兜底，不能靠单一环境变量

未显式配置 `STORAGE_DRIVER` 时：检测到 `OSS_ACCESS_KEY_ID` 则优选 OSS，
否则回退本地 RustFS。避免"忘了配一个变量就整个上传挂掉"。

### 4. 公网直链用标准 Virtual-Hosted 格式

`https://${bucket}.${endpointHost}/${key}`；配置 `OSS_CUSTOM_DOMAIN` 时优先走
自定义 CDN 域名。本地 RustFS 走 Path-Style（`/bucket/key`），与 S3 兼容模式一致。

## 已知局限

- RustFS 定位为本地离线备用，生产走 OSS；两者公网能力不对等（仅 OSS 支持 CDN / 自定义域名）。
- 驱动切换靠环境变量重启生效，不做运行时热切换；切换后新对象落在新驱动，历史对象不迁移。
  切 OSS 后若不需要本地 RustFS，可在 `docker-compose.yml` 注释掉 rustfs 服务释放 9000/9001 端口。
