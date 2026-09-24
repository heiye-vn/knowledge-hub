import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
} from '../storage.interface.js';
import { generateObjectKey } from '../storage.util.js';

/**
 * 阿里云 OSS 存储驱动（基于 AWS S3 兼容协议，零额外依赖，原生支持 Virtual-Hosted 格式）
 */
@Injectable()
export class AliyunOssDriver implements StorageDriver, OnModuleInit {
  private readonly logger = new Logger(AliyunOssDriver.name);
  private client: S3Client | null = null;
  private enabled = false;
  private bucket = '';
  private endpoint = '';
  private customDomain = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const isExplicitlyDisabled =
      this.config.get<string>('OSS_ENABLED', 'true').toLowerCase() === 'false';

    if (isExplicitlyDisabled) {
      this.logger.warn('阿里云 OSS 驱动已禁用（OSS_ENABLED=false）');
      this.enabled = false;
      return;
    }

    const accessKeyId = this.config.get<string>('OSS_ACCESS_KEY_ID')?.trim();
    const accessKeySecret = this.config
      .get<string>('OSS_ACCESS_KEY_SECRET')
      ?.trim();
    const bucket = this.config.get<string>('OSS_BUCKET')?.trim();
    const region =
      this.config.get<string>('OSS_REGION', 'oss-cn-hangzhou')?.trim() ||
      'oss-cn-hangzhou';

    if (!accessKeyId || !accessKeySecret || !bucket) {
      this.logger.warn(
        '阿里云 OSS 驱动未启用：缺少 OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET 或 OSS_BUCKET',
      );
      this.enabled = false;
      return;
    }

    this.bucket = bucket;

    // 自定义 Endpoint 或根据 Region 自动推导标准公网 Endpoint
    const rawEndpoint =
      this.config.get<string>('OSS_ENDPOINT')?.trim() ||
      `https://${region}.aliyuncs.com`;
    this.endpoint = rawEndpoint.startsWith('http')
      ? rawEndpoint
      : `https://${rawEndpoint}`;

    // 自定义 CDN 域名（可选）
    const rawCustomDomain = this.config
      .get<string>('OSS_CUSTOM_DOMAIN')
      ?.trim();
    if (rawCustomDomain) {
      this.customDomain = rawCustomDomain.replace(/\/+$/, '');
    }

    this.client = new S3Client({
      endpoint: this.endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey: accessKeySecret,
      },
      // 阿里云 OSS 标准公网访问采用 Virtual-Hosted 模式（bucket.oss-region.aliyuncs.com）
      forcePathStyle: false,
    });

    this.enabled = true;
    this.logger.log(
      `阿里云 OSS 驱动已就绪: bucket=${this.bucket}, endpoint=${this.endpoint}${
        this.customDomain ? `, customDomain=${this.customDomain}` : ''
      }`,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.client != null;
  }

  async uploadBytes(
    bytes: Buffer | Uint8Array,
    options: UploadBytesOptions,
  ): Promise<UploadBytesResult> {
    if (!this.isEnabled() || !this.client) {
      throw new ServiceUnavailableException(
        '阿里云 OSS 驱动未启用或未配置，无法上传文件',
      );
    }

    const key = generateObjectKey(
      options.fileName,
      options.contentType,
      options.prefix,
    );
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: body.length,
      }),
    );

    const url = this.buildObjectUrl(key);
    this.logger.log(
      `阿里云 OSS 上传成功: key=${key}, size=${body.length}, url=${url}`,
    );
    return { url, key };
  }

  /**
   * 构建公网访问直链
   * 1. 优先使用自定义 CDN 域名：https://cdn.example.com/{key}
   * 2. 否则使用阿里云官方 Virtual-Hosted 格式：https://{bucket}.{endpointHost}/{key}
   */
  private buildObjectUrl(key: string): string {
    if (this.customDomain) {
      return `${this.customDomain}/${key}`;
    }

    const endpointHost = this.endpoint.replace(/^https?:\/\//, '');
    return `https://${this.bucket}.${endpointHost}/${key}`;
  }
}
