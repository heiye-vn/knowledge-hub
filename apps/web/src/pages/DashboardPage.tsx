import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  CommentOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOutlined,
  InboxOutlined,
  LikeOutlined,
} from '@ant-design/icons'
import {
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Row,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import * as echarts from 'echarts'
import { auditApi, documentApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import { useAuth } from '../auth'
import type {
  AuditLogItem,
  CategoryStatItem,
  DocumentOverviewStats,
  TeamItem,
  ViewTrendPoint,
} from '../types'
import { displayName, formatTime } from '../utils'

/** 分类环形图配色（与 AntD 语义色板一致） */
const CHART_COLORS = [
  '#1677ff',
  '#52c41a',
  '#fa8c16',
  '#722ed1',
  '#13c2c2',
  '#eb2f96',
  '#faad14',
  '#a0d911',
]

/** 操作类型 → 中文标签 + 颜色 + 图标 */
const ACTION_META: Record<
  string,
  { label: string; color: string; icon: ReactNode }
> = {
  create: { label: '创建文档', color: 'blue', icon: <FileAddOutlined /> },
  update: { label: '更新文档', color: 'green', icon: <EditOutlined /> },
  delete: { label: '删除文档', color: 'red', icon: <DeleteOutlined /> },
  publish: { label: '发布文档', color: 'geekblue', icon: <CloudUploadOutlined /> },
  'submit-review': {
    label: '提交审核',
    color: 'orange',
    icon: <AuditOutlined />,
  },
  archive: { label: '归档文档', color: 'default', icon: <InboxOutlined /> },
  approve: { label: '审核通过', color: 'green', icon: <CheckCircleOutlined /> },
  reject: { label: '审核驳回', color: 'red', icon: <CloseCircleOutlined /> },
}

/** 文档分类占比环形图（ECharts，随容器尺寸自适应） */
function CategoryDonut({
  data,
  loading,
}: {
  data: CategoryStatItem[]
  loading: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!chartRef.current) chartRef.current = echarts.init(el)
    const chart = chartRef.current
    // 【易错】加载/空态只清空画布、绝不卸载容器：
    // ECharts 会往容器里注入 canvas，React 卸载该 div 时会 removeChild 失败
    // （点击「近 30 日」整页白屏的根因）。
    if (loading || !data.length) {
      chart.clear()
      return
    }
    const total = data.reduce((sum, item) => sum + item.count, 0)
    chart.setOption({
      color: CHART_COLORS,
      tooltip: {
        trigger: 'item',
        formatter: '{b}<br/>{c} 篇（{d}%）',
      },
      title: {
        text: String(total),
        subtext: '文档总数',
        left: 'center',
        top: '33%',
        textStyle: { fontSize: 26, fontWeight: 600, color: '#1f1f1f' },
        subtextStyle: { fontSize: 12, color: '#8c8c8c' },
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { fontSize: 12, color: '#595959' },
        formatter: (name: string) =>
          name.length > 10 ? `${name.slice(0, 10)}…` : name,
      },
      series: [
        {
          type: 'pie',
          radius: ['52%', '74%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
          label: { show: false },
          emphasis: {
            label: {
              show: true,
              fontSize: 14,
              fontWeight: 600,
              formatter: '{b}\n{c} 篇',
            },
          },
          data: data.map((item) => ({
            name: item.categoryName,
            value: item.count,
          })),
        },
      ],
    }, true)
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [data, loading])

  // 卸载时销毁实例；图表容器常驻，不随 loading 卸载
  useEffect(
    () => () => {
      chartRef.current?.dispose()
      chartRef.current = null
    },
    [],
  )

  return (
    <div className="kh-dash-chart-wrap">
      <div ref={ref} className="kh-dash-chart" />
      {loading || !data.length ? (
        <div className="kh-dash-chart-mask">
          {loading ? (
            <Spin size="small" />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无文档数据"
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 访问趋势折线（近 N 天浏览量） */
function ViewTrendChart({
  data,
  loading,
}: {
  data: ViewTrendPoint[]
  loading: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!chartRef.current) chartRef.current = echarts.init(el)
    const chart = chartRef.current
    // 同 CategoryDonut：加载状态只清空画布，容器必须常驻（否则 React removeChild 崩溃）
    if (loading || !data.length) {
      chart.clear()
      return
    }
    chart.setOption({
      color: ['#1677ff'],
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const point = (params as Array<{ axisValue: string; value: number }>)[0]
          return `${point.axisValue}<br/>浏览 ${point.value} 次`
        },
      },
      grid: { left: 44, right: 16, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: data.map((item) => item.date.slice(5)),
        axisLine: { lineStyle: { color: '#e8e8e8' } },
        axisTick: { show: false },
        axisLabel: { color: '#8c8c8c', fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: '#f0f0f0' } },
        axisLabel: { color: '#8c8c8c', fontSize: 11 },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: data.map((item) => item.count),
          lineStyle: { width: 2 },
          itemStyle: { borderWidth: 2, borderColor: '#fff' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(22, 119, 255, 0.18)' },
              { offset: 1, color: 'rgba(22, 119, 255, 0.02)' },
            ]),
          },
        },
      ],
    }, true)
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [data, loading])

  // 卸载时销毁实例；图表容器常驻，不随 loading 卸载
  useEffect(
    () => () => {
      chartRef.current?.dispose()
      chartRef.current = null
    },
    [],
  )

  return (
    <div className="kh-dash-chart-wrap">
      <div ref={ref} className="kh-dash-chart" />
      {loading || !data.length ? (
        <div className="kh-dash-chart-mask">
          {loading ? (
            <Spin size="small" />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无访问数据"
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

export default function DashboardPage() {
  const user = useAuth()
  const navigate = useNavigate()
  const [stats, setStats] = useState<DocumentOverviewStats | null>(null)
  const [categoryStats, setCategoryStats] = useState<CategoryStatItem[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([])
  const [myTeams, setMyTeams] = useState<TeamItem[]>([])
  const [trendDays, setTrendDays] = useState<7 | 30>(7)
  const [trend, setTrend] = useState<ViewTrendPoint[]>([])
  const [trendLoading, setTrendLoading] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    teamApi.mine().then(setMyTeams).catch(() => setMyTeams([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      documentApi.statsOverview().catch((error) => {
        if (!cancelled) {
          message.error(
            error instanceof ApiError ? error.message : '获取统计数据失败',
          )
        }
        return null
      }),
      documentApi.statsByCategory().catch(() => [] as CategoryStatItem[]),
      auditApi.recent(8).catch(() => [] as AuditLogItem[]),
    ])
      .then(([nextStats, nextCategories, nextLogs]) => {
        if (cancelled) return
        setStats(nextStats)
        setCategoryStats(nextCategories)
        setAuditLogs(nextLogs)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 趋势按天数单独请求，切换 7/30 天时不阻塞其它卡片
  useEffect(() => {
    let cancelled = false
    documentApi
      .viewTrend(trendDays)
      .then((data) => {
        if (!cancelled) setTrend(data)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTrendLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [trendDays])

  /** 切换趋势区间：先置加载态再切天数（不放在 effect 内可避开 Compiler 的同步 setState 警告） */
  const changeTrendDays = (value: 7 | 30) => {
    setTrendDays(value)
    setTrendLoading(true)
  }

  const categoryCount = useMemo(
    () => categoryStats.filter((item) => item.categoryId).length,
    [categoryStats],
  )

  const statCards = useMemo(
    () => [
      {
        key: 'doc',
        label: '文档总数',
        value: stats?.documentCount ?? 0,
        color: '#1677ff',
        bg: '#e6f4ff',
        icon: <FileTextOutlined />,
      },
      {
        key: 'view',
        label: '累计浏览',
        value: stats?.viewCount ?? 0,
        color: '#52c41a',
        bg: '#f6ffed',
        icon: <EyeOutlined />,
      },
      {
        key: 'like',
        label: '获得点赞',
        value: stats?.likeCount ?? 0,
        color: '#fa8c16',
        bg: '#fff7e6',
        icon: <LikeOutlined />,
      },
      {
        key: 'comment',
        label: '互动评论',
        value: stats?.commentCount ?? 0,
        color: '#722ed1',
        bg: '#f9f0ff',
        icon: <CommentOutlined />,
      },
      {
        key: 'category',
        label: '文档分类',
        value: categoryCount,
        color: '#13c2c2',
        bg: '#e6fffb',
        icon: <FolderOutlined />,
      },
    ],
    [stats, categoryCount],
  )

  const auditColumns = useMemo<TableColumnsType<AuditLogItem>>(
    () => [
      {
        title: '操作时间',
        dataIndex: 'createdAt',
        width: 150,
        render: (value: string) => formatTime(value),
      },
      {
        title: '操作人',
        dataIndex: 'actorName',
        width: 110,
      },
      {
        title: '操作类型',
        dataIndex: 'action',
        width: 130,
        render: (action: string) => {
          const meta = ACTION_META[action] ?? {
            label: action,
            color: 'default',
            icon: null,
          }
          return (
            <Tag color={meta.color} icon={meta.icon}>
              {meta.label}
            </Tag>
          )
        },
      },
      {
        title: '操作内容',
        dataIndex: 'targetName',
        render: (name: string | null, row) => (
          <span>
            {name ?? '-'}
            {row.detail ? (
              <span className="kh-dash-auth-muted"> · {row.detail}</span>
            ) : null}
          </span>
        ),
      },
      {
        title: '相关文档',
        width: 220,
        render: (_, row) => {
          if (
            row.targetType !== 'document' ||
            !row.targetId ||
            !row.targetName
          ) {
            return '-'
          }
          // 文档已软删：审计记录保留，但不给可点链接（否则点进去 404）
          if (!row.targetExists) {
            return (
              <span className="kh-dash-deleted" title="文档已删除">
                {row.targetName}（已删除）
              </span>
            )
          }
          return (
            <a onClick={() => navigate(`/documents/${row.targetId}`)}>
              {row.targetName}
            </a>
          )
        },
      },
    ],
    [navigate],
  )

  return (
    <div className="kh-page kh-dashboard">
      <div className="kh-dash-head">
        <div>
          <h2 className="kh-dash-title">数据总览</h2>
          <div className="kh-dash-sub">
            <span>你好，{displayName(user)}</span>
            <span className="kh-dash-dot">·</span>
            <span>账号 {user?.username}</span>
            {user?.roles.length ? (
              <>
                <span className="kh-dash-dot">·</span>
                {user.roles.map((role) => (
                  <Tag key={role} color="blue" style={{ marginInlineEnd: 0 }}>
                    {role}
                  </Tag>
                ))}
              </>
            ) : null}
          </div>
        </div>
        <Button onClick={() => navigate('/profile')}>个人中心</Button>
      </div>

      <div className="kh-stat-grid">
        {statCards.map((card) => (
          <Card key={card.key} className="kh-stat-card">
            <div
              className="kh-stat-icon"
              style={{ background: card.bg, color: card.color }}
            >
              {card.icon}
            </div>
            <div className="kh-stat-value">
              {loading ? <Spin size="small" /> : card.value.toLocaleString()}
            </div>
            <div className="kh-stat-label">{card.label}</div>
          </Card>
        ))}
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={15}>
          <Card
            title="访问趋势"
            className="kh-dash-card"
            extra={
              <Segmented
                size="small"
                options={[
                  { label: '近 7 日', value: 7 },
                  { label: '近 30 日', value: 30 },
                ]}
                value={trendDays}
                onChange={(value) => changeTrendDays(value as 7 | 30)}
              />
            }
          >
            <ViewTrendChart data={trend} loading={trendLoading} />
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title="文档分类占比" className="kh-dash-card">
            <CategoryDonut data={categoryStats} loading={loading} />
          </Card>
        </Col>
      </Row>

      <Card title="近期操作记录" className="kh-dash-card" style={{ marginBottom: 16 }}>
        <Table<AuditLogItem>
          rowKey="id"
          size="small"
          columns={auditColumns}
          dataSource={auditLogs}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无操作记录"
              />
            ),
          }}
        />
      </Card>

      <Collapse
        className="kh-dash-auth"
        items={[
          {
            key: 'auth',
            label: '当前账号授权信息',
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div>
                  <span className="kh-dash-auth-label">生效角色：</span>
                  {user?.roles.map((role) => (
                    <Tag color="blue" key={role}>
                      {role}
                    </Tag>
                  ))}
                </div>
                <div>
                  <span className="kh-dash-auth-label">所在团队：</span>
                  {myTeams.length ? (
                    <span className="kh-dash-tags">
                      {myTeams.map((team) => (
                        <Tag color="purple" key={team.id}>
                          {team.teamName}
                        </Tag>
                      ))}
                    </span>
                  ) : (
                    <span className="kh-dash-auth-muted">暂未加入团队</span>
                  )}
                </div>
                <div>
                  <span className="kh-dash-auth-label">已获权限码：</span>
                  <span className="kh-dash-tags">
                    {user?.permissions.map((permission) => (
                      <Tag color="geekblue" key={permission}>
                        {permission}
                      </Tag>
                    ))}
                  </span>
                </div>
              </Space>
            ),
          },
        ]}
      />
    </div>
  )
}
