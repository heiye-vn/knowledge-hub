/** 统一 API 成功响应结构 */
export interface ApiResponse<T = unknown> {
  /** 业务状态码（对齐 HTTP 状态码，如 200, 201） */
  code: number;
  /** 提示信息 */
  message: string;
  /** 业务数据载荷 */
  data: T;
  /** 响应时间戳（毫秒） */
  timestamp: number;
}

/** 统一 API 异常响应结构 */
export interface ApiErrorResponse {
  /** 异常状态码（对齐 HTTP 状态码，如 400, 404, 500） */
  code: number;
  /** 错误描述 */
  message: string;
  /** 错误分类名 */
  error?: string;
  /** 请求路径 */
  path?: string;
  /** 响应时间戳（毫秒） */
  timestamp: number;
}
