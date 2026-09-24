import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  StorageDriver,
  UploadBytesOptions,
  UploadBytesResult,
} from './storage.interface.js';
import { RustfsDriver } from './drivers/rustfs.driver.js';
import { AliyunOssDriver } from './drivers/aliyun-oss.driver.js';

export type StorageDriverType = 'oss' | 'rustfs';

/**
 * 统一对象存储门面服务 (Storage Service Facade)
 *
 * 负责依据环境变量配置动态将上传与状态查询路由到对应的底层驱动：
 * - 阿里云 OSS (STORAGE_DRIVER=oss)
 * - 本地 RustFS (STORAGE_DRIVER=rustfs)
 */
@Injectable()
export class StorageService implements StorageDriver, OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private activeDriver: StorageDriver | null = null;
  private activeDriverName: StorageDriverType = 'rustfs';

  constructor(
    private readonly config: ConfigService,
    private readonly rustfsDriver: RustfsDriver,
    private readonly ossDriver: AliyunOssDriver,
  ) {}

  onModuleInit() {
    const rawDriver = this.config
      .get<string>('STORAGE_DRIVER')
      ?.toLowerCase()
      ?.trim();

    if (rawDriver === 'oss') {
      this.activeDriver = this.ossDriver;
      this.activeDriverName = 'oss';
    } else if (rawDriver === 'rustfs') {
      this.activeDriver = this.rustfsDriver;
      this.activeDriverName = 'rustfs';
    } else {
      // 未显式指定时：若阿里云 OSS 已配置并就绪，则优先使用 OSS；否则回退本地 RustFS
      if (this.ossDriver.isEnabled()) {
        this.activeDriver = this.ossDriver;
        this.activeDriverName = 'oss';
      } else {
        this.activeDriver = this.rustfsDriver;
        this.activeDriverName = 'rustfs';
      }
    }

    this.logger.log(
      `对象存储门面服务已就绪：当前激活驱动为 [${this.activeDriverName}]（状态：${
        this.activeDriver?.isEnabled() ? '已启用' : '未启用'
      }）`,
    );
  }

  /** 获取当前激活的存储驱动名称 ('oss' | 'rustfs') */
  getActiveDriverName(): StorageDriverType {
    return this.activeDriverName;
  }

  /** 当前激活的存储驱动是否可用 */
  isEnabled(): boolean {
    return this.activeDriver?.isEnabled() ?? false;
  }

  /** 上传字节流，返回 { url, key } */
  async uploadBytes(
    bytes: Buffer | Uint8Array,
    options: UploadBytesOptions,
  ): Promise<UploadBytesResult> {
    if (!this.activeDriver || !this.activeDriver.isEnabled()) {
      throw new ServiceUnavailableException(
        `对象存储驱动 [${this.activeDriverName}] 未就绪，无法上传文件`,
      );
    }
    return this.activeDriver.uploadBytes(bytes, options);
  }
}
