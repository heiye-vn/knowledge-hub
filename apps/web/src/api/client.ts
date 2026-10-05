import { clearAuth, getAccessToken, getRefreshToken, setAuth } from '../auth'
import type { AuthUser } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

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

        if (!data?.accessToken) return false

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

export async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers)
  const isForm = init.body instanceof FormData
  if (!isForm && !headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  if (
    res.status === 401 &&
    retry &&
    !path.startsWith('/auth/login') &&
    !path.startsWith('/auth/refresh')
  ) {
    const ok = await tryRefresh()
    if (ok) return request<T>(path, init, false)
    clearAuth()
    throw new ApiError(401, '未登录或登录已过期')
  }

  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data, res.statusText || '请求失败'))
  }

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
