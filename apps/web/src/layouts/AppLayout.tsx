import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BellOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Badge, Button, Dropdown, Layout, Tag, Tooltip } from 'antd'
import { authApi, notificationApi, teamApi } from '../api'
import { clearAuth, updateUser, useAuth } from '../auth'
import { BrandLogo } from '../components/BrandLogo'
import { KhIcon, type KhIconName } from '../components/icons'
import type { TeamItem } from '../types'
import { can, displayName, isAdmin, isReviewer } from '../utils'

const { Sider, Content } = Layout

type NavEntry = {
  key: string
  label: string
  icon: KhIconName
  /** 路径前缀匹配时高亮（精确匹配优先） */
  matchPrefix?: string
}

type RouteMeta = {
  section: string
  title: string
}

function resolveRouteMeta(pathname: string): RouteMeta {
  if (pathname === '/dashboard') return { section: '工作台', title: '数据概览' }
  if (pathname.startsWith('/chat')) return { section: '工作台', title: 'AI 智能问答' }
  if (pathname.startsWith('/search')) return { section: '工作台', title: '全文搜索' }
  if (pathname.startsWith('/graph')) return { section: '工作台', title: '知识图谱' }
  if (/^\/documents\/[^/]+\/edit/.test(pathname))
    return { section: '知识库', title: '编辑文档' }
  if (/^\/documents\/[^/]+\/versions/.test(pathname))
    return { section: '知识库', title: '版本历史' }
  if (/^\/documents\/[^/]+/.test(pathname))
    return { section: '知识库', title: '文档详情' }
  if (pathname.startsWith('/documents')) return { section: '知识库', title: '全部文档' }
  if (pathname.startsWith('/favorites')) return { section: '知识库', title: '我的收藏' }
  if (pathname.startsWith('/admin/reviews')) return { section: '知识库', title: '审核工作台' }
  if (pathname.startsWith('/profile/memory'))
    return { section: '个人中心', title: '我的记忆' }
  if (pathname.startsWith('/profile')) return { section: '个人中心', title: '账号资料' }
  if (pathname.startsWith('/notifications'))
    return { section: '个人中心', title: '消息通知' }
  if (pathname.startsWith('/admin/users')) return { section: '系统管理', title: '用户管理' }
  if (pathname.startsWith('/admin/roles')) return { section: '系统管理', title: '角色权限' }
  if (pathname.startsWith('/admin/teams')) return { section: '系统管理', title: '团队管理' }
  if (pathname.startsWith('/admin/categories'))
    return { section: '系统管理', title: '分类管理' }
  if (pathname.startsWith('/admin/notifications'))
    return { section: '系统管理', title: '发送通知' }
  return { section: '工作台', title: 'Knowledge Hub' }
}

/**
 * 统一工作台壳层：
 * - 左侧唯一暖纸色导航栏（可收起），彻底消除「顶栏 + 空洞二级栏」双重冗余
 * - 右侧轻量化 52px 上下文栏 + 全高主画布，让问答与图谱自然铺开
 */
export default function AppLayout() {
  const user = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [myTeams, setMyTeams] = useState<TeamItem[]>([])
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    authApi.me().then(updateUser).catch(() => undefined)
    teamApi.mine().then(setMyTeams).catch(() => setMyTeams([]))
  }, [])

  // 未读角标：30s 轮询 + 通知页已读后主动广播刷新
  useEffect(() => {
    let timer = 0
    const loadUnread = () => {
      notificationApi
        .unreadCount()
        .then((res) => setUnread(res.count))
        .catch(() => undefined)
    }
    loadUnread()
    timer = window.setInterval(loadUnread, 30000)
    const onChange = () => loadUnread()
    window.addEventListener('kh:notifications-changed', onChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('kh:notifications-changed', onChange)
    }
  }, [location.pathname])

  const workspaceItems = useMemo<NavEntry[]>(() => {
    const items: NavEntry[] = [
      { key: '/dashboard', label: '数据概览', icon: 'home' },
    ]
    if (can(user, 'search')) {
      items.push(
        { key: '/chat', label: 'AI 智能问答', icon: 'chat', matchPrefix: '/chat' },
        {
          key: '/search',
          label: '全文搜索',
          icon: 'search',
          matchPrefix: '/search',
        },
        {
          key: '/graph',
          label: '知识图谱',
          icon: 'graph',
          matchPrefix: '/graph',
        },
      )
    }
    return items
  }, [user])

  const knowledgeItems = useMemo<NavEntry[]>(() => {
    const items: NavEntry[] = []
    if (can(user, 'document:list')) {
      items.push(
        { key: '/documents', label: '全部文档', icon: 'documents' },
        { key: '/favorites', label: '我的收藏', icon: 'favorite' },
      )
    }
    if (isReviewer(user)) {
      items.push({
        key: '/admin/reviews',
        label: '审核工作台',
        icon: 'evaluate',
      })
    }
    return items
  }, [user])

  const adminItems = useMemo<NavEntry[]>(() => {
    const items: NavEntry[] = []
    if (isAdmin(user) || can(user, 'system:user')) {
      items.push({ key: '/admin/users', label: '用户管理', icon: 'user' })
    }
    if (isAdmin(user) || can(user, 'system:role')) {
      items.push({ key: '/admin/roles', label: '角色权限', icon: 'locked' })
    }
    if (isAdmin(user) || can(user, 'system:team')) {
      items.push({ key: '/admin/teams', label: '团队管理', icon: 'share' })
    }
    if (isAdmin(user) || can(user, 'document:category')) {
      items.push({ key: '/admin/categories', label: '分类管理', icon: 'tag' })
    }
    if (isAdmin(user)) {
      items.push({
        key: '/admin/notifications',
        label: '发送通知',
        icon: 'publish',
      })
    }
    return items
  }, [user])

  const isActive = (entry: NavEntry) => {
    const p = location.pathname
    if (entry.key === '/documents') {
      return p === '/documents' || p.startsWith('/documents/')
    }
    if (entry.matchPrefix) return p.startsWith(entry.matchPrefix)
    return p === entry.key
  }

  const routeMeta = resolveRouteMeta(location.pathname)

  const renderNavItem = (entry: NavEntry) => {
    const active = isActive(entry)
    const button = (
      <button
        key={entry.key}
        type="button"
        className={`kh-nav-item${active ? ' is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => navigate(entry.key)}
      >
        <KhIcon name={entry.icon} size={16} />
        {!collapsed ? <span className="kh-nav-label">{entry.label}</span> : null}
      </button>
    )
    if (collapsed) {
      return (
        <Tooltip key={entry.key} title={entry.label} placement="right">
          {button}
        </Tooltip>
      )
    }
    return button
  }

  return (
    <Layout className="kh-root kh-shell">
      <Sider
        className={`kh-nav-sider${collapsed ? ' is-collapsed' : ''}`}
        theme="light"
        width={236}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        trigger={null}
      >
        <div
          className="kh-brand-bar"
          title="返回数据概览"
          onClick={() => navigate('/dashboard')}
        >
          <BrandLogo size={28} />
          {!collapsed ? (
            <div className="kh-brand-copy">
              <span className="kh-logo-text">Knowledge Hub</span>
              <span className="kh-brand-sub">企业知识库</span>
            </div>
          ) : null}
        </div>

        <nav className="kh-nav-scroll" aria-label="主导航">
          <div className="kh-nav-group">
            {!collapsed ? <div className="kh-nav-group-title">工作台</div> : null}
            {workspaceItems.map(renderNavItem)}
          </div>

          {knowledgeItems.length ? (
            <div className="kh-nav-group">
              {!collapsed ? <div className="kh-nav-group-title">知识库</div> : null}
              {knowledgeItems.map(renderNavItem)}
            </div>
          ) : null}

          {adminItems.length ? (
            <div className="kh-nav-group">
              {!collapsed ? (
                <div className="kh-nav-group-title">系统管理</div>
              ) : (
                <div className="kh-nav-divider" />
              )}
              {adminItems.map(renderNavItem)}
            </div>
          ) : null}
        </nav>

        <div className="kh-nav-footer">
          <div className="kh-nav-footer-tools">
            <Tooltip title="消息通知" placement={collapsed ? 'right' : 'top'}>
              <button
                type="button"
                className={`kh-nav-tool-btn${location.pathname.startsWith('/notifications') ? ' is-active' : ''}`}
                aria-label="消息通知"
                onClick={() => navigate('/notifications')}
              >
                <Badge count={unread} size="small" offset={[2, -2]}>
                  <BellOutlined />
                </Badge>
                {!collapsed ? <span>消息通知</span> : null}
              </button>
            </Tooltip>
            <Tooltip
              title={collapsed ? '展开导航' : '收起导航'}
              placement={collapsed ? 'right' : 'top'}
            >
              <button
                type="button"
                className="kh-nav-collapse-btn"
                aria-label={collapsed ? '展开导航' : '收起导航'}
                onClick={() => setCollapsed((v) => !v)}
              >
                {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              </button>
            </Tooltip>
          </div>

          <Dropdown
            placement="topLeft"
            trigger={['click']}
            menu={{
              items: [
                ...(can(user, 'profile')
                  ? [
                      { key: 'profile', label: '账号资料' },
                      { key: 'memory', label: '我的记忆' },
                      { key: 'notifications', label: '消息通知' },
                      { type: 'divider' as const },
                    ]
                  : []),
                { key: 'logout', label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'profile') navigate('/profile')
                if (key === 'memory') navigate('/profile/memory')
                if (key === 'notifications') navigate('/notifications')
                if (key === 'logout') {
                  authApi.logout().catch(() => undefined)
                  clearAuth()
                  navigate('/login')
                }
              },
            }}
          >
            <button type="button" className="kh-nav-user">
              <Avatar
                size={30}
                icon={<UserOutlined />}
                src={user?.avatar || undefined}
                style={{ backgroundColor: '#1B2A41', flexShrink: 0 }}
              />
              {!collapsed ? (
                <div className="kh-nav-user-meta">
                  <span className="kh-nav-user-name">{displayName(user)}</span>
                  <span className="kh-nav-user-sub">
                    {user?.username || '成员'}
                  </span>
                </div>
              ) : null}
            </button>
          </Dropdown>
        </div>
      </Sider>

      <Layout className="kh-main-shell">
        <header className="kh-topbar">
          <div className="kh-topbar-left">
            <span className="kh-topbar-section">{routeMeta.section}</span>
            <span className="kh-topbar-sep" aria-hidden>
              /
            </span>
            <h1 className="kh-topbar-title">{routeMeta.title}</h1>
          </div>
          <div className="kh-topbar-right">
            {myTeams.length ? (
              <div className="kh-topbar-teams" aria-label="所属团队">
                {myTeams.slice(0, 3).map((team) => (
                  <Tag key={team.id} className="kh-team-pill">
                    {team.teamName}
                  </Tag>
                ))}
              </div>
            ) : null}
            {can(user, 'search') && !location.pathname.startsWith('/chat') ? (
              <Button
                size="small"
                icon={<KhIcon name="chat" size={14} />}
                onClick={() => navigate('/chat')}
              >
                AI 问答
              </Button>
            ) : null}
          </div>
        </header>

        <Content className="kh-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
