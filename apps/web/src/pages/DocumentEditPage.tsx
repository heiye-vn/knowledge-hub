import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Empty, Form, Input, Select, Spin, Switch, message } from 'antd'
import { documentApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem, TeamItem } from '../types'
import { useAuth } from '../auth'
import { canWriteDocument, flattenTeams, isAdmin } from '../utils'

export default function DocumentEditPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const user = useAuth()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(!isNew)
  const [forbidden, setForbidden] = useState(false)
  const [teams, setTeams] = useState<TeamItem[]>([])
  const [doc, setDoc] = useState<DocumentItem | null>(null)

  // 团队下拉数据源：管理员看全量团队树（打平），普通用户只看自己所在团队
  useEffect(() => {
    const req = isAdmin(user) ? teamApi.tree().then(flattenTeams) : teamApi.mine()
    req.then((rows) => setTeams(rows as TeamItem[])).catch(() => setTeams([]))
  }, [user])

  useEffect(() => {
    if (!id) return
    documentApi
      .get(id)
      .then((next) => {
        // 仅作者本人或管理员可编辑，其余直接收敛到 403 空状态
        if (!canWriteDocument(next, user)) {
          setForbidden(true)
          message.error('无权编辑该文档')
          return
        }
        setDoc(next)
        form.setFieldsValue({
          title: next.title,
          summary: next.summary,
          tags: next.tags,
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
    const options = (teams ?? []).map((team) => ({
      value: team.id,
      label: team.teamName,
    }))
    // 作者已不在该团队时，仍要保底展示当前归属，避免下拉显示为空
    if (doc?.teamId && !options.some((item) => item.value === doc.teamId)) {
      options.push({ value: doc.teamId, label: '当前团队' })
    }
    return options
  }, [teams, doc?.teamId])

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

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>{isNew ? '新建文档' : '编辑文档'}</h2>
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
          isPublic: boolean
          teamId?: string
          content: string
        }) => {
          try {
            const payload = {
              title: values.title,
              content: values.content,
              summary: values.summary || undefined,
              tags: values.tags || undefined,
              isPublic: values.isPublic,
              teamId: values.teamId || null,
            }
            if (isNew) {
              const created = await documentApi.create({
                ...payload,
                status: 0,
              })
              message.success('已保存为草稿')
              navigate(`/documents/${created.id}`)
            } else if (id) {
              await documentApi.update(id, payload)
              message.success('文档已更新保存')
              navigate(`/documents/${id}`)
            }
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
