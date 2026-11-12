import type { ReactNode } from 'react'
import { Empty } from 'antd'
import { KhIcon, type KhIconName } from './icons'

/**
 * 品牌空状态：用 kh-icons 语义图标替换 AntD 默认灰色插图。
 * 常用映射——403 无权：locked；检索无结果：empty；图谱无数据：graph。
 */
export function KhEmpty({
  description,
  icon = 'empty',
  size = 44,
  children,
}: {
  description?: ReactNode
  icon?: KhIconName
  size?: number
  children?: ReactNode
}) {
  return (
    <Empty
      image={<KhIcon name={icon} size={size} color="#bfbfbf" />}
      imageStyle={{ height: 'auto', display: 'flex', justifyContent: 'center' }}
      description={description}
    >
      {children}
    </Empty>
  )
}
