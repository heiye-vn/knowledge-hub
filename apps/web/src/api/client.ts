import { clearAuth, getAccessToken, getRefreshToken, getUser, setAuth } from '../auth'
import type { AuthUser } from '../types'

const rawApiBase = import.meta.env.VITE_API_BASE || '/api'
export const API_BASE =
  rawApiBase === '/' ? '' : rawApiBase.replace(/\/+$/, '')

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function errorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback
  const message = (body as { message?: unknown }).message
  if (typeof message === 'string' && message.toLowerCase() !== 'success') return message
  if (Array.isArray(message)) return message.filter((x) => typeof x === 'string').join('；')
  return fallback
}

let refreshing: Promise<boolean> | null = null

async function tryRefresh() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        if (!res.ok) return false
        const payload = (await res.json()) as Record<string, unknown>
        const data =
          payload && typeof payload === 'object' && 'data' in payload
            ? (payload.data as {
                accessToken: string
                refreshToken: string
                userInfo: AuthUser
              })
            : (payload as unknown as {
                accessToken: string
                refreshToken: string
                userInfo: AuthUser
              })

        // A late refresh must not resurrect a logged-out or replaced session.
        if (!data?.accessToken || getRefreshToken() !== refreshToken) return false

        setAuth({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: data.userInfo,
        })
        return true
      } catch {
        return false
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

/** 供自管 fetch 的调用方（如 SSE 聊天）复用同一套刷新与并发去重 */
export function refreshAccessToken(): Promise<boolean> {
  return tryRefresh()
}

/**
 * 给自管 fetch 的调用方（SSE 聊天）用的 401 重试：
 * 刷新成功后只重试一次；刷新失败清本地登录态，返回原 401 交给调用方展示。
 */
export async function fetchWithAuthRefresh(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const owner = getUser()?.userId
  const refreshToken = getRefreshToken()
  const response = await fetch(input, init)
  if (response.status !== 401 || init?.signal?.aborted || getUser()?.userId !== owner) return response

  if (!(await refreshAccessToken())) {
    if (!init?.signal?.aborted && getRefreshToken() === refreshToken) clearAuth()
    return response
  }
  if (init?.signal?.aborted || getUser()?.userId !== owner) return response

  const headers = new Headers(init?.headers)
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { ...(init ?? {}), headers })
}

async function requestResponse(path: string, init: RequestInit, retry = true) {
  const headers = new Headers(init.headers)
  const isForm = init.body instanceof FormData
  if (!isForm && !headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const fetcher = retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')
    ? fetchWithAuthRefresh : fetch
  const res = await fetcher(`${API_BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new ApiError(res.status, errorMessage(body,
      res.status === 401 ? '未登录或登录已过期' : res.statusText || '请求失败'))
  }
  return res
}

/** Only canonical document resources or the exact configured API prefix are accepted. */
export function documentResourcePath(value: string, kind: 'asset' | 'source'): string | null {
  const pattern = kind === 'asset' ? /^\/documents\/\d+\/assets\/\d+$/ : /^\/documents\/\d+\/source$/
  if (pattern.test(value)) return value
  const path = API_BASE && value.startsWith(`${API_BASE}/`) ? value.slice(API_BASE.length) : ''
  return pattern.test(path) ? path : null
}

const SHARE_ASSET_PATTERN =
  /^\/shares\/[A-Za-z0-9_-]{1,64}\/assets\/\d+\?exp=\d+&sig=[a-f0-9]{64}$/

/** 分享正文里的图片地址只接受后端签发的签名 URL，并补上 API 前缀 */
export function shareAssetUrl(value?: string | null): string | null {
  if (!value || !SHARE_ASSET_PATTERN.test(value)) return null
  return `${API_BASE}${value}`
}

/** Binary endpoints bypass the JSON envelope, but share authentication and refresh. */
export async function requestBlob(value: string, init: RequestInit = {}): Promise<Blob> {
  const path = documentResourcePath(value, 'asset') ?? documentResourcePath(value, 'source')
  if (!path) throw new ApiError(400, '不支持的文档资源地址')
  // Private resources must not redirect a credentialed request to another URL.
  const res = await requestResponse(path, { ...init, method: 'GET', redirect: 'error', cache: 'no-store' })
  return res.blob()
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const res = await requestResponse(path, init, retry)
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null

  // 统一解包 TransformInterceptor { code, message: 'success', data: ... }
  // 后端规范：code 对齐 HTTP 状态码（200, 201 等 2xx 均视为成功）
  if (data !== null && typeof data === 'object' && 'code' in data && 'data' in data) {
    const envelope = data as { code: number; message?: string; data: unknown }
    if (typeof envelope.code === 'number' && (envelope.code < 200 || envelope.code >= 300)) {
      throw new ApiError(
        envelope.code,
        errorMessage(envelope, '业务请求异常'),
      )
    }
    return envelope.data as T
  }

  return data as T
}

export function get<T>(path: string) {
  return request<T>(path)
}

export function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function put<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function patch<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function del<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'DELETE',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
