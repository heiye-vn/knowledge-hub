import { useState } from 'react'
import {
  CloseOutlined,
  CopyOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Button, message } from 'antd'
import { formatChatError } from '../chat-error-utils'
import { KhIcon } from './icons'

export interface ChatErrorCardProps {
  error: Error | string
  busy?: boolean
  canRetryAction?: boolean
  canFallbackRagAction?: boolean
  onRetry?: () => void
  onFallbackRag?: () => void
  onDismiss?: () => void
}

/**
 * 面向终端用户的模型/问答错误诊断卡：
 * - 将英文 SDK/HTTP 原始报错转为清晰中文标题 + 原因 + 下一步建议
 * - 提供明确恢复路径（重新生成 / 改用仅检索查阅原文）
 * - 技术详情默认折叠且已脱敏，兼顾普通用户清晰度与管理员排障需求
 */
export function ChatErrorCard({
  error,
  busy = false,
  canRetryAction = false,
  canFallbackRagAction = false,
  onRetry,
  onFallbackRag,
  onDismiss,
}: ChatErrorCardProps) {
  const info = formatChatError(error)
  const [copied, setCopied] = useState(false)

  const showRetry = canRetryAction && Boolean(onRetry)
  const showFallbackRag =
    info.canFallbackRag && canFallbackRagAction && Boolean(onFallbackRag)

  // 当模型本身鉴权/配额/配置故障时，优先引导用户使用「仅检索」直接查库；
  // 当属于临时超时/限流/网络抖动时，优先引导「重新生成」。
  const primaryAction: 'retry' | 'rag' | null =
    info.canRetry && showRetry
      ? 'retry'
      : showFallbackRag
        ? 'rag'
        : showRetry
          ? 'retry'
          : null

  async function copyDetail() {
    if (!info.technicalDetail) return
    try {
      await navigator.clipboard.writeText(info.technicalDetail)
      setCopied(true)
      message.success('已复制技术详情')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      message.warning('复制失败，请手动选中技术详情复制')
    }
  }

  return (
    <div
      className={`kh-chat-error-card is-${info.severity}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="kh-chat-error-head">
        <span className="kh-chat-error-icon" aria-hidden>
          <KhIcon
            name={
              info.category === 'auth' || info.category === 'session_auth'
                ? 'locked'
                : 'failed'
            }
            size={18}
          />
        </span>
        <div className="kh-chat-error-copy">
          <div className="kh-chat-error-title">{info.title}</div>
          <p className="kh-chat-error-desc">{info.description}</p>
          <p className="kh-chat-error-tip">{info.suggestion}</p>
        </div>
        {onDismiss ? (
          <button
            type="button"
            className="kh-chat-error-close"
            onClick={onDismiss}
            aria-label="关闭错误提示"
            title="关闭提示"
          >
            <CloseOutlined />
          </button>
        ) : null}
      </div>

      {showRetry || showFallbackRag ? (
        <div className="kh-chat-error-actions">
          {showFallbackRag && primaryAction === 'rag' ? (
            <Button
              type="primary"
              size="small"
              icon={<SearchOutlined />}
              disabled={busy}
              onClick={onFallbackRag}
            >
              改用仅检索查看原文
            </Button>
          ) : null}
          {showRetry ? (
            <Button
              type={primaryAction === 'retry' ? 'primary' : 'default'}
              size="small"
              icon={<ReloadOutlined />}
              disabled={busy}
              onClick={onRetry}
            >
              重新生成
            </Button>
          ) : null}
          {showFallbackRag && primaryAction !== 'rag' ? (
            <Button
              size="small"
              icon={<SearchOutlined />}
              disabled={busy}
              onClick={onFallbackRag}
            >
              改用仅检索
            </Button>
          ) : null}
        </div>
      ) : null}

      {info.technicalDetail ? (
        <details className="kh-chat-error-details">
          <summary>查看技术详情（供管理员排查）</summary>
          <div className="kh-chat-error-detail-box">
            <code>{info.technicalDetail}</code>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void copyDetail()}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
        </details>
      ) : null}
    </div>
  )
}

