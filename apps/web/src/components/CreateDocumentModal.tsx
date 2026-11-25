import { useEffect, useState } from 'react'
import { Col, Form, Input, Modal, Row, Select, Switch, message } from 'antd'
import { documentApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import { useAuth } from '../auth'
import type { DocumentItem } from '../types'
import { flattenTeams, isAdmin } from '../utils'

type SelectOption = {
  value: string
  label: string
}

type CreateDocFormValues = {
  title: string
  summary?: string
  tags?: string
  categoryId?: string
  isPublic: boolean
  teamId?: string
  content: string
}

/**
 * 在线新建文档弹窗：
 * 作为企业混合知识库中「上传文件」的轻量补充入口，用于快速编写 FAQ、规范说明或 RAG 纠偏补丁。
 */
export function CreateDocumentModal({
  open,
  categories,
  onCancel,
  onCreated,
}: {
  open: boolean
  categories: SelectOption[]
  onCancel: () => void
  onCreated: (doc: DocumentItem) => void
}) {
  const user = useAuth()
  const [form] = Form.useForm<CreateDocFormValues>()
  const [submitting, setSubmitting] = useState(false)
  const [teamOptions, setTeamOptions] = useState<SelectOption[]>([])
  const [teamsLoaded, setTeamsLoaded] = useState(false)

  // 打开弹窗时按需加载团队列表：管理员看打平后的全量团队树（带层级缩进），普通用户看自己所在团队
  useEffect(() => {
    if (!open || teamsLoaded) return
    let cancelled = false
    const req: Promise<SelectOption[]> = isAdmin(user)
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
    req
      .then((options) => {
        if (!cancelled) {
          setTeamOptions(options)
          setTeamsLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setTeamOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [open, teamsLoaded, user])

  function handleClose() {
    if (submitting) return
    form.resetFields()
    onCancel()
  }

  async function handleSubmit() {
    let values: CreateDocFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSubmitting(true)
    try {
      const created = await documentApi.create({
        title: values.title.trim(),
        content: values.content,
        summary: values.summary?.trim() || undefined,
        tags: values.tags?.trim() || undefined,
        categoryId: values.categoryId || null,
        isPublic: values.isPublic,
        teamId: values.teamId || null,
        status: 0,
      })
      message.success('已保存为草稿')
      form.resetFields()
      onCreated(created)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '创建文档失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="在线新建文档"
      width={760}
      centered
      maskClosable={!submitting}
      closable={!submitting}
      okText="保存草稿"
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={handleClose}
      onOk={() => void handleSubmit()}
      styles={{
        body: {
          maxHeight: 'calc(100vh - 220px)',
          overflowY: 'auto',
          paddingTop: 8,
        },
      }}
    >
      <p className="kh-access-hint" style={{ marginBottom: 14 }}>
        适合编写 FAQ、规范口径或 RAG 纠偏补丁。公开：所有登录用户可见；指定团队：发布后团队成员可见；都不选：仅自己可见。
      </p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ isPublic: false, content: '' }}
      >
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, message: '请输入文档标题' }]}
        >
          <Input placeholder="输入文档标题，如：报销审批口径说明" />
        </Form.Item>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="categoryId" label="分类">
              <Select allowClear placeholder="选择分类" options={categories} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="teamId"
              label="所属团队"
              extra={
                teamOptions.length
                  ? '发布后，该团队成员可见（即使未公开）'
                  : '尚未加入团队，仅可设为公开或仅自己可见'
              }
            >
              <Select
                allowClear
                placeholder="不指定则仅自己可见（未公开时）"
                options={teamOptions}
                disabled={!teamOptions.length}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={16}>
            <Form.Item name="tags" label="标签">
              <Input placeholder="英文或中文逗号分隔，如 财务,报销,SOP" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="isPublic"
              label="公开可见"
              valuePropName="checked"
              extra="发布后对所有登录用户可见"
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="summary" label="摘要">
          <Input.TextArea rows={2} placeholder="可选，简要概括文档核心结论" />
        </Form.Item>

        <Form.Item
          name="content"
          label="正文（Markdown 格式）"
          rules={[{ required: true, message: '请输入正文' }]}
          style={{ marginBottom: 0 }}
        >
          <Input.TextArea
            rows={10}
            placeholder={'# 章节标题\n\n输入文档正文内容…'}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
