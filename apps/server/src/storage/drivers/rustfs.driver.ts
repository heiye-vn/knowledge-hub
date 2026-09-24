import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
 * 本地 RustFS 存储驱动（S3 兼容，支持本地 Docker 离线运行）
 */
@Injectable()
export class RustfsDriver implements StorageDriver, OnModuleInit {
  private readonly logger = new Logger(RustfsDriver.name);
  private client: S3Client | null = null;
  private enabled = false;
  private bucket = '';
  private publicBaseUrl = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.enabled =
      this.config.get<string>('RUSTFS_ENABLED', 'true').toLowerCase() !==
      'false';

    if (!this.enabled) {
      this.logger.warn('RustFS 驱动已禁用（RUSTFS_ENABLED=false）');
      return;
    }

    const endpoint = this.config.get<string>(
      'RUSTFS_ENDPOINT',
      'http://localhost:9000',
    );
    const accessKey = this.config.get<string>(
      'RUSTFS_ACCESS_KEY',
      'rustfsadmin',
    );
    const secretKey = this.config.get<string>(
      'RUSTFS_SECRET_KEY',
      'rustfsadmin',
    );
    const region = this.config.get<string>('RUSTFS_REGION', 'us-east-1');
    this.bucket = this.config.get<string>('RUSTFS_BUCKET', 'knowledge-hub');
    this.publicBaseUrl = (
      this.config.get<string>('RUSTFS_PUBLIC_URL') || endpoint
    ).replace(/\/$/, '');

    this.client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true,
    });

    this.logger.log(
      `RustFS 驱动已就绪: endpoint=${endpoint}, bucket=${this.bucket}, public=${this.publicBaseUrl}`,
    );

    void this.ensureBucket().catch((err) => {
      this.logger.warn(
        `RustFS 初始化 bucket 失败（首次上传时会重试）: ${err instanceof Error ? err.message : err}`,
      );
    });
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
        'RustFS 未启用或未配置，无法上传文件',
      );
    }

    await this.ensureBucket();

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

    const url = `${this.publicBaseUrl}/${this.bucket}/${key}`;
    this.logger.log(
      `RustFS 上传成功: key=${key}, size=${body.length}, url=${url}`,
    );
    return { url, key };
  }

  private async ensureBucket(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // bucket 不存在则创建
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`RustFS bucket 已创建: ${this.bucket}`);
    } catch (err) {
      // 并发创建时可能已存在
      const message = err instanceof Error ? err.message : String(err);
      if (
        !/BucketAlreadyOwnedByYou|BucketAlreadyExists|already exists/i.test(
          message,
        )
      ) {
        throw err;
      }
    }
  }
}
