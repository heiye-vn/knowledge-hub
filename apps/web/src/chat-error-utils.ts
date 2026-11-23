export type ChatErrorCategory =
  | 'auth'
  | 'unconfigured'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'context_limit'
  | 'content_filter'
  | 'model_missing'
  | 'server'
  | 'session_auth'
  | 'unknown'

export interface FriendlyChatError {
  category: ChatErrorCategory
  title: string
  description: string
  suggestion: string
  /** 是否建议优先「重新生成」（如临时限流、超时、网络抖动） */
  canRetry: boolean
  /** 是否建议降级使用「仅检索」直接查阅知识库原文 */
  canFallbackRag: boolean
  severity: 'error' | 'warning'
  /** 脱敏后的原始技术报错，默认折叠供排障使用 */
  technicalDetail?: string
}

const MAX_DETAIL_LEN = 420

/** 对技术详情中的密钥/令牌脱敏，避免错误面板泄露敏感凭证 */
export function sanitizeTechnicalDetail(raw: string): string {
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(
      /(api[_-]?key\s*[:=]\s*['"]?)([A-Za-z0-9._~+/=-]{8,})(['"]?)/gi,
      '$1[REDACTED]$3',
    )
    .trim()

  if (cleaned.length <= MAX_DETAIL_LEN) return cleaned
  return `${cleaned.slice(0, MAX_DETAIL_LEN)}…`
}

/**
 * 将后端/模型 SDK（LangChain、OpenAI 兼容接口、DashScope 等）透传的原始报错
 * 解析为面向终端用户的结构化中文提示，同时保留脱敏后的技术详情供排障折叠查看。
 */
export function formatChatError(input?: Error | string | null): FriendlyChatError {
  const raw =
    typeof input === 'string'
      ? input.trim()
      : input instanceof Error
        ? (input.message || '').trim()
        : ''
  const detail = raw ? sanitizeTechnicalDetail(raw) : undefined
  const lower = raw.toLowerCase()

  // 1. 服务端未配置大模型密钥
  if (
    raw.includes('未配置 LLM Key') ||
    /llm_api_key|api key (is )?not (set|configured)|missing api key/i.test(raw)
  ) {
    return {
      category: 'unconfigured',
      title: 'AI 模型尚未配置',
      description: '当前系统尚未配置可用的大模型密钥，暂时无法生成智能回答。',
      suggestion:
        '请联系系统管理员配置模型服务；您也可以先使用「仅检索」查阅知识库原文。',
      canRetry: false,
      canFallbackRag: true,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 2. 大模型 API Key 认证失败（401 / MODEL_AUTHENTICATION / Incorrect API key）
  if (
    /model_authentication|incorrect api key|invalid api key|invalid_api_key|apikey-error|authenticationerror|invalid_access_key/i.test(
      raw,
    ) ||
    (/\b401\b/.test(raw) &&
      /(api.?key|dashscope|openai|langchain|model|aliyun|bearer|unauthorized)/i.test(
        raw,
      ))
  ) {
    return {
      category: 'auth',
      title: 'AI 模型认证失败',
      description:
        '后台配置的大模型 API 密钥无效、已过期或无调用权限，当前无法调用模型生成回答。',
      suggestion:
        '请联系系统管理员检查并更新模型密钥；在此之前，您可以先改用「仅检索」模式查阅知识库文档。',
      canRetry: false,
      canFallbackRag: true,
      severity: 'error',
      technicalDetail: detail,
    }
  }

  // 3. 当前用户登录态失效或业务权限不足
  if (
    /登录已过期|请重新登录|未登录|无权访问|会话不存在/.test(raw) ||
    /\b403\b/.test(raw) ||
    /\b401\b/.test(raw)
  ) {
    return {
      category: 'session_auth',
      title: '登录状态或访问权限异常',
      description: '您的登录凭证可能已失效，或当前账号无权访问该对话会话。',
      suggestion: '请刷新页面或重新登录后再试。',
      canRetry: false,
      canFallbackRag: false,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 4. 余额不足 / 欠费 / 配额耗尽
  if (
    /\b402\b/.test(raw) ||
    /insufficient_quota|arrearage|quota.?exceeded|billing|out of credits|余额不足|欠费|配额/.test(
      lower,
    )
  ) {
    return {
      category: 'quota',
      title: 'AI 模型服务额度不足',
      description: '当前大模型账号的可用余额或调用配额已耗尽，暂时无法响应问答。',
      suggestion:
        '请联系系统管理员补充额度；您也可以先使用「仅检索」查阅知识库文档。',
      canRetry: false,
      canFallbackRag: true,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 5. 请求频控 / 并发限流（429）
  if (
    /\b429\b/.test(raw) ||
    /rate.?limit|too many requests|throttl|限流|请求过于频繁/.test(lower)
  ) {
    return {
      category: 'rate_limit',
      title: '模型服务繁忙，请求已限流',
      description: '当前问答并发量较高，触发了大模型接口的调用频率限制。',
      suggestion: '请稍等几秒后点击「重新生成」重试，或先使用「仅检索」。',
      canRetry: true,
      canFallbackRag: true,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 6. 上下文长度超限
  if (
    /context_length|maximum context|too many tokens|token limit|range of input length|上下文过长|长度超限/.test(
      lower,
    )
  ) {
    return {
      category: 'context_limit',
      title: '对话内容过长，超出模型上限',
      description: '当前会话的历史上下文或本次提问长度超过了模型的最大处理限制。',
      suggestion: '建议点击左侧「新对话」开启新会话，或精简问题后重新发送。',
      canRetry: false,
      canFallbackRag: true,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 7. 内容安全审核拦截
  if (
    /data_inspection_failed|content_filter|content_policy|inappropriate content|safety|敏感内容|安全审核/.test(
      lower,
    )
  ) {
    return {
      category: 'content_filter',
      title: '内容触发安全审核限制',
      description: '本次提问或模型输出触发了内容安全策略，未能继续展示。',
      suggestion: '请尝试调整提问表述后重新发送，或使用「仅检索」查看原始文档。',
      canRetry: false,
      canFallbackRag: true,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 8. 模型不存在 / 未开通权限
  if (
    /model_not_found|model not found|does not exist.*model|model.*does not exist|invalid_model|模型不存在/.test(
      lower,
    )
  ) {
    return {
      category: 'model_missing',
      title: '配置的 AI 模型不可用',
      description: '后台指定的模型名称不存在，或当前账号未开通该模型的调用权限。',
      suggestion: '请联系系统管理员核对模型配置，或先使用「仅检索」查阅知识库。',
      canRetry: false,
      canFallbackRag: true,
      severity: 'error',
      technicalDetail: detail,
    }
  }

  // 9. 请求超时
  if (
    /\b504\b/.test(raw) ||
    /timeout|timed out|etimedout|gateway timeout|aborted due to timeout|超时/.test(
      lower,
    )
  ) {
    return {
      category: 'timeout',
      title: 'AI 模型响应超时',
      description: '等待模型生成结果的时间过长，本次请求已自动中断。',
      suggestion: '请点击「重新生成」再试一次，或尝试将问题拆分得更具体。',
      canRetry: true,
      canFallbackRag: true,
      severity: 'warning',
      technicalDetail: detail,
    }
  }

  // 10. 网络连接异常
  if (
    /failed to fetch|networkerror|network error|econnrefused|econnreset|enotfound|err_network|socket hang up|网络异常|连接失败/.test(
      lower,
    )
  ) {
    return {
      category: 'network',
      title: '无法连接到问答服务',
      description: '当前网络连接不稳定或后端问答服务暂时不可达。',
      suggestion: '请检查网络连接后点击「重新生成」重试。',
      canRetry: true,
      canFallbackRag: false,
      severity: 'error',
      technicalDetail: detail,
    }
  }

  // 11. 上游服务端故障（500 / 502 / 503）
  if (
    /\b(500|502|503)\b/.test(raw) ||
    /internal server error|bad gateway|service unavailable|overloaded|服务不可用/.test(
      lower,
    )
  ) {
    return {
      category: 'server',
      title: 'AI 模型服务暂时不可用',
      description: '上游大模型接口返回了服务端异常，通常为临时性服务波动。',
      suggestion: '请稍候片刻后点击「重新生成」，或先改用「仅检索」查阅资料。',
      canRetry: true,
      canFallbackRag: true,
      severity: 'error',
      technicalDetail: detail,
    }
  }

  // 12. 通用兜底
  return {
    category: 'unknown',
    title: '智能回答生成失败',
    description: '本次问答请求未能顺利完成，模型服务返回了未预期的异常。',
    suggestion:
      '您可以点击「重新生成」重试；若问题持续，请展开下方技术详情并反馈给管理员。',
    canRetry: true,
    canFallbackRag: true,
    severity: 'error',
    technicalDetail: detail,
  }
}

/** 步骤卡片（工具调用失败）使用的简短友好报错文案 */
export function formatStepError(raw?: string | null): string {
  const trimmed = raw?.trim()
  if (!trimmed) return '执行失败，请稍后重试'
  // 已经是简短中文业务提示时直接保留
  if (!/https?:\/\/|error|exception|\b[45]\d{2}\b/i.test(trimmed) && trimmed.length <= 80) {
    return trimmed
  }
  const friendly = formatChatError(trimmed)
  return `${friendly.title}：${friendly.description}`
}

