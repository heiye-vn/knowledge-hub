import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { DocumentSocialService } from './document-social.service.js';
import { DocumentShareService } from './document-share.service.js';
import { DocumentVersionService } from './document-version.service.js';
import { DocumentService } from './document.service.js';
import { CreateCommentDto, CreateShareDto } from './dto/social.dto.js';
import { QueryFavoritesDto } from './dto/query-favorites.dto.js';

/** 我的收藏 */
@Controller('favorites')
export class FavoriteController {
  constructor(private readonly social: DocumentSocialService) {}

  @Get()
  @RequirePermission('document:list')
  list(@CurrentUser() user: AuthUser, @Query() query: QueryFavoritesDto) {
    return this.social.listFavorites(
      user,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
  }
}

/**
 * 文档互动与历史版本。
 *
 * 点赞/收藏/评论：能看文档即可操作（document:list + 服务层可读校验）；
 * 分享与版本：作者/管理员专属（document:edit + 服务层写权限校验）。
 */
@Controller('documents')
export class DocumentEngagementController {
  constructor(
    private readonly social: DocumentSocialService,
    private readonly shares: DocumentShareService,
    private readonly versions: DocumentVersionService,
    private readonly documents: DocumentService,
  ) {}

  @Post(':id/likes')
  @RequirePermission('document:list')
  toggleLike(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.social.toggleLike(id, user);
  }

  @Post(':id/favorites')
  @RequirePermission('document:list')
  toggleFavorite(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.social.toggleFavorite(id, user);
  }

  @Get(':id/comments')
  @RequirePermission('document:list')
  comments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.social.listComments(id, user);
  }

  @Post(':id/comments')
  @RequirePermission('document:list')
  addComment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.social.addComment(id, dto, user);
  }

  @Delete(':id/comments/:commentId')
  @RequirePermission('document:list')
  removeComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.social.removeComment(id, commentId, user);
  }

  @Get(':id/shares')
  @RequirePermission('document:edit')
  listShares(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.shares.list(id, user);
  }

  @Post(':id/shares')
  @RequirePermission('document:edit')
  createShare(
    @Param('id') id: string,
    @Body() dto: CreateShareDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shares.create(id, dto, user);
  }

  @Delete(':id/shares/:shareId')
  @RequirePermission('document:edit')
  revokeShare(
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shares.revoke(id, shareId, user);
  }

  @Get(':id/versions')
  @RequirePermission('document:edit')
  listVersions(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.versions.list(id, user);
  }

  @Get(':id/versions/:versionId')
  @RequirePermission('document:edit')
  getVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versions.get(id, versionId, user);
  }

  @Post(':id/versions/:versionId/restore')
  @RequirePermission('document:edit')
  async restoreVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const version = await this.versions.get(id, versionId, user);
    return this.documents.update(
      id,
      {
        title: version.title,
        content: version.content,
        summary: version.summary ?? '',
      },
      user,
    );
  }
}
