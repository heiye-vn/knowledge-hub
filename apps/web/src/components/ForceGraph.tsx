import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as echarts from 'echarts'
import type { GraphViewEdge, GraphViewNode } from '../types'

export interface ForceGraphRef {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  exportPng: (filename?: string) => void
}

interface ForceGraphProps {
  nodes: GraphViewNode[]
  edges: GraphViewEdge[]
  onNodeClick?: (node: GraphViewNode) => void
  loading?: boolean
}

/** 节点配色规范 */
const COLOR_MAP: Record<string, string> = {
  document: '#1677ff', // 文档蓝
  tag: '#722ed1', // 标签紫
  PERSON: '#fa8c16', // 人物橙
  ORG: '#13c2c2', // 组织青
  CONCEPT: '#52c41a', // 知识点/概念绿
  DEFAULT_ENTITY: '#389e0d',
}

function getNodeColor(node: GraphViewNode): string {
  if (node.kind === 'document') return COLOR_MAP.document
  if (node.kind === 'tag') return COLOR_MAP.tag
  const type = (node.type || '').toUpperCase()
  return COLOR_MAP[type] || COLOR_MAP.DEFAULT_ENTITY
}

export const ForceGraph = forwardRef<ForceGraphRef, ForceGraphProps>(
  ({ nodes, edges, onNodeClick, loading }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<echarts.ECharts | null>(null)

    // 暴露图表缩放、重置与导出能力
    useImperativeHandle(ref, () => ({
      zoomIn: () => {
        const chart = chartRef.current
        if (!chart) return
        const currentOption = chart.getOption() as echarts.EChartsOption
        const series = Array.isArray(currentOption.series)
          ? currentOption.series[0]
          : currentOption.series
        if (series && typeof series === 'object' && 'zoom' in series) {
          const currentZoom = (series.zoom as number) || 1
          chart.setOption({
            series: [{ zoom: Math.min(currentZoom * 1.25, 5) }],
          })
        }
      },
      zoomOut: () => {
        const chart = chartRef.current
        if (!chart) return
        const currentOption = chart.getOption() as echarts.EChartsOption
        const series = Array.isArray(currentOption.series)
          ? currentOption.series[0]
          : currentOption.series
        if (series && typeof series === 'object' && 'zoom' in series) {
          const currentZoom = (series.zoom as number) || 1
          chart.setOption({
            series: [{ zoom: Math.max(currentZoom * 0.8, 0.2) }],
          })
        }
      },
      reset: () => {
        const chart = chartRef.current
        if (!chart) return
        chart.setOption({
          series: [{ zoom: 1, center: undefined }],
        })
      },
      exportPng: (filename = 'knowledge-graph.png') => {
        const chart = chartRef.current
        if (!chart) return
        const url = chart.getDataURL({
          type: 'png',
          pixelRatio: 2,
          backgroundColor: '#ffffff',
        })
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
      },
    }))

    // 初始化 ECharts 实例与事件监听
    useEffect(() => {
      if (!containerRef.current) return
      const chart = echarts.init(containerRef.current)
      chartRef.current = chart

      chart.on('click', 'series.graph', (params) => {
        if (params.dataType === 'node' && params.data) {
          const raw = (params.data as { rawNode?: GraphViewNode }).rawNode
          if (raw && onNodeClick) {
            onNodeClick(raw)
          }
        }
      })

      const resizeObserver = new ResizeObserver(() => {
        chart.resize()
      })
      resizeObserver.observe(containerRef.current)

      return () => {
        resizeObserver.disconnect()
        chart.dispose()
        chartRef.current = null
      }
    }, [onNodeClick])

    // 数据驱动渲染拓扑
    useEffect(() => {
      const chart = chartRef.current
      if (!chart) return

      if (loading) {
        chart.showLoading({
          text: '图谱数据加载中...',
          color: '#1677ff',
          textColor: '#595959',
          maskColor: 'rgba(255, 255, 255, 0.6)',
        })
        return
      }

      chart.hideLoading()

      // 计算每个节点的度数以调整 symbolSize
      const degreeMap = new Map<string, number>()
      for (const edge of edges) {
        degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1)
        degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1)
      }

      const chartNodes = nodes.map((n) => {
        const degree = degreeMap.get(n.id) || 0
        const isDoc = n.kind === 'document'
        const baseSize = isDoc ? 26 : n.kind === 'tag' ? 18 : 22
        const size = Math.min(baseSize + degree * 2, 50)
        const color = getNodeColor(n)

        return {
          id: n.id,
          name: n.name,
          symbolSize: size,
          itemStyle: {
            color,
            borderColor: '#ffffff',
            borderWidth: 2,
            shadowColor: 'rgba(0, 0, 0, 0.12)',
            shadowBlur: 6,
          },
          label: {
            show: degree >= 2 || isDoc,
            position: 'bottom' as const,
            formatter: '{b}',
            fontSize: isDoc ? 12 : 11,
            color: '#262626',
          },
          rawNode: n,
        }
      })

      const chartLinks = edges.map((e) => {
        let isDashed = false
        let color = '#8c8c8c'
        let curveness = 0.1

        if (e.kind === 'mentions') {
          color = '#1677ff'
          isDashed = false
          curveness = 0.12
        } else if (e.kind === 'tagged') {
          color = '#722ed1'
          isDashed = true
          curveness = 0.06
        } else if (e.kind === 'related') {
          color = '#bfbfbf'
          isDashed = true
          curveness = 0.2
        }

        return {
          source: e.source,
          target: e.target,
          value: 1,
          rawRelation: e.relation,
          lineStyle: {
            color,
            width: e.kind === 'mentions' ? 1.5 : 1.2,
            type: (isDashed ? 'dashed' : 'solid') as 'dashed' | 'solid',
            curveness,
          },
        }
      })

      const option: echarts.EChartsOption = {
        tooltip: {
          trigger: 'item',
          formatter: (params: unknown) => {
            const p = params as
              | {
                  dataType: 'node'
                  data: {
                    name?: string
                    rawNode?: GraphViewNode
                  }
                }
              | {
                  dataType: 'edge'
                  data: {
                    rawRelation?: string
                    value?: number
                    source?: string
                    target?: string
                  }
                }

            if (p.dataType === 'node' && p.data?.rawNode) {
              const node = p.data.rawNode
              const kindLabel =
                node.kind === 'document'
                  ? '文档'
                  : node.kind === 'tag'
                    ? '标签'
                    : `实体 (${node.type || '通用'})`
              return `<div style="font-size:12px;max-width:280px;">
                <div style="font-weight:600;margin-bottom:4px;">${node.name}</div>
                <div style="color:#8c8c8c;">类型：${kindLabel}</div>
                ${node.description ? `<div style="margin-top:4px;color:#595959;">${node.description}</div>` : ''}
              </div>`
            }
            if (p.dataType === 'edge' && p.data) {
              return `<div style="font-size:12px;">关系：<b>${p.data.rawRelation || '关联'}</b></div>`
            }
            return ''
          },
        },
        series: [
          {
            type: 'graph',
            layout: 'force',
            animation: false,
            data: chartNodes,
            links: chartLinks,
            roam: true,
            draggable: true,
            edgeSymbol: ['none', 'none'],
            emphasis: {
              focus: 'adjacency',
              lineStyle: {
                width: 3,
              },
            },
            force: {
              repulsion: 220,
              edgeLength: [60, 140],
              gravity: 0.12,
              friction: 0.6,
            },
            labelLayout: {
              hideOverlap: true,
            },
          },
        ],
      }

      chart.setOption(option, true)
    }, [nodes, edges, loading])

    return (
      <div
        className="kh-force-wrap"
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
    )
  },
)
