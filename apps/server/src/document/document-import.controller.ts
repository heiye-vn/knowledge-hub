import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  ServiceUnavailableException,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsNumberString, MaxLength } from 'class-validator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { UploadParseDto } from './dto/upload-parse.dto.js';
import {
  DocumentImportService,
  MAX_IMPORT_BYTES,
} from './document-import.service.js';
import { DocumentImportQueue } from './document-import.queue.js';

class ImportIdParams {
  @IsNumberString()
  @MaxLength(19)
  id: string;
}

class ResourceParams extends ImportIdParams {
  @IsNumberString()
  @MaxLength(19)
  assetId: string;
}

@Controller('documents')
export class DocumentImportController {
  constructor(
    private readonly imports: DocumentImportService,
    private readonly queue: DocumentImportQueue,
  ) {}

  @Post('upload/parse')
  @HttpCode(202)
  @RequirePermission('document:create')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 12 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() metadata: UploadParseDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!this.queue.isReady())
      throw new ServiceUnavailableException('导入队列暂不可用，请稍后重试');
    const task = await this.imports.submit(file, metadata, user);
    void this.queue.dispatch();
    return task;
  }

  @Get('imports')
  @RequirePermission('document:create')
  list(@CurrentUser() user: AuthUser) {
    return this.imports.list(user);
  }

  @Get('imports/:id')
  @RequirePermission('document:create')
  get(@Param() params: ImportIdParams, @CurrentUser() user: AuthUser) {
    return this.imports.get(params.id, user);
  }

  @Post('imports/:id/retry')
  @HttpCode(202)
  @RequirePermission('document:create')
  async retry(@Param() params: ImportIdParams, @CurrentUser() user: AuthUser) {
    const task = await this.imports.retry(params.id, user);
    void this.queue.dispatch();
    return task;
  }

  /** 隐藏当前用户全部已完成/失败的导入记录（不删除文档与资源）。 */
  @Delete('imports')
  @RequirePermission('document:create')
  clear(@CurrentUser() user: AuthUser) {
    return this.imports.dismissFinished(user);
  }

  /** 从列表隐藏单条已结束的导入记录；进行中的任务返回 409。 */
  @Delete('imports/:id')
  @RequirePermission('document:create')
  dismiss(@Param() params: ImportIdParams, @CurrentUser() user: AuthUser) {
    return this.imports.dismiss(params.id, user);
  }

  @Get(':id/assets/:assetId')
  @RequirePermission('document:list')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async asset(@Param() params: ResourceParams, @CurrentUser() user: AuthUser) {
    const resource = await this.imports.readResource(
      params.id,
      params.assetId,
      user,
    );
    return new StreamableFile(resource.bytes, {
      type: resource.contentType,
      length: resource.bytes.length,
      disposition: 'inline',
    });
  }

  @Get(':id/source')
  @RequirePermission('document:list')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async source(@Param() params: ImportIdParams, @CurrentUser() user: AuthUser) {
    const resource = await this.imports.readResource(params.id, null, user);
    const fileName = resource.fileName.replace(/[\r\n"]/g, '_');
    return new StreamableFile(resource.bytes, {
      type: 'application/octet-stream',
      length: resource.bytes.length,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
  }
}
