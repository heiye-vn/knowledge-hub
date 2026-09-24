import { Injectable } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import type {
  UploadBytesOptions,
  UploadBytesResult,
  StorageDriver,
} from './storage.interface.js';

export type { UploadBytesOptions, UploadBytesResult, StorageDriver };

/**
 * 历史向下兼容代理服务：RustfsService
 *
 * 现已平滑重构为统一存储门面 StorageService 的代理层，
 * 支持在不改动既有业务代码的情况下，无缝切换阿里云 OSS 与本地 RustFS。
 */
@Injectable()
export class RustfsService implements StorageDriver {
  constructor(private readonly storageService: StorageService) {}

  isEnabled(): boolean {
    return this.storageService.isEnabled();
  }

  uploadBytes(
    bytes: Buffer | Uint8Array,
    options: UploadBytesOptions,
  ): Promise<UploadBytesResult> {
    return this.storageService.uploadBytes(bytes, options);
  }

  getActiveDriverName(): string {
    return this.storageService.getActiveDriverName();
  }
}
