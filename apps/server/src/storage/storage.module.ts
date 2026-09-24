import { Global, Module } from '@nestjs/common';
import { RustfsDriver } from './drivers/rustfs.driver.js';
import { AliyunOssDriver } from './drivers/aliyun-oss.driver.js';
import { StorageService } from './storage.service.js';
import { RustfsService } from './rustfs.service.js';

/**
 * 存储模块 (StorageModule)
 *
 * 集中管理对象存储驱动（阿里云 OSS / 本地 RustFS）
 * 对外统一暴露 StorageService 门面以及向下兼容的 RustfsService
 */
@Global()
@Module({
  providers: [RustfsDriver, AliyunOssDriver, StorageService, RustfsService],
  exports: [StorageService, RustfsService],
})
export class StorageModule {}
