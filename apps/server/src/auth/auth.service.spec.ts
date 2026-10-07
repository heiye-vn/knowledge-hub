import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { hashSync } from 'bcryptjs';
import { AuthService } from './auth.service.js';

/**
 * 认证服务单测（全 fake，覆盖本轮新增流程）
 *
 * - 注册：邮箱验证开关开/关两条路径；开关开时发信失败回滚 token
 * - 激活：consumeToken 无效 → 400；有效 → 落库
 * - 重置密码：邮箱未注册 → 400；冷却中 → 400；发信失败回滚验证码
 */

function fakeConfig(values: Record<string, string> = {}) {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as never;
}

function makeService(over: {
  config?: Record<string, string>;
  userService?: Record<string, unknown>;
  mail?: Record<string, unknown>;
  activation?: Record<string, unknown>;
  reset?: Record<string, unknown>;
}) {
  const activation = {
    createToken: vi.fn(async () => 'token-1'),
    consumeToken: vi.fn(async () => null as string | null),
    deleteByToken: vi.fn(async () => undefined),
    getTtlByUser: vi.fn(async () => -1),
    ...over.activation,
  };
  const reset = {
    getTtl: vi.fn(async () => -1),
    set: vi.fn(async () => undefined),
    verify: vi.fn(async () => false),
    delete: vi.fn(async () => undefined),
    ...over.reset,
  };
  const mail = {
    sendActivationEmail: vi.fn(async () => undefined),
    sendResetCodeEmail: vi.fn(async () => undefined),
    ...over.mail,
  };
  const userService = {
    register: vi.fn(async () => ({
      userId: 'u1',
      emailVerificationRequired: false,
    })),
    activateEmail: vi.fn(async () => '邮箱验证成功，请登录'),
    findByEmail: vi.fn(async () => null as unknown),
    findByUsername: vi.fn(async () => null as unknown),
    findByIdOrThrow: vi.fn(async () => null as unknown),
    resetPasswordByEmail: vi.fn(async () => undefined),
    ...over.userService,
  };
  const revocation = {
    isRevoked: vi.fn(async () => false),
    revoke: vi.fn(async () => undefined),
  };
  const jwt = { sign: vi.fn(() => 'jwt'), verifyAsync: vi.fn() };

  const service = new AuthService(
    userService as never,
    jwt as never,
    fakeConfig(over.config ?? {}),
    revocation as never,
    mail as never,
    activation as never,
    reset as never,
  );
  return { service, activation, reset, mail, userService };
}

describe('AuthService.register（邮箱验证开关）', () => {
  it('开关关闭：注册即启用，不发激活邮件', async () => {
    const { service, mail, userService } = makeService({
      config: { REQUIRE_EMAIL_VERIFICATION: 'false' },
    });

    const result = await service.register({
      username: 'tom',
      password: '123456',
      email: 'tom@x.com',
    });

    expect(result.emailVerificationRequired).toBe(false);
    expect(userService.register).toHaveBeenCalledWith(
      expect.objectContaining({ requireEmailVerification: false }),
    );
    expect(mail.sendActivationEmail).not.toHaveBeenCalled();
  });

  it('开关打开：写未验证状态 → 建 token → 发激活邮件', async () => {
    const { service, mail, activation } = makeService({
      config: { REQUIRE_EMAIL_VERIFICATION: 'true' },
      userService: {
        register: vi.fn(async () => ({
          userId: 'u1',
          emailVerificationRequired: true,
        })),
      },
    });

    const result = await service.register({
      username: 'tom',
      password: '123456',
      email: 'tom@x.com',
    });

    expect(result.emailVerificationRequired).toBe(true);
    expect(activation.createToken).toHaveBeenCalledWith('u1');
    expect(mail.sendActivationEmail).toHaveBeenCalledWith(
      'tom@x.com',
      'tom',
      'token-1',
    );
  });

  it('开关打开但发信失败：回滚 token 并抛 400', async () => {
    const { service, activation } = makeService({
      config: { REQUIRE_EMAIL_VERIFICATION: 'true' },
      userService: {
        register: vi.fn(async () => ({
          userId: 'u1',
          emailVerificationRequired: true,
        })),
      },
      mail: {
        sendActivationEmail: vi.fn(async () => {
          throw new Error('SMTP down');
        }),
      },
    });

    await expect(
      service.register({ username: 'tom', password: '123456', email: 'tom@x.com' }),
    ).rejects.toThrow(BadRequestException);
    expect(activation.deleteByToken).toHaveBeenCalledWith('token-1');
  });
});

describe('AuthService.resendActivation（TODO §8.2）', () => {
  /** 未激活 + 已绑邮箱的待激活账号，密码为明文 123456 */
  const pendingUser = {
    id: 'u1',
    username: 'tom',
    email: 'tom@x.com',
    emailVerified: 0,
    status: 1,
    password: hashSync('123456', 4),
  };

  it('用户名或密码错误 → 401，不建 token', async () => {
    const { service, activation } = makeService({
      userService: { findByUsername: vi.fn(async () => pendingUser) },
    });
    await expect(
      service.resendActivation({ username: 'tom', password: 'wrong' }),
    ).rejects.toThrow('用户名或密码错误');
    expect(activation.createToken).not.toHaveBeenCalled();
  });

  it('账号不存在 → 401（不泄露账号是否存在）', async () => {
    const { service } = makeService({});
    await expect(
      service.resendActivation({ username: 'ghost', password: '123456' }),
    ).rejects.toThrow('用户名或密码错误');
  });

  it('账号已激活 → 400，不重复发信', async () => {
    const { service, mail } = makeService({
      userService: {
        findByUsername: vi.fn(async () => ({ ...pendingUser, emailVerified: 1 })),
      },
    });
    await expect(
      service.resendActivation({ username: 'tom', password: '123456' }),
    ).rejects.toThrow('账号已激活');
    expect(mail.sendActivationEmail).not.toHaveBeenCalled();
  });

  it('账号未绑定邮箱 → 400', async () => {
    const { service } = makeService({
      userService: {
        findByUsername: vi.fn(async () => ({ ...pendingUser, email: null })),
      },
    });
    await expect(
      service.resendActivation({ username: 'tom', password: '123456' }),
    ).rejects.toThrow('账号未绑定邮箱');
  });

  it('冷却中（TTL 反推）→ 400，不重复发信', async () => {
    const { service, mail } = makeService({
      userService: { findByUsername: vi.fn(async () => pendingUser) },
      activation: { getTtlByUser: vi.fn(async () => 24 * 3600 - 10) },
    });
    await expect(
      service.resendActivation({ username: 'tom', password: '123456' }),
    ).rejects.toThrow('激活邮件已发送');
    expect(mail.sendActivationEmail).not.toHaveBeenCalled();
  });

  it('正常重发 → 建 token 并发送激活邮件', async () => {
    const { service, activation, mail } = makeService({
      userService: { findByUsername: vi.fn(async () => pendingUser) },
    });
    const result = await service.resendActivation({
      username: 'tom',
      password: '123456',
    });
    expect(result.message).toContain('已发送');
    expect(activation.createToken).toHaveBeenCalledWith('u1');
    expect(mail.sendActivationEmail).toHaveBeenCalledWith(
      'tom@x.com',
      'tom',
      'token-1',
    );
  });

  it('发信失败 → 回滚 token，不留下点不开的激活链接', async () => {
    const { service, activation } = makeService({
      userService: { findByUsername: vi.fn(async () => pendingUser) },
      mail: { sendActivationEmail: vi.fn(async () => { throw new Error('smtp down'); }) },
    });
    await expect(
      service.resendActivation({ username: 'tom', password: '123456' }),
    ).rejects.toThrow('激活邮件发送失败');
    expect(activation.deleteByToken).toHaveBeenCalledWith('token-1');
  });
});

describe('AuthService.resendActivationForUser（管理员代发）', () => {
  it('跳过密码与冷却，按 userId 定向重发', async () => {
    const { service, activation, mail } = makeService({
      userService: {
        findByIdOrThrow: vi.fn(async () => ({
          id: 'u9',
          username: 'jerry',
          email: 'jerry@x.com',
          emailVerified: 0,
          status: 1,
        })),
      },
      activation: { getTtlByUser: vi.fn(async () => 24 * 3600 - 10) },
    });

    const result = await service.resendActivationForUser('u9');
    expect(result.message).toContain('已发送');
    expect(activation.createToken).toHaveBeenCalledWith('u9');
    expect(mail.sendActivationEmail).toHaveBeenCalled();
  });
});

describe('AuthService.verifyEmail', () => {
  it('token 无效 → 400', async () => {
    const { service } = makeService({});
    await expect(service.verifyEmail('bad')).rejects.toThrow(
      '激活链接无效或已过期',
    );
  });

  it('token 有效 → 激活落库并返回成功', async () => {
    const { service, userService } = makeService({
      activation: { consumeToken: vi.fn(async () => 'u1') },
    });
    const result = await service.verifyEmail('ok-token');
    expect(result.message).toContain('成功');
    expect(userService.activateEmail).toHaveBeenCalledWith('u1');
  });
});

describe('AuthService.sendResetCode（冷却与回滚）', () => {
  it('邮箱未注册 → 400', async () => {
    const { service } = makeService({});
    await expect(
      service.sendResetCode({ email: 'nobody@x.com' }),
    ).rejects.toThrow('该邮箱未注册');
  });

  it('冷却中（TTL 反推）→ 400，不重复发码', async () => {
    const { service, reset } = makeService({
      userService: { findByEmail: vi.fn(async () => ({ username: 'tom' })) },
      reset: { getTtl: vi.fn(async () => 590) },
    });
    await expect(
      service.sendResetCode({ email: 'tom@x.com' }),
    ).rejects.toThrow('验证码已发送');
    expect(reset.set).not.toHaveBeenCalled();
  });

  it('发信失败：删除已写入的验证码并抛 400', async () => {
    const { service, reset } = makeService({
      userService: { findByEmail: vi.fn(async () => ({ username: 'tom' })) },
      mail: {
        sendResetCodeEmail: vi.fn(async () => {
          throw new Error('SMTP down');
        }),
      },
    });
    await expect(
      service.sendResetCode({ email: 'tom@x.com' }),
    ).rejects.toThrow(BadRequestException);
    expect(reset.delete).toHaveBeenCalledWith('tom@x.com');
  });

  it('正常路径：写验证码并发信', async () => {
    const { service, reset, mail } = makeService({
      userService: { findByEmail: vi.fn(async () => ({ username: 'tom' })) },
    });
    const result = await service.sendResetCode({ email: 'tom@x.com' });
    expect(result.message).toBe('验证码已发送');
    expect(reset.set).toHaveBeenCalledWith(
      'tom@x.com',
      expect.stringMatching(/^\d{6}$/),
    );
    expect(mail.sendResetCodeEmail).toHaveBeenCalled();
  });
});

describe('AuthService.resetPasswordByEmail', () => {
  it('验证码错误 → 400，不改密', async () => {
    const { service, userService } = makeService({});
    await expect(
      service.resetPasswordByEmail({
        email: 'tom@x.com',
        code: '000000',
        newPassword: '654321',
      }),
    ).rejects.toThrow('验证码错误或已过期');
    expect(userService.resetPasswordByEmail).not.toHaveBeenCalled();
  });

  it('验证码正确 → 改密并删除验证码（一次性）', async () => {
    const { service, userService, reset } = makeService({
      reset: { verify: vi.fn(async () => true) },
    });
    const result = await service.resetPasswordByEmail({
      email: 'tom@x.com',
      code: '123456',
      newPassword: '654321',
    });
    expect(result.message).toContain('成功');
    expect(userService.resetPasswordByEmail).toHaveBeenCalledWith(
      'tom@x.com',
      '654321',
    );
    expect(reset.delete).toHaveBeenCalledWith('tom@x.com');
  });
});
