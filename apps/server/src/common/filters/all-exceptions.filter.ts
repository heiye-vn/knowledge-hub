import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorResponse } from '../interfaces/api-response.interface.js';

/**
 * 全局统一异常过滤器
 * 统一捕获并格式化所有 HttpException 及未捕获的系统异常
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) {
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
        error = exception.name;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        // 处理 class-validator 抛出的错误数组
        if (Array.isArray(resObj.message)) {
          message = resObj.message.join('; ');
        } else if (typeof resObj.message === 'string') {
          message = resObj.message;
        } else {
          message = exception.message;
        }

        if (typeof resObj.error === 'string') {
          error = resObj.error;
        } else {
          error = exception.name;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
      this.logger.error(
        `[${request.method}] ${request.url} - 未捕获异常: ${exception.message}`,
        exception.stack,
      );
    } else {
      this.logger.error(
        `[${request.method}] ${request.url} - 未知异常: ${String(exception)}`,
      );
    }

    // 记录 4xx 业务客户端警告日志
    if (status >= 400 && status < 500) {
      this.logger.warn(
        `[${request.method}] ${request.url} - ${status} - ${message}`,
      );
    }

    const errorResponse: ApiErrorResponse = {
      code: status,
      message,
      error,
      path: request.url,
      timestamp: Date.now(),
    };

    response.status(status).json(errorResponse);
  }
}
