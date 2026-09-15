import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiResponse } from '../interfaces/api-response.interface.js';

/**
 * 全局成功响应拦截器
 * 将 Controller 返回的业务数据统一封装为标准格式：
 * { code, message: 'success', data, timestamp }
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();
    const statusCode: number = response?.statusCode ?? 200;

    return next.handle().pipe(
      map((data: T) => {
        // 若返回值本身已经包含 code 和 data 结构，则不再重复封装
        if (
          data !== null &&
          typeof data === 'object' &&
          'code' in data &&
          'data' in data
        ) {
          return data as unknown as ApiResponse<T>;
        }

        return {
          code: statusCode,
          message: 'success',
          data: (data ?? null) as T,
          timestamp: Date.now(),
        };
      }),
    );
  }
}
