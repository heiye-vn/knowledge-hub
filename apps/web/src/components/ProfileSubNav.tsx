import { useLocation, useNavigate } from 'react-router-dom'
import { KhIcon, type KhIconName } from './icons'

const PROFILE_TABS: Array<{ key: string; label: string; icon: KhIconName }> = [
  { key: '/profile', label: '账号资料', icon: 'user' },
  { key: '/profile/memory', label: '我的记忆', icon: 'memory' },
  { key: '/notifications', label: '消息通知', icon: 'publish' },
]

/** 个人中心子页切换栏（账号资料 / 我的记忆 / 消息通知） */
export function ProfileSubNav() {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <div className="kh-subnav-tabs" role="tablist" aria-label="个人中心子菜单">
      {PROFILE_TABS.map((tab) => {
        const active =
          tab.key === '/profile'
            ? location.pathname === '/profile'
            : location.pathname.startsWith(tab.key)
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`kh-subnav-tab${active ? ' is-active' : ''}`}
            onClick={() => navigate(tab.key)}
          >
            <KhIcon name={tab.icon} size={15} />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}

