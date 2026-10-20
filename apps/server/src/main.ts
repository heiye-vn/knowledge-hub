import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Logger, ValidationPipe } from '@nestjs/common';

/** 与 AuthService / JwtStrategy 中的 fallback 保持一致 */
const DEV_JWT_DEFAULTS: Record<string, string> = {
  JWT_ACCESS_SECRET: 'dev-access-secret',
  JWT_REFRESH_SECRET: 'dev-refresh-secret',
};

/**
 * 启动前校验 JWT 密钥。
 *
 * 这两个密钥在 AuthService / JwtStrategy 里带 dev 默认值（本地零配置即可跑、
 * 单测不必铺一堆 env），代价是「忘了配」和「配好了」在运行时无法区分。生产用
 * 默认密钥等于把签发权公开，所以在进程起来之前拦一次：
 * 生产环境缺失或仍是默认值 → 直接退出；开发环境只告警，不阻断。
 */
function assertJwtSecrets(logger: Logger): void {
  const weak = Object.entries(DEV_JWT_DEFAULTS)
    .filter(([key, devDefault]) => {
      const value = process.env[key]?.trim();
      return !value || value === devDefault;
    })
    .map(([key]) => key);

  if (!weak.length) return;

  const names = weak.join('、');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `生产环境必须先配置 ${names} 且不得使用 dev 默认值，应用拒绝启动`,
    );
  }
  logger.warn(
    `未配置 ${names}，正在使用 dev 默认密钥（仅限本地开发；生产环境会拒绝启动）`,
  );
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  assertJwtSecrets(logger);

  const app = await NestFactory.create(AppModule);

  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin:
      allowedOrigins.length === 1 && allowedOrigins[0] === '*'
        ? true
        : allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
