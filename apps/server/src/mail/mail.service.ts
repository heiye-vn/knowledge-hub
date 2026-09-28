import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * 邮件发送服务（SMTP）。
 *
 * 用裸 nodemailer 而非 @nestjs-modules/mailer：少一层模板引擎抽象，
 * 本项目只有激活 / 验证码两类纯文本邮件，用不到那套能力。
 *
 * 降级：未配置 SMTP_HOST 时 isAvailable() 为 false，调用方决定策略——
 * 验证类流程（激活 / 重置密码）要求发信成功，发不出去必须失败回滚，绝不静默。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null = null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('SMTP_FROM', '');
    const host = this.config.get<string>('SMTP_HOST', '');
    if (!host) {
      this.logger.warn('未配置 SMTP_HOST，邮件发送不可用（验证类功能将失败）');
      return;
    }
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(this.config.get<string>('SMTP_PORT', '587')),
      secure: this.config.get<string>('SMTP_SECURE', 'false') === 'true',
      auth: {
        user: this.config.get<string>('SMTP_USER', ''),
        pass: this.config.get<string>('SMTP_PASS', ''),
      },
    });
  }

  isAvailable(): boolean {
    return this.transporter !== null;
  }

  /** 邮箱激活邮件：链接携带一次性 token（24h 有效，Redis 侧校验） */
  async sendActivationEmail(
    email: string,
    username: string,
    token: string,
  ): Promise<void> {
    const baseUrl = this.config.get<string>(
      'APP_PUBLIC_URL',
      'http://localhost:3000',
    );
    const url = `${baseUrl}/auth/verify-email?token=${token}`;
    await this.send(email, '请激活您的账户', [
      `${username}，您好：`,
      '',
      `请点击以下链接激活账户（24 小时内有效，仅可使用一次）：`,
      url,
      '',
      '若非本人注册，请忽略本邮件。',
    ].join('\n'));
  }

  /** 密码重置验证码邮件（10 分钟有效） */
  async sendResetCodeEmail(
    email: string,
    username: string,
    code: string,
  ): Promise<void> {
    await this.send(email, '密码重置验证码', [
      `${username}，您好：`,
      '',
      `您正在重置密码，验证码为：${code}`,
      '10 分钟内有效。若非本人操作，请忽略本邮件。',
    ].join('\n'));
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transporter) {
      throw new Error('邮件服务未配置（SMTP_HOST 为空）');
    }
    await this.transporter.sendMail({ from: this.from, to, subject, text });
  }
}
