import { IsNumberString, IsString, Matches, MaxLength } from 'class-validator';

/** 分享资源路径参数 */
export class ShareAssetParams {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  code: string;

  @IsNumberString()
  @MaxLength(19)
  assetId: string;
}

/** 分享资源签名参数：exp 为秒级时间戳，sig 为 HMAC-SHA256 hex */
export class ShareAssetQuery {
  @IsNumberString()
  @MaxLength(12)
  exp: string;

  @Matches(/^[a-f0-9]{64}$/)
  sig: string;
}
