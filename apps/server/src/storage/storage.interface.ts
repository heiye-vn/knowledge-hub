/**
 * 对象存储配置选项
 */
export interface UploadBytesOptions {
  fileName: string;
  contentType: string;
  /** 对象 key 前缀，默认 documents */
  prefix?: string;
  /** 服务端预分配的安全相对 key；未提供时保持原有自动生成规则。 */
  objectKey?: string;
}

/**
 * 对象存储上传响应结果
 */
export interface UploadBytesResult {
  /** 对象直链；加密资源不可用此地址直接查看明文。 */
  url: string;
  /** 对象 Key（供服务端对象管理或溯源） */
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

  /** 读取服务端管理的对象；响应头和实际字节数均受 maxBytes 限制。 */
  readBytes(key: string, maxBytes: number): Promise<Buffer>;

  /** 删除服务端管理的对象。 */
  deleteObject(key: string): Promise<void>;
}
