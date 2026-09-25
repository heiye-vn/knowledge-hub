import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Public } from './auth/decorators/public.decorator.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 服务存活探针，公开（K8s / 容器健康检查不带 token） */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** 健康检查，公开（探活不应依赖登录态） */
  @Public()
  @Get('/health')
  healthCheck(): { status: string } {
    return {
      status: 'ok',
    };
  }
}
