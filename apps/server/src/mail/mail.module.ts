import { Module } from '@nestjs/common';
import { MailService } from './mail.service.js';

/** 邮件模块：SMTP 发送能力，供验证类流程（激活 / 重置密码）使用 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
