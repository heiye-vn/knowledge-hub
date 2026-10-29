import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { compare, hash } from 'bcryptjs';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  accessFromUser,
  canReadDocument,
  canWriteDocument,
} from './document-access.js';
import { DocumentStatus } from './document-status.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentContentEntity } from './entities/document-content.entity.js';
import { DocumentShareEntity } from './entities/document-share.entity.js';
import { readDocumentResource } from './document-resource.reader.js';
import { AccessShareDto, CreateShareDto } from './dto/social.dto.js';

/** 分享资源读取上限，与导入单文件上限保持一致 */
const MAX_SHARE_ASSET_BYTES = 50 * 1024 * 1024;

export type ShareView = {
  id: string;
  documentId: string;
  code: string;
  needPassword: boolean;
  expireAt: Date | null;
  createdAt: Date;
  expired: boolean;
};

/**
 * 文档分享链接。
 *
 * 【与基线实现的差异】创建时必须校验写权限：基线只校验"可读"，
 * 任何能读到团队文档的人都能生成公开链接，而列表/撤销又只允许作者——
 * 既造成越权外泄，也让创建者自己无法收回链接。
 *
 * 带密码的链接在预览阶段不返回标题，避免未验密就泄露文档主题。
 * 验密成功后正文中的私有图片会重写为短期 HMAC 签名 URL，
 * 公开分享页无需登录也能加载图片。
 */
@Injectable()
export class DocumentShareService {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  async create(
    documentId: string,
    dto: CreateShareDto,
    user: AuthUser,
  ): Promise<ShareView> {
    const doc = await this.requireWritableShareable(documentId, user);
    const password = dto.password?.trim();
    const expireAt = dto.expireDays
      ? new Date(Date.now() + dto.expireDays * 24 * 60 * 60 * 1000)
      : null;
    const row = await this.em.save(
      this.em.create(DocumentShareEntity, {
        id: nextSnowflakeId(),
        documentId: doc.id,
        token: await this.newCode(),
        requirePassword: Boolean(password),
        passwordHash: password ? await hash(password, 10) : null,
        expireAt,
        createBy: user.userId,
        revoked: false,
      }),
    );
    return this.toView(row);
  }

  async list(documentId: string, user: AuthUser): Promise<ShareView[]> {
    const doc = await this.requireReadable(documentId, user);
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以管理分享');
    }
    const rows = await this.em.find(DocumentShareEntity, {
      where: { documentId, revoked: false },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => this.toView(row));
  }

  async revoke(documentId: string, shareId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以关闭分享');
    }
    const row = await this.em.findOne(DocumentShareEntity, {
      where: { id: shareId, documentId, revoked: false },
    });
    if (!row) throw new NotFoundException('分享不存在');
    row.revoked = true;
    await this.em.save(row);
    return { id: shareId };
  }

  /** 公开预览：带密码的链接只告知"要密码"和过期时间，不泄露标题 */
  async preview(code: string) {
    const { row, doc } = await this.findActive(code);
    return {
      code: row.token,
      title: row.passwordHash ? null : doc.title,
      needPassword: Boolean(row.passwordHash),
      expireAt: row.expireAt ?? null,
    };
  }

  /** 公开访问：验密后返回正文，不要求登录；私有图片重写为签名 URL */
  async access(code: string, dto: AccessShareDto, ip = 'unknown') {
    const { row, doc } = await this.findActive(code);
    if (row.passwordHash) {
      await this.assertAttemptAllowed(code, ip);
      const password = dto.password?.trim() ?? '';
      if (!password || !(await compare(password, row.passwordHash))) {
        await this.recordFailure(code, ip);
        throw new ForbiddenException('分享密码不正确');
      }
      await this.redis.del(this.attemptKey(code, ip));
    }
    const content = await this.em.findOne(DocumentContentEntity, {
      where: { documentId: doc.id, deleted: false },
    });
    return {
      title: doc.title,
      summary: doc.summary ?? null,
      content: this.signContentImages(content?.content ?? '', code, doc.id),
      expireAt: row.expireAt ?? null,
    };
  }

  /**
   * 读取分享正文引用的私有图片。
   *
   * 校验顺序：分享仍有效（未关闭/未过期/文档已发布）→ 签名未过期且匹配 →
   * 资源确属该文档。签名只由 access 验密成功后签发，带密码链接不会提前泄露图片。
   */
  async readSharedAsset(
    code: string,
    assetId: string,
    exp: string,
    sig: string,
  ): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    if (!/^\d+$/.test(exp) || Number(exp) <= Math.floor(Date.now() / 1000)) {
      throw new BadRequestException('资源签名已过期');
    }
    const { doc } = await this.findActive(code);
    const expected = this.signAsset(code, assetId, exp);
    const provided = Buffer.from(sig, 'hex');
    if (
      provided.length !== expected.length / 2 ||
      !timingSafeEqual(Buffer.from(expected, 'hex'), provided)
    ) {
      throw new ForbiddenException('资源签名无效');
    }
    const resource = await readDocumentResource(
      this.em,
      this.storage,
      doc.id,
      assetId,
      MAX_SHARE_ASSET_BYTES,
    );
    return {
      bytes: resource.bytes,
      contentType: resource.contentType,
      fileName: resource.path.split('/').pop()!,
    };
  }

  private async findActive(code: string) {
    const row = await this.em.findOne(DocumentShareEntity, {
      where: { token: code, revoked: false },
    });
    if (!row) throw new NotFoundException('分享链接不存在或已关闭');
    if (row.expireAt && row.expireAt.getTime() < Date.now()) {
      throw new BadRequestException('分享链接已过期');
    }
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: row.documentId, deleted: false },
    });
    if (!doc || doc.status !== DocumentStatus.Published) {
      throw new NotFoundException('文档未发布，分享暂不可用');
    }
    return { row, doc };
  }

  private toView(row: DocumentShareEntity): ShareView {
    return {
      id: row.id,
      documentId: row.documentId,
      code: row.token,
      needPassword: Boolean(row.passwordHash),
      expireAt: row.expireAt ?? null,
      createdAt: row.createdAt,
      expired: Boolean(row.expireAt && row.expireAt.getTime() < Date.now()),
    };
  }

  private async newCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = randomBytes(9).toString('base64url').slice(0, 12);
      const exists = await this.em.findOne(DocumentShareEntity, {
        where: { token },
      });
      if (!exists) return token;
    }
    throw new BadRequestException('生成分享码失败，请重试');
  }

  /** 分享只允许作者/管理员，且必须是已发布文档 */
  private async requireWritableShareable(documentId: string, user: AuthUser) {
    const doc = await this.requireReadable(documentId, user);
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以创建分享');
    }
    if (doc.status !== DocumentStatus.Published) {
      throw new BadRequestException('只有已发布的文档可以分享');
    }
    return doc;
  }

  private async requireReadable(documentId: string, user: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: documentId, deleted: false },
    });
    if (!doc) throw new NotFoundException('文档不存在');
    if (!canReadDocument(doc, accessFromUser(user))) {
      throw new ForbiddenException('无权查看该文档');
    }
    return doc;
  }

  private assetSecret(): string {
    const secret =
      this.config.get<string>('SHARE_ASSET_SECRET') ||
      this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret');
    if (!secret) {
      throw new ServiceUnavailableException('分享资源签名密钥未配置');
    }
    return secret;
  }

  private assetTtlSeconds(): number {
    const value = Number(this.config.get('SHARE_ASSET_TTL_SECONDS', 900));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 900;
  }

  private signAsset(code: string, assetId: string, exp: string): string {
    return createHmac('sha256', this.assetSecret())
      .update(`${code}:${assetId}:${exp}`)
      .digest('hex');
  }

  /** 把 /documents/:id/assets/:assetId 重写为短期签名 URL，同一资源只签一次 */
  private signContentImages(content: string, code: string, documentId: string) {
    if (!content.includes('/assets/')) return content;
    const exp = String(Math.floor(Date.now() / 1000) + this.assetTtlSeconds());
    const signed = new Map<string, string>();
    const pattern = new RegExp(`/documents/${documentId}/assets/(\\d+)`, 'g');
    return content.replace(pattern, (_match, assetId: string) => {
      let url = signed.get(assetId);
      if (!url) {
        url = `/shares/${code}/assets/${assetId}?exp=${exp}&sig=${this.signAsset(code, assetId, exp)}`;
        signed.set(assetId, url);
      }
      return url;
    });
  }

  private attemptKey(code: string, ip: string) {
    return `kh:share:pwd:${code}:${ip}`;
  }

  private maxAttempts(): number {
    const value = Number(this.config.get('SHARE_MAX_ATTEMPTS', 10));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
  }

  private attemptWindowSeconds(): number {
    const value = Number(this.config.get('SHARE_ATTEMPT_WINDOW_SECONDS', 600));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 600;
  }

  /**
   * 密码链接的失败次数检查。
   * 验证类能力按项目铁律 fail-closed：Redis 不可用时直接 503，而不是放行爆破。
   */
  private async assertAttemptAllowed(code: string, ip: string) {
    const count = Number(
      (await this.redis.get(this.attemptKey(code, ip))) ?? 0,
    );
    if (count >= this.maxAttempts()) {
      throw new HttpException('分享密码尝试过于频繁，请稍后再试', 429);
    }
  }

  private async recordFailure(code: string, ip: string) {
    await this.redis.incrementWithTtl(
      this.attemptKey(code, ip),
      this.attemptWindowSeconds(),
    );
  }
}
