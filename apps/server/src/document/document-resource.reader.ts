import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { decryptResource } from '../storage/resource-crypto.js';
import type { StorageDriverType } from '../storage/storage.service.js';
import { DocumentResourceEntity } from './entities/document-resource.entity.js';

/** 源文件资源在 kh_document_resource 中的伪路径 */
export const SOURCE_RESOURCE_PATH = '$source';

type ResourceStorage = {
  readBytes(
    key: string,
    maxBytes: number,
    driver?: StorageDriverType,
  ): Promise<Buffer>;
};

export type LoadedDocumentResource = {
  bytes: Buffer;
  contentType: string;
  path: string;
};

/**
 * 读取文档私有资源并解密。
 *
 * 只负责「按文档 + 资源 ID 取字节」，不做任何 ACL 判断：
 * - 登录态读取由调用方先校验文档权限（DocumentImportService）；
 * - 公开分享由调用方先校验分享有效性与签名（DocumentShareService）。
 */
export async function readDocumentResource(
  em: EntityManager,
  storage: ResourceStorage,
  documentId: string,
  assetId: string | null,
  maxBytes: number,
): Promise<LoadedDocumentResource> {
  const resource = await em.findOneBy(
    DocumentResourceEntity,
    assetId
      ? { id: assetId, documentId, ready: true }
      : { documentId, path: SOURCE_RESOURCE_PATH, ready: true },
  );
  if (!resource || (assetId && resource.path === SOURCE_RESOURCE_PATH)) {
    throw new NotFoundException('文档资源不存在');
  }
  const bytes = decryptResource(
    await storage.readBytes(
      resource.objectKey,
      Math.min(maxBytes, resource.byteLength) + 128,
      resource.driver,
    ),
    resource.encryptionKey,
  );
  return { bytes, contentType: resource.contentType, path: resource.path };
}
