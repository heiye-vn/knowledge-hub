import { describe, expect, it } from 'vitest'
import {
  formatChatError,
  formatStepError,
  sanitizeTechnicalDetail,
} from './chat-error-utils'

describe('聊天模型错误友好化', () => {
  it('识别阿里云 DashScope + LangChain 401 API Key 认证失败', () => {
    const raw =
      '401 Incorrect API key provided. For details, see: https://help.aliyun.com/zh/model-studio/error-code#apikey-error Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/'
    const res = formatChatError(raw)

    expect(res.category).toBe('auth')
    expect(res.title).toBe('AI 模型认证失败')
    expect(res.description).toContain('API 密钥')
    expect(res.suggestion).toContain('管理员')
    expect(res.canRetry).toBe(false)
    expect(res.canFallbackRag).toBe(true)
    expect(res.technicalDetail).toContain('401 Incorrect API key')
  })

  it('识别未配置 LLM Key 提示', () => {
    const res = formatChatError('未配置 LLM Key，无法生成回答')
    expect(res.category).toBe('unconfigured')
    expect(res.title).toBe('AI 模型尚未配置')
    expect(res.canFallbackRag).toBe(true)
  })

  it('识别 429 限流并建议重新生成', () => {
    const res = formatChatError(new Error('429 Too Many Requests: Rate limit exceeded'))
    expect(res.category).toBe('rate_limit')
    expect(res.canRetry).toBe(true)
    expect(res.severity).toBe('warning')
  })

  it('识别 402 余额不足与欠费', () => {
    const res = formatChatError('402 Arrearage: account balance is insufficient')
    expect(res.category).toBe('quota')
    expect(res.canRetry).toBe(false)
    expect(res.canFallbackRag).toBe(true)
  })

  it('识别上下文长度超限并建议新开对话', () => {
    const res = formatChatError('400 maximum context length exceeded')
    expect(res.category).toBe('context_limit')
    expect(res.suggestion).toContain('新对话')
  })

  it('识别内容安全审核拦截', () => {
    const res = formatChatError('400 data_inspection_failed: Input data may contain inappropriate content')
    expect(res.category).toBe('content_filter')
    expect(res.title).toContain('安全审核')
  })

  it('识别超时与网络断开并允许重试', () => {
    expect(formatChatError('Request timed out after 60000ms')).toMatchObject({
      category: 'timeout',
      canRetry: true,
    })
    expect(formatChatError('TypeError: Failed to fetch')).toMatchObject({
      category: 'network',
      canRetry: true,
      canFallbackRag: false,
    })
  })

  it('识别上游 502/503 服务波动', () => {
    expect(formatChatError('503 Service Unavailable')).toMatchObject({
      category: 'server',
      canRetry: true,
      canFallbackRag: true,
    })
  })

  it('未知或空错误给出明确兜底', () => {
    const res = formatChatError('')
    expect(res.category).toBe('unknown')
    expect(res.title).toBe('智能回答生成失败')
    expect(res.technicalDetail).toBeUndefined()
  })

  it('对技术详情中的 API Key 与 Bearer 令牌脱敏', () => {
    const sanitized = sanitizeTechnicalDetail(
      'Authorization: Bearer eyJhbGciOi.secret.token failed with sk-abcdef1234567890',
    )
    expect(sanitized).not.toContain('eyJhbGciOi')
    expect(sanitized).not.toContain('sk-abcdef1234567890')
    expect(sanitized).toContain('Bearer [REDACTED]')
    expect(sanitized).toContain('sk-[REDACTED]')
  })

  it('步骤错误保留简短中文提示，转换长英文报错', () => {
    expect(formatStepError('本轮知识库最多检索两次')).toBe('本轮知识库最多检索两次')
    expect(
      formatStepError('401 Incorrect API key provided. https://help.aliyun.com/...'),
    ).toContain('AI 模型认证失败')
  })
})

