/**
 * 对象存储配置选项
 */
export interface UploadBytesOptions {
  fileName: string;
  contentType: string;
  /** 对象 key 前缀，默认 documents */
  prefix?: string;
}

/**
 * 对象存储上传响应结果
 */
export interface UploadBytesResult {
  /** 访问直链 URL（供前端直连、渲染或下载） */
  url: string;
  /** 对象 Key（供预签名、对象管理或溯源） */
  key: string;
}

/**
 * 对象存储底层驱动抽象契约
 */
export interface StorageDriver {
  /** 当前驱动是否已启用且配置完整 */
  isEnabled(): boolean;

  /**
   * 上传二进制数据，返回对象的访问直链与对象 Key
   */
  uploadBytes(
    bytes: Buffer | Uint8Array,
    options: UploadBytesOptions,
  ): Promise<UploadBytesResult>;
}
