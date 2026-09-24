import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseImageWithVlm } from './image.parser.js';

describe('image.parser (离线 Mock 纯单测，0 Token 消耗)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('未提供 apiKey 时立即抛出明确异常，绝不静默使用其他 Key', async () => {
    const fakeBuffer = Buffer.from('fake-png-content');
    await expect(
      parseImageWithVlm(fakeBuffer, 'png', { apiKey: '' }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      parseImageWithVlm(fakeBuffer, 'png', { apiKey: undefined }),
    ).rejects.toThrow(/未配置视觉模型 API 密钥 \(VLM_API_KEY\)/);
  });

  it('空 buffer 时抛出明确异常', async () => {
    await expect(
      parseImageWithVlm(Buffer.alloc(0), 'png', { apiKey: 'sk-vlm-test' }),
    ).rejects.toThrow(/图片内容为空/);
  });

  it('不支持的图片扩展名抛出异常', async () => {
    const fakeBuffer = Buffer.from('fake-bmp-content');
    await expect(
      parseImageWithVlm(fakeBuffer, 'bmp', { apiKey: 'sk-vlm-test' }),
    ).rejects.toThrow(/不支持的图片格式/);
  });

  it('正常图片能正确转换 Base64 并调用兼容 OpenAI Vision 格式的端点', async () => {
    const fakeBuffer = Buffer.from('hello-image');
    const expectedBase64 = fakeBuffer.toString('base64');
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '# 架构图\n\n这是解析出来的 Markdown 说明。',
              },
            },
          ],
        }),
      } as unknown as Response;
    });

    const result = await parseImageWithVlm(fakeBuffer, 'png', {
      apiKey: 'sk-vlm-test',
      model: 'qwen3.8-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });

    expect(result).toBe('# 架构图\n\n这是解析出来的 Markdown 说明。');
    expect(capturedUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(capturedOptions?.headers).toMatchObject({
      Authorization: 'Bearer sk-vlm-test',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(capturedOptions?.body as string);
    expect(body.model).toBe('qwen3.8-flash');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');

    const userContent = body.messages[1].content;
    expect(userContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${expectedBase64}`,
          },
        }),
      ]),
    );
  });

  it('支持 jpg、jpeg、webp 并映射正确的 MIME 类型', async () => {
    const fakeBuffer = Buffer.from('sample-bytes');
    const testedMimes: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options?.body as string);
      const imgObj = body.messages[1].content.find(
        (c: { type: string }) => c.type === 'image_url',
      );
      testedMimes.push(imgObj.image_url.url.split(';')[0]);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '解析成功' } }],
        }),
      } as unknown as Response;
    });

    await parseImageWithVlm(fakeBuffer, 'jpg', { apiKey: 'sk-vlm-test' });
    await parseImageWithVlm(fakeBuffer, 'jpeg', { apiKey: 'sk-vlm-test' });
    await parseImageWithVlm(fakeBuffer, 'webp', { apiKey: 'sk-vlm-test' });

    expect(testedMimes).toEqual([
      'data:image/jpeg',
      'data:image/jpeg',
      'data:image/webp',
    ]);
  });

  it('远端 HTTP 报错（如 401 Unauthorized）时抛出友好异常', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API-key provided',
    } as unknown as Response);

    await expect(
      parseImageWithVlm(Buffer.from('test'), 'png', {
        apiKey: 'invalid-key',
      }),
    ).rejects.toThrow(/视觉模型调用失败: 401 Unauthorized/);
  });

  it('远端返回空内容时抛出友好异常', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response);

    await expect(
      parseImageWithVlm(Buffer.from('test'), 'png', {
        apiKey: 'sk-test',
      }),
    ).rejects.toThrow(/视觉模型解析结果为空/);
  });
});
