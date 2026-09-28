import { Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Redis 模块：全局复用的 KV 连接薄封装。
 *
 * 只在需要 Redis 语义的模块（auth 的吊销 / 激活 / 验证码）显式导入，
 * BullMQ 队列自行管理连接，不经此模块。
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
