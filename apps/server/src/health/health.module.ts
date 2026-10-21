import { Module } from '@nestjs/common';
import { KgModule } from '../kg/kg.module.js';
import { RagModule } from '../rag/rag.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/** 健康检查：依赖 DataSource（TypeOrmModule 全局注册）与三个可选依赖的客户端 */
@Module({
  imports: [RedisModule, RagModule, KgModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
