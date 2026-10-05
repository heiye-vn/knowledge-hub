import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as echarts from 'echarts'
import {
  ApartmentOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  InfoCircleOutlined,
  SearchOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Input,
  Select,
  Slider,
  Space,
  Tag,
  Tooltip,
  message,
} from 'antd'
import type { Dayjs } from 'dayjs'
import { graphApi } from '../api'
import { ApiError } from '../api/client'
import type { GraphOverview, GraphViewNode } from '../types'
import { formatTime } from '../utils'
import { ForceGraph, type ForceGraphRef } from '../components/ForceGraph'

const { RangePicker } = DatePicker

/** 实体类型分布小饼图 */
function EntityTypePie({ data }: { data: Array<{ type: string; count: number }> }) {
  const chartRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!chartRef.current || !data.length) return
    const chart = echarts.init(chartRef.current)
    const option: echarts.EChartsOption = {
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c} ({d}%)',
      },
      legend: {
        bottom: 0,
        left: 'center',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { fontSize: 11, color: '#8c8c8c' },
      },
      series: [
        {
          name: '实体类型',
          type: 'pie',
          radius: ['42%', '70%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: false,
          itemStyle: {
            borderRadius: 4,
            borderColor: '#fff',
            borderWidth: 2,
          },
          label: { show: false },
          emphasis: {
            label: {
              show: true,
              fontSize: 12,
              fontWeight: 'bold',
            },
          },
          data: data.map((d) => ({ name: d.type || '未分类', value: d.count })),
        },
      ],
    }
    chart.setOption(option)

    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(chartRef.current)

    return () => {
      observer.disconnect()
      chart.dispose()
    }
  }, [data])

  if (!data.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无类型分布" />
  }

  return <div ref={chartRef} className="kh-type-pie" style={{ width: '100%', height: 180 }} />
}

export default function GraphPage() {
  const navigate = useNavigate()
  const graphRef = useRef<ForceGraphRef>(null)

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<GraphOverview | null>(null)
  const [keyword, setKeyword] = useState('')
  const [entityType, setEntityType] = useState<string | undefined>()
  const [timeRange, setTimeRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [docLimit, setDocLimit] = useState(24)
  const [selectedNode, setSelectedNode] = useState<GraphViewNode | null>(null)

  async function loadGraph() {
    setLoading(true)
    try {
      const from = timeRange?.[0] ? timeRange[0].startOf('day').toISOString() : undefined
      const to = timeRange?.[1] ? timeRange[1].endOf('day').toISOString() : undefined

      const res = await graphApi.overview({
        keyword: keyword.trim() || undefined,
        entityType: entityType || undefined,
        from,
        to,
        docLimit,
      })
      setData(res)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '全景图谱数据加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadGraph()
  }, [])

  const nodes = data?.nodes || []
  const edges = data?.edges || []
  const stats = data?.stats
  const topEntities = data?.topEntities || []
  const recentNodes = data?.recentNodes || []
  const entityTypes = data?.entityTypes || []

  return (
    <div className="kh-page" style={{ height: '100%', padding: '16px 20px', overflow: 'hidden' }}>
      <div className="kh-graph-layout">
        {/* 左侧主图谱与交互区域 */}
        <div className="kh-graph-main">
          {/* 顶部条件过滤工具栏 */}
          <div className="kh-graph-toolbar">
            <Input
              allowClear
              placeholder="搜索实体、文档或标签"
              style={{ width: 200 }}
              value={keyword}
              prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={() => void loadGraph()}
            />
            <Select
              allowClear
              placeholder="实体类型"
              style={{ width: 130 }}
              value={entityType}
              onChange={setEntityType}
              options={entityTypes.map((t) => ({ label: t, value: t }))}
            />
            <RangePicker
              style={{ width: 230 }}
              value={timeRange}
              onChange={(dates) => setTimeRange(dates)}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140 }}>
              <span style={{ fontSize: 12, color: '#8c8c8c', whiteSpace: 'nowrap' }}>文档上限:</span>
              <Slider
                min={4}
                max={60}
                value={docLimit}
                onChange={setDocLimit}
                style={{ flex: 1, margin: '0 6px' }}
              />
              <span style={{ fontSize: 12, color: '#595959', width: 20 }}>{docLimit}</span>
            </div>
            <Space>
              <Button type="primary" loading={loading} onClick={() => void loadGraph()}>
                查询
              </Button>
              <Button
                onClick={() => {
                  setKeyword('')
                  setEntityType(undefined)
                  setTimeRange(null)
                  setDocLimit(24)
                }}
              >
                重置
              </Button>
            </Space>
          </div>

          {/* 图谱核心画布 */}
          <div className="kh-graph-canvas">
            {!loading && !nodes.length ? (
              <div className="kh-graph-empty">
                <Empty description="暂无符合条件的知识图谱网络，尝试放宽筛选条件" />
              </div>
            ) : (
              <ForceGraph
                ref={graphRef}
                nodes={nodes}
                edges={edges}
                loading={loading}
                onNodeClick={(node) => setSelectedNode(node)}
              />
            )}

            {/* 图例 */}
            <div className="kh-graph-legend">
              <span>
                <i style={{ background: '#1677ff' }} /> 文档
              </span>
              <span>
                <i style={{ background: '#52c41a' }} /> 实体/概念
              </span>
              <span>
                <i style={{ background: '#722ed1' }} /> 标签
              </span>
              <span>
                <span className="kh-legend-line kh-legend-blue" /> 提及
              </span>
              <span>
                <span className="kh-legend-dash kh-legend-grey" /> 关联
              </span>
              <span>
                <span className="kh-legend-dash kh-legend-purple" /> 标注
              </span>
            </div>

            {/* 视角控制悬浮按钮组 */}
            <div className="kh-graph-zoom">
              <Tooltip title="放大" placement="left">
                <Button
                  shape="circle"
                  size="small"
                  icon={<ZoomInOutlined />}
                  onClick={() => graphRef.current?.zoomIn()}
                />
              </Tooltip>
              <Tooltip title="缩小" placement="left">
                <Button
                  shape="circle"
                  size="small"
                  icon={<ZoomOutOutlined />}
                  onClick={() => graphRef.current?.zoomOut()}
                />
              </Tooltip>
              <Tooltip title="重置视角" placement="left">
                <Button
                  shape="circle"
                  size="small"
                  icon={<FullscreenExitOutlined />}
                  onClick={() => graphRef.current?.reset()}
                />
              </Tooltip>
              <Tooltip title="导出高清拓扑图" placement="left">
                <Button
                  shape="circle"
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={() => graphRef.current?.exportPng()}
                />
              </Tooltip>
            </div>

            <div className="kh-graph-hint">滚轮缩放 / 拖拽平移 / 点击节点查看详情</div>
          </div>
        </div>

        {/* 右侧统计与分析指标侧栏 */}
        <div className="kh-graph-side">
          {/* 卡片 1：数据规模 */}
          <div className="kh-graph-card">
            <h4>
              <ApartmentOutlined style={{ marginRight: 6, color: '#1677ff' }} />
              图谱规模概览
            </h4>
            <div className="kh-graph-stats">
              <div>
                <b>{stats?.nodeCount ?? nodes.length}</b>
                <span>当前画布节点</span>
              </div>
              <div>
                <b>{stats?.edgeCount ?? edges.length}</b>
                <span>当前拓扑边数</span>
              </div>
              <div>
                <b>{stats?.documentCount ?? 0}</b>
                <span>全库入图文档</span>
              </div>
              <div>
                <b>{stats?.entityCount ?? 0}</b>
                <span>全库知识实体</span>
              </div>
            </div>
          </div>

          {/* 卡片 2：实体类型分布饼图 */}
          <div className="kh-graph-card">
            <h4>实体类型占比</h4>
            <EntityTypePie data={stats?.entityTypes || []} />
          </div>

          {/* 卡片 3：热门知识点 TOP5 */}
          <div className="kh-graph-card">
            <h4>热门知识点 TOP 5</h4>
            {!topEntities.length ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无热门实体" />
            ) : (
              <ul className="kh-graph-rank">
                {topEntities.map((item, idx) => (
                  <li key={item.name}>
                    <span className="kh-rank">{idx + 1}</span>
                    <span className="kh-rank-name" title={item.name}>
                      {item.name}
                    </span>
                    {item.type ? (
                      <Tag color="cyan" style={{ fontSize: 10, margin: 0 }}>
                        {item.type}
                      </Tag>
                    ) : null}
                    <span className="kh-rank-n">{item.degree} 次提及</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 卡片 4：最近更新文档 */}
          <div className="kh-graph-card" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <h4>最新入图文档</h4>
            {!recentNodes.length ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无更新文档" />
            ) : (
              <div>
                {recentNodes.map((n) => {
                  const docId = n.id.replace(/^doc:/, '')
                  return (
                    <div className="kh-graph-recent" key={n.id}>
                      <a
                        onClick={() => navigate(`/documents/${docId}`)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13,
                          fontWeight: 500,
                          color: '#1677ff',
                          marginBottom: 2,
                        }}
                      >
                        <FileTextOutlined />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n.name}
                        </span>
                      </a>
                      <small>更新时间：{formatTime(n.updatedAt)}</small>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 节点点击详情抽屉 */}
      <Drawer
        title="节点详细信息"
        placement="right"
        width={340}
        open={Boolean(selectedNode)}
        onClose={() => setSelectedNode(null)}
      >
        {selectedNode ? (
          <div>
            <Card size="small" bordered={false} style={{ background: '#fafafa', marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#1f1f1f', marginBottom: 6 }}>
                {selectedNode.name}
              </div>
              <Space wrap size={[0, 8]}>
                <Tag color={selectedNode.kind === 'document' ? 'blue' : selectedNode.kind === 'tag' ? 'purple' : 'green'}>
                  {selectedNode.kind === 'document' ? '文档' : selectedNode.kind === 'tag' ? '标签' : '实体'}
                </Tag>
                {selectedNode.type ? <Tag color="geekblue">{selectedNode.type}</Tag> : null}
              </Space>
            </Card>

            {selectedNode.description ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>描述与摘要</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: '#262626' }}>{selectedNode.description}</div>
              </div>
            ) : null}

            {selectedNode.updatedAt ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>更新时间</div>
                <div style={{ fontSize: 13 }}>{formatTime(selectedNode.updatedAt)}</div>
              </div>
            ) : null}

            {selectedNode.documentId ? (
              <Button
                type="primary"
                block
                icon={<InfoCircleOutlined />}
                onClick={() => navigate(`/documents/${selectedNode.documentId}`)}
              >
                查看原文档详情
              </Button>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
