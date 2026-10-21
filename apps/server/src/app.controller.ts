import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Public } from './auth/decorators/public.decorator.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 服务根路径，公开 */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
