import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Alert, Button, Empty, Form, Input, Select, Spin, Switch, message } from 'antd'
import { categoryApi, documentApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem, ReviewTask } from '../types'
import { useAuth } from '../auth'
import {
  canWriteDocument,
  flattenCategories,
  flattenTeams,
  formatTime,
  isAdmin,
} from '../utils'

export default function DocumentEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const user = useAuth()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [baseTeamOptions, setBaseTeamOptions] = useState<
    { value: string; label: string }[]
  >([])
  const [categories, setCategories] = useState<{ value: string; label: string }[]>([])
  const [doc, setDoc] = useState<DocumentItem | null>(null)
  const [reviewHistory, setReviewHistory] = useState<ReviewTask[]>([])

  // 团队下拉数据源：管理员看全量团队树（打平带层级缩进），普通用户只看自己所在团队
  useEffect(() => {
    const req = isAdmin(user)
      ? teamApi
          .tree()
          .then((tree) =>
            flattenTeams(tree).map((t) => ({ value: t.id, label: t.name })),
          )
      : teamApi
          .mine()
          .then((rows) =>
            rows.map((t) => ({ value: t.id, label: t.teamName })),
          )
    req.then(setBaseTeamOptions).catch(() => setBaseTeamOptions([]))
    categoryApi
      .tree()
      .then((tree) =>
        setCategories(
          flattenCategories(tree).map((item) => ({
            value: item.id,
            label: item.label,
          })),
        ),
      )
      .catch(() => setCategories([]))
  }, [user])

  useEffect(() => {
    if (!id) return
    Promise.all([
      documentApi.get(id),
      documentApi.reviewHistory(id).catch(() => [] as ReviewTask[]),
    ])
      .then(([next, history]) => {
        // 仅作者本人或管理员可编辑，其余直接收敛到 403 空状态
        if (!canWriteDocument(next, user)) {
          setForbidden(true)
          message.error('无权编辑该文档')
          return
        }
        setDoc(next)
        setReviewHistory(history)
        form.setFieldsValue({
          title: next.title,
          summary: next.summary,
          tags: next.tags,
          categoryId: next.categoryId || undefined,
          isPublic: next.isPublic,
          teamId: next.teamId || undefined,
          content: next.content,
        })
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 403) {
          setForbidden(true)
          message.error('无权查看该文档')
        } else {
          message.error(error instanceof ApiError ? error.message : '加载失败')
        }
      })
      .finally(() => setLoading(false))
  }, [id, form, user])

  const teamOptions = useMemo(() => {
    const options = [...baseTeamOptions]
    // 作者已不在该团队时，仍要保底展示当前归属，避免下拉显示为空
    if (doc?.teamId && !options.some((item) => item.value === doc.teamId)) {
      options.push({ value: doc.teamId, label: '当前团队' })
    }
    return options
  }, [baseTeamOptions, doc?.teamId])

  if (loading) {
    return (
      <div className="kh-page">
        <Spin />
      </div>
    )
  }

  if (forbidden) {
    return (
      <div className="kh-page">
        <Empty description="无权编辑该文档">
          <Button onClick={() => navigate('/documents')}>返回列表</Button>
        </Empty>
      </div>
    )
  }

  if (doc && doc.status !== 0) {
    const blockMessage =
      doc.status === 1
        ? '已发布文档不可直接编辑，请先在文档详情页点击「下架编辑」转为草稿'
        : doc.status === 3
          ? '文档正在审核中，暂不可编辑'
          : '已归档文档为只读终态，不可编辑'
    return (
      <div className="kh-page">
        <Empty description={blockMessage}>
          <Button onClick={() => navigate(`/documents/${id}`)}>
            返回文档详情
          </Button>
        </Empty>
      </div>
    )
  }

  const latestReview = reviewHistory[0]
  const rejectedNotice =
    doc?.status === 0 && latestReview?.reviewResult === 2 ? latestReview : null

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>编辑文档</h2>
      {rejectedNotice ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="最近一次发布审核未通过"
          description={
            <div>
              <div>驳回原因：{rejectedNotice.reviewComment || '未填写'}</div>
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                审核人：{rejectedNotice.reviewerName || '-'} ·{' '}
                {formatTime(rejectedNotice.reviewedAt || rejectedNotice.createdAt)}
              </div>
            </div>
          }
        />
      ) : null}
      <p className="kh-access-hint">
        公开：所有登录用户可见。指定团队：发布后团队成员可见。都不选：仅自己可见。
      </p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ isPublic: false, content: '' }}
        onFinish={async (values: {
          title: string
          summary?: string
          tags?: string
          categoryId?: string
          isPublic: boolean
          teamId?: string
          content: string
        }) => {
          if (!id) return
          try {
            const payload = {
              title: values.title,
              content: values.content,
              summary: values.summary || undefined,
              tags: values.tags || undefined,
              categoryId: values.categoryId || null,
              isPublic: values.isPublic,
              teamId: values.teamId || null,
            }
            await documentApi.update(id, payload)
            message.success('文档已更新保存')
            navigate(`/documents/${id}`)
          } catch (error) {
            message.error(
              error instanceof ApiError ? error.message : '保存失败',
            )
          }
        }}
      >
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, message: '请输入文档标题' }]}
        >
          <Input placeholder="输入文档标题" />
        </Form.Item>
        <Form.Item name="summary" label="摘要">
          <Input.TextArea rows={2} placeholder="输入摘要" />
        </Form.Item>
        <Form.Item name="tags" label="标签">
          <Input placeholder="英文或中文逗号分隔，如 财务,报销,SOP" />
        </Form.Item>
        <Form.Item name="categoryId" label="分类">
          <Select allowClear placeholder="选择分类" options={categories} />
        </Form.Item>
        <Form.Item
          name="isPublic"
          label="公开"
          valuePropName="checked"
          extra="打开后，已发布文档对所有登录用户可见"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="teamId"
          label="所属团队"
          extra={
            teamOptions.length
              ? '发布后，该团队成员可见（即使未公开）'
              : '你尚未加入任何团队，只能设为公开或仅自己可见'
          }
        >
          <Select
            allowClear
            placeholder="不指定则仅自己可见（未公开时）"
            options={teamOptions}
            disabled={!teamOptions.length}
          />
        </Form.Item>
        <Form.Item
          name="content"
          label="正文（Markdown 格式）"
          rules={[{ required: true, message: '请输入正文' }]}
        >
          <Input.TextArea
            rows={18}
            placeholder="# 章节标题&#10;&#10;输入文档正文内容..."
          />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          保存
        </Button>
      </Form>
    </div>
  )
}
