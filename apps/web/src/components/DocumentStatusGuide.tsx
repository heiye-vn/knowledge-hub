import { QuestionCircleOutlined } from '@ant-design/icons'
import { Popover, Tag } from 'antd'
import type { PopoverProps } from 'antd'
import { DOC_STATUS_LIST } from '../utils'

/** 纯展示型状态说明主体（同步供 Popover 与单元测试渲染） */
export function DocumentStatusGuideContent() {
  return (
    <div className="kh-status-guide">
      <div className="kh-status-guide-list">
        {DOC_STATUS_LIST.map((item) => (
          <div key={item.code} className="kh-status-guide-item">
            <div className="kh-status-guide-head">
              <Tag
                color={item.color}
                variant={item.variant}
                style={{ marginInlineEnd: 0 }}
              >
                {item.label}
              </Tag>
              <span
                className={`kh-status-guide-scope${item.searchable ? ' is-live' : ''}`}
              >
                {item.searchable ? '可搜索 / AI 问答' : '不进搜索与问答'}
              </span>
            </div>
            <p className="kh-status-guide-desc">{item.description}</p>
          </div>
        ))}
      </div>
      <div className="kh-status-guide-flow">
        流转路径：草稿 → 发布/提审 → 待审核（如需审批）→ 已发布 → 下架编辑（回草稿）或
        归档（终态）
      </div>
    </div>
  )
}

/**
 * 文档状态说明浮层触发器：
 * - showLabel=false：用于表格「状态」列头旁的紧凑图标按钮
 * - showLabel=true：用于顶部提示条右侧的带文字轻量按钮
 */
export function DocumentStatusGuide({
  showLabel = false,
  placement = 'bottomRight',
}: {
  showLabel?: boolean
  placement?: PopoverProps['placement']
}) {
  return (
    <Popover
      title="文档状态说明"
      trigger={['hover', 'click']}
      placement={placement}
      content={<DocumentStatusGuideContent />}
    >
      <button
        type="button"
        className={`kh-status-guide-btn${showLabel ? ' is-labeled' : ''}`}
        aria-label="查看文档状态说明"
      >
        <QuestionCircleOutlined />
        {showLabel ? <span>状态说明</span> : null}
      </button>
    </Popover>
  )
}
