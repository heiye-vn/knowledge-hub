import { defer, lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { TransformInterceptor } from './transform.interceptor.js';

/**
 * 【易错】状态码必须在 handler 返回之后读取。
 * 健康检查用 @Res({ passthrough: true }) 在业务里把状态码改成 503，
 * 若拦截器在调用 next.handle() 之前就把 statusCode 取走，信封里的 code 会永远是 200，
 * 与真实 HTTP 状态不一致。
 */
describe('TransformInterceptor', () => {
  it('authenticated resources remain binary instead of JSON envelopes', async () => {
    const file = new StreamableFile(Buffer.from('image bytes'));
    const context = { switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }) } as ExecutionContext;
    const result = await lastValueFrom(new TransformInterceptor().intercept(context, { handle: () => of(file) }));
    expect(result).toBe(file);
  });

  it('信封 code 反映 handler 执行后的最终状态码', async () => {
    const response = { statusCode: 200 };
    const context = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ExecutionContext;

    const handler: CallHandler = {
      handle: () =>
        defer(() => {
          // 模拟 controller 内 res.status(503)
          response.statusCode = 503;
          return of({ status: 'error' });
        }),
    };

    const result = await lastValueFrom(
      new TransformInterceptor().intercept(context, handler),
    );

    expect(result).toMatchObject({
      code: 503,
      message: 'success',
      data: { status: 'error' },
    });
  });
});
