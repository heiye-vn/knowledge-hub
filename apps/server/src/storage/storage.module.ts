import { Global, Module } from '@nestjs/common';
import { RustfsService } from './rustfs.service.js';

/**
 * 存储模块
 * 集中管理 RustFS（S3 兼容）相关配置和单例客户端
 */
@Global()
@Module({
  providers: [RustfsService],
  exports: [RustfsService],
})
export class StorageModule {}
