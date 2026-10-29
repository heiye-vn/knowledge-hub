import {
  Body,
  Controller,
  Get,
  Header,
  Ip,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { DocumentShareService } from './document-share.service.js';
import { AccessShareDto } from './dto/social.dto.js';
import { ShareAssetParams, ShareAssetQuery } from './dto/share-asset.dto.js';

/** 分享链接对外访问：不登录也能打开，密码由链接自身控制 */
@Controller('shares')
export class ShareController {
  constructor(private readonly shares: DocumentShareService) {}

  @Public()
  @Get(':code')
  preview(@Param('code') code: string) {
    return this.shares.preview(code);
  }

  @Public()
  @Post(':code/access')
  access(
    @Param('code') code: string,
    @Body() dto: AccessShareDto,
    @Ip() ip: string,
  ) {
    return this.shares.access(code, dto, ip);
  }

  /** 分享正文里的私有图片：验签后解密返回，不要求登录 */
  @Public()
  @Get(':code/assets/:assetId')
  @Header('Cache-Control', 'private, max-age=300')
  @Header('X-Content-Type-Options', 'nosniff')
  async asset(
    @Param() params: ShareAssetParams,
    @Query() query: ShareAssetQuery,
  ) {
    const resource = await this.shares.readSharedAsset(
      params.code,
      params.assetId,
      query.exp,
      query.sig,
    );
    return new StreamableFile(resource.bytes, {
      type: resource.contentType,
      length: resource.bytes.length,
      disposition: 'inline',
    });
  }
}
