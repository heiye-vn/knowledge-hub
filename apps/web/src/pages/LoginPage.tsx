import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Checkbox, Form, Input, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { authApi } from '../api'
import { ApiError } from '../api/client'
import { setAuth } from '../auth'

const REMEMBER_KEY = 'kh.login.remembered-username'

/** 左侧品牌区插画：玻璃罩内悬浮的蓝色立方体 + 层叠底座 + 环绕小图标（纯 SVG，无外部素材） */
function LoginIllustration() {
  return (
    <svg
      className="kh-login-illustration"
      viewBox="0 0 320 300"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <radialGradient id="khGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="khCubeTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9cc0ff" />
          <stop offset="100%" stopColor="#7aa9ff" />
        </linearGradient>
      </defs>

      {/* 背景光斑 */}
      <ellipse cx="160" cy="150" rx="125" ry="110" fill="url(#khGlow)" />

      {/* 底座三层（先画最下层，向上叠） */}
      <g>
        <path d="M160 211 L82 250 L160 289 L238 250 Z" fill="#c9d9fb" />
        <path d="M82 250 L160 289 L160 299 L82 260 Z" fill="#a9c0f0" />
        <path d="M238 250 L160 289 L160 299 L238 260 Z" fill="#9ab4ec" />
      </g>
      <g>
        <path d="M160 190 L96 222 L160 254 L224 222 Z" fill="#dbe6ff" />
        <path d="M96 222 L160 254 L160 264 L96 232 Z" fill="#b8ccf5" />
        <path d="M224 222 L160 254 L160 264 L224 232 Z" fill="#a7bff2" />
      </g>
      <g>
        <path d="M160 171 L110 196 L160 221 L210 196 Z" fill="#edf3ff" />
        <path d="M110 196 L160 221 L160 231 L110 206 Z" fill="#c6d7fa" />
        <path d="M210 196 L160 221 L160 231 L210 206 Z" fill="#b4c9f6" />
      </g>

      {/* 悬浮蓝色立方体 */}
      <g>
        <path d="M160 82 L138 95 L160 108 L182 95 Z" fill="url(#khCubeTop)" />
        <path d="M138 95 L160 108 L160 146 L138 133 Z" fill="#3f7dff" />
        <path d="M182 95 L160 108 L160 146 L182 133 Z" fill="#2a5fd9" />
      </g>

      {/* 罩内小文档 */}
      <g transform="rotate(8 196 122)">
        <rect x="186" y="110" width="22" height="28" rx="3" fill="#ffffff" opacity="0.95" />
        <rect x="190" y="116" width="14" height="2.4" rx="1.2" fill="#b9ccff" />
        <rect x="190" y="121" width="10" height="2.4" rx="1.2" fill="#d4e0ff" />
        <rect x="190" y="126" width="12" height="2.4" rx="1.2" fill="#d4e0ff" />
      </g>

      {/* 玻璃罩（线框 + 半透面） */}
      <g stroke="#ffffff" strokeOpacity="0.85" strokeWidth="1.5" strokeLinejoin="round">
        <path
          d="M160 18 L230 58 L230 138 L160 178 L90 138 L90 58 Z"
          fill="#ffffff"
          fillOpacity="0.22"
        />
        <path d="M160 18 L160 98 M90 58 L160 98 L230 58 M160 98 L160 178" fill="none" />
      </g>

      {/* 环绕小图标：左 饼图 / 右 放大镜 / 右下 工具 */}
      <g>
        <rect x="34" y="138" width="36" height="36" rx="8" fill="#ffffff" stroke="#d8e4fb" strokeWidth="1.5" />
        <circle cx="52" cy="156" r="9" stroke="#6f9bff" strokeWidth="2" fill="none" />
        <path d="M52 156 L52 147 A9 9 0 0 1 60 159 Z" fill="#6f9bff" />
      </g>
      <g>
        <rect x="252" y="96" width="36" height="36" rx="8" fill="#ffffff" stroke="#d8e4fb" strokeWidth="1.5" />
        <circle cx="267" cy="111" r="6" stroke="#6f9bff" strokeWidth="2" fill="none" />
        <path d="M271.5 115.5 L277 121" stroke="#6f9bff" strokeWidth="2" strokeLinecap="round" />
      </g>
      <g>
        <rect x="258" y="208" width="36" height="36" rx="8" fill="#ffffff" stroke="#d8e4fb" strokeWidth="1.5" />
        <path
          d="M279 218 a5 5 0 1 0 6.4 6.4 l-3.2 1.6 -1.6 -1.6 1.6 -3.2 a5 5 0 0 0 -3.2 -3.2 z"
          fill="none"
          stroke="#6f9bff"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M273 235 L280.5 227.5" stroke="#6f9bff" strokeWidth="2" strokeLinecap="round" />
      </g>

      {/* 底部装饰竖条 */}
      <rect x="56" y="206" width="8" height="34" rx="4" fill="#c9d9fb" />
      <rect x="74" y="228" width="8" height="24" rx="4" fill="#dce7ff" />
    </svg>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const [form] = Form.useForm<{ username: string; password: string; remember?: boolean }>()
  const [loading, setLoading] = useState(false)

  // 记住账号：进入页面时回填上次登录的用户名
  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBER_KEY)
    if (remembered) {
      form.setFieldsValue({ username: remembered, remember: true })
    }
  }, [form])

  return (
    <div className="kh-login">
      <div className="kh-login-brand">
        <div className="kh-login-brand-copy">
          <h1>企业智能知识库系统</h1>
          <p>构建企业知识中枢，赋能智能决策与高效协作</p>
          <p>让知识管理更简单，知识价值最大化</p>
        </div>
        <LoginIllustration />
      </div>

      <div className="kh-login-panel">
        <div className="kh-login-card">
          <h2>登录系统</h2>
          <p className="kh-login-sub">欢迎登录企业智能知识库系统</p>
          <Form
            form={form}
            layout="vertical"
            onFinish={async (values) => {
              setLoading(true)
              try {
                const result = await authApi.login(values.username, values.password)
                if (values.remember) {
                  localStorage.setItem(REMEMBER_KEY, values.username)
                } else {
                  localStorage.removeItem(REMEMBER_KEY)
                }
                setAuth({
                  accessToken: result.accessToken,
                  refreshToken: result.refreshToken,
                  user: result.userInfo,
                })
                message.success('登录成功')
                navigate('/dashboard', { replace: true })
              } catch (error) {
                message.error(error instanceof ApiError ? error.message : '登录失败')
              } finally {
                setLoading(false)
              }
            }}
          >
            <Form.Item
              name="username"
              rules={[{ required: true, message: '请输入账号' }]}
            >
              <Input
                size="large"
                prefix={<UserOutlined className="kh-login-input-icon" />}
                placeholder="请输入账号"
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                size="large"
                prefix={<LockOutlined className="kh-login-input-icon" />}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <div className="kh-login-row">
              <Form.Item name="remember" valuePropName="checked" noStyle>
                <Checkbox>记住账号</Checkbox>
              </Form.Item>
              <a
                className="kh-login-link"
                onClick={() => message.info('请联系系统管理员重置密码')}
              >
                忘记密码？
              </a>
            </div>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              block
              loading={loading}
              className="kh-login-btn"
            >
              登录
            </Button>
            <div className="kh-login-register">
              还没有账号？
              <a
                className="kh-login-link"
                onClick={() => message.info('账号由管理员统一创建，请联系管理员')}
              >
                立即注册
              </a>
            </div>
            <div className="kh-login-tip">
              开发环境默认密码均为 <code>123456</code>（可选账号：<code>admin</code> / <code>user</code> / <code>reviewer</code>）
            </div>
          </Form>
        </div>
      </div>
    </div>
  )
}
