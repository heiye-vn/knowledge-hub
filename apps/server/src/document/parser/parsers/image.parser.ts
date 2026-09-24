import { BadRequestException, Logger } from '@nestjs/common';
import { cleanMarkdown } from '../utils/markdown.util.js';

const logger = new Logger('ImageParser');

export interface VlmParserOptions {
  /** 视觉模型专用 API Key（强制要求传入，若未配置则抛错，绝不回退到其他 Key） */
  apiKey?: string;
  /** 视觉模型名称，默认 qwen3.8-flash */
  model?: string;
  /** 兼容端点 Base URL，默认 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl?: string;
  /** 请求超时时间（毫秒），默认 60000 */
  timeoutMs?: number;
}

/** 扩展名到 MIME 类型的映射 */
const EXTENSION_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const SYSTEM_PROMPT = `你是一个专业的多模态文档解析与图表理解引擎。请阅读图片内容并直接输出清晰规范的 Markdown 文本：
1. 【文档与截图】：逐字准确识别并保留段落排版，标题使用 Markdown # 层级；
2. 【表格】：必须还原为标准 GitHub Flavored Markdown (GFM) 表格 (| 列1 | 列2 |)；
3. 【公式】：行内公式用 $...$，独立公式块用 $$...$$；
4. 【架构图/时序图/流程图】：先简述组件关系与数据流向，并尽量输出等效的 \`\`\`mermaid 代码块；
5. 【插图/照片】：在末尾附上简短客观的视觉语义总结 (Visual Summary)；
6. 严禁无意义的客套话或前缀声明，直接输出最终 Markdown 内容。`;

/**
 * 将图片 Buffer 通过视觉大模型 (VLM) 解析为 Markdown。
 *
 * 采用兼容 OpenAI Vision 格式的 Base64 Payload 进行端到端解析，
 * 免去公网 URL 依赖与内网访问壁垒。
 */
export async function parseImageWithVlm(
  buffer: Buffer,
  extension: string,
  options: VlmParserOptions = {},
): Promise<string> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new BadRequestException(
      '未配置视觉模型 API 密钥 (VLM_API_KEY)，无法解析图片。请在环境变量中设置 VLM_API_KEY。',
    );
  }

  if (!buffer || buffer.length === 0) {
    throw new BadRequestException('图片内容为空，无法解析');
  }

  const normalizedExt = extension?.toLowerCase().replace(/^\./, '');
  const mimeType = EXTENSION_MIME_MAP[normalizedExt];
  if (!mimeType) {
    throw new BadRequestException(
      `不支持的图片格式: ${extension || '(无扩展名)'}，支持的图片格式: png, jpg, jpeg, webp`,
    );
  }

  const model = options.model || 'qwen3.8-flash';
  const baseUrl = (
    options.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  ).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60000;

  const base64Data = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const requestUrl = `${baseUrl}/chat/completions`;
  const requestBody = {
    model,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请解析此图片并输出结构化 Markdown：',
          },
          {
            type: 'image_url',
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
  };

  const start = Date.now();
  let response: Response;

  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`视觉大模型网络请求异常: ${errorMsg}`);
    throw new BadRequestException(`视觉模型请求失败: ${errorMsg}`);
  }

  if (!response.ok) {
    let errDetail = '';
    try {
      errDetail = await response.text();
    } catch {
      // 忽略读取错误体的异常
    }
    const msg = `视觉模型调用失败: ${response.status} ${response.statusText}${errDetail ? ` - ${errDetail}` : ''}`;
    logger.error(msg);
    throw new BadRequestException(msg);
  }

  interface ChatCompletionResponse {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  }

  let resData: ChatCompletionResponse;
  try {
    resData = (await response.json()) as ChatCompletionResponse;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new BadRequestException(`视觉模型响应 JSON 解析失败: ${errorMsg}`);
  }

  const rawContent = resData?.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    throw new BadRequestException('视觉模型解析结果为空，请确认图片清晰度与内容');
  }

  const elapsed = Date.now() - start;
  logger.log(
    `图片视觉解析成功: model=${model}, chars=${rawContent.length}, elapsed=${elapsed}ms`,
  );

  return cleanMarkdown(rawContent);
}
