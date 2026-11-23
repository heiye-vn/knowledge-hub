import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatErrorCard } from './ChatErrorCard'

describe('ChatErrorCard 组件渲染', () => {
  it('将阿里云/LangChain 401 报错渲染为中文诊断卡并默认折叠技术详情', () => {
    const html = renderToStaticMarkup(
      createElement(ChatErrorCard, {
        error: new Error(
          '401 Incorrect API key provided. For details, see: https://help.aliyun.com/zh/model-studio/error-code#apikey-error Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/',
        ),
        canRetryAction: true,
        canFallbackRagAction: true,
        onRetry: () => {},
        onFallbackRag: () => {},
        onDismiss: () => {},
      }),
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('AI 模型认证失败')
    expect(html).toContain('联系系统管理员')
    expect(html).toContain('改用仅检索查看原文')
    expect(html).toContain('重新生成')
    expect(html).toContain('aria-label="关闭错误提示"')
    expect(html).toContain('查看技术详情（供管理员排查）')
    // details 默认折叠，不应带 open 属性
    expect(html).toContain('<details class="kh-chat-error-details">')
    // 401 鉴权错误时「改用仅检索查看原文」应优先作为主按钮渲染在「重新生成」之前
    expect(html.indexOf('改用仅检索查看原文')).toBeLessThan(
      html.indexOf('重新生成'),
    )
  })

  it('临时限流错误采用 warning 视觉并优先展示「重新生成」', () => {
    const html = renderToStaticMarkup(
      createElement(ChatErrorCard, {
        error: '429 Too Many Requests: Rate limit exceeded',
        canRetryAction: true,
        canFallbackRagAction: true,
        onRetry: () => {},
        onFallbackRag: () => {},
      }),
    )

    expect(html).toContain('kh-chat-error-card is-warning')
    expect(html).toContain('模型服务繁忙，请求已限流')
    expect(html.indexOf('重新生成')).toBeLessThan(html.indexOf('改用仅检索'))
  })

  it('技术详情渲染前已自动对密钥脱敏', () => {
    const html = renderToStaticMarkup(
      createElement(ChatErrorCard, {
        error: '401 Incorrect API key sk-supersecret1234567890',
      }),
    )

    expect(html).not.toContain('sk-supersecret1234567890')
    expect(html).toContain('sk-[REDACTED]')
  })
})
