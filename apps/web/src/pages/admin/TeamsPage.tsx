import { useEffect, useState } from 'react'
import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd'
import { teamApi, userApi } from '../../api'
import { ApiError } from '../../api/client'
import type { TeamItem } from '../../types'

interface MemberRow {
  userId: string
  username: string
  realName?: string
  memberRole?: string
}

export default function TeamsPage() {
  const [items, setItems] = useState<TeamItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTeam, setEditingTeam] = useState<TeamItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [membersFor, setMembersFor] = useState<TeamItem | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>()
  const [userOptions, setUserOptions] = useState<
    { value: string; label: string }[]
  >([])
  const [searching, setSearching] = useState(false)
  const [form] = Form.useForm()

  async function load(nextPage = page) {
    try {
      const res = await teamApi.page({
        page: nextPage,
        pageSize: 10,
        keyword: keyword.trim() || undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    }
  }

  /** 加载成员列表，并同步外层表格对应团队的成员数 */
  async function loadMembers(teamId: string) {
    const rows = (await teamApi.members(teamId)) as MemberRow[]
    setMembers(rows)
    setItems((prev) =>
      prev.map((team) =>
        team.id === teamId ? { ...team, memberCount: rows.length } : team,
      ),
    )
    return rows
  }

  /** 按用户名搜索可添加的成员（排除已在团队内的），可见性按团队生效后成员管理是高频操作 */
  async function searchUsers(query: string) {
    const kw = query.trim().toLowerCase()
    if (!kw) {
      setUserOptions([])
      return
    }
    setSearching(true)
    try {
      const res = await userApi.page({
        keyword: query.trim(),
        page: 1,
        pageSize: 20,
      })
      const taken = new Set(members.map((row) => row.userId))
      setUserOptions(
        res.items
          .filter(
            (user) =>
              !taken.has(user.id) && user.username.toLowerCase().includes(kw),
          )
          .map((user) => ({
            value: user.id,
            label: user.realName
              ? `${user.username}（${user.realName}）`
              : user.username,
          })),
      )
    } catch (error) {
      message.error(
        error instanceof ApiError ? error.message : '搜索用户失败',
      )
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    void load(1)
  }, [])

  function openCreate() {
    setEditingTeam(null)
    form.resetFields()
    form.setFieldsValue({ enabled: true })
    setModalOpen(true)
  }

  function openEdit(row: TeamItem) {
    setEditingTeam(row)
    form.setFieldsValue({
      teamName: row.teamName,
      teamCode: row.teamCode ?? '',
      description: row.description ?? '',
      enabled: (row.status ?? 1) === 1,
    })
    setModalOpen(true)
  }

  async function handleDelete(row: TeamItem) {
    try {
      await teamApi.remove(row.id)
      message.success('团队已删除')
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page
      void load(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '删除失败')
    }
  }

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }}>
        <Input
          placeholder="团队名称"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => void load(1)}
        />
        <Button onClick={() => void load(1)}>查询</Button>
        <Button type="primary" onClick={openCreate}>
          新建团队
        </Button>
      </Space>
      <Table
        rowKey="id"
        dataSource={items}
        pagination={{
          current: page,
          pageSize: 10,
          total,
          onChange: (p) => void load(p),
        }}
        columns={[
          { title: '名称', dataIndex: 'teamName' },
          {
            title: '编码',
            dataIndex: 'teamCode',
            render: (v?: string | null) => v || '-',
          },
          {
            title: '说明',
            dataIndex: 'description',
            render: (v?: string | null) => v || '-',
          },
          {
            title: '成员数',
            dataIndex: 'memberCount',
            width: 100,
            render: (v?: number) => v ?? 0,
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 96,
            render: (s?: number) => (
              <Tag color={(s ?? 1) === 1 ? 'success' : 'default'}>
                {(s ?? 1) === 1 ? '启用' : '禁用'}
              </Tag>
            ),
          },
          {
            title: '操作',
            width: 220,
            render: (_: unknown, row: TeamItem) => (
              <Space size={12}>
                <a onClick={() => openEdit(row)}>编辑</a>
                <a
                  onClick={async () => {
                    setMembersFor(row)
                    setSelectedUserId(undefined)
                    setUserOptions([])
                    try {
                      await loadMembers(row.id)
                    } catch (error) {
                      message.error(
                        error instanceof ApiError
                          ? error.message
                          : '加载成员失败',
                      )
                    }
                  }}
                >
                  成员管理
                </a>
                <Popconfirm
                  title={`确定删除团队「${row.teamName}」？`}
                  description="删除后将清空该团队的成员绑定；存在子团队时无法删除。"
                  okText="删除"
                  okType="danger"
                  cancelText="取消"
                  onConfirm={() => void handleDelete(row)}
                >
                  <a style={{ color: '#c53030' }}>删除</a>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      {/* 新建 / 编辑团队弹窗 */}
      <Modal
        title={editingTeam ? `编辑团队 - ${editingTeam.teamName}` : '新建团队'}
        open={modalOpen}
        confirmLoading={saving}
        onCancel={() => {
          setModalOpen(false)
          setEditingTeam(null)
        }}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            teamName: string
            teamCode?: string
            description?: string
            enabled?: boolean
          }) => {
            setSaving(true)
            try {
              const payload = {
                teamName: values.teamName.trim(),
                teamCode: values.teamCode?.trim() || undefined,
                description: values.description?.trim() ?? '',
                status: values.enabled === false ? 0 : 1,
              }
              if (editingTeam) {
                await teamApi.update(editingTeam.id, payload)
                message.success('团队信息已更新')
              } else {
                await teamApi.create(payload)
                message.success('团队已创建')
              }
              setModalOpen(false)
              setEditingTeam(null)
              form.resetFields()
              void load(editingTeam ? page : 1)
            } catch (error) {
              message.error(
                error instanceof ApiError ? error.message : '保存失败',
              )
            } finally {
              setSaving(false)
            }
          }}
        >
          <Form.Item
            name="teamName"
            label="团队名称"
            rules={[{ required: true, message: '请输入团队名称' }]}
          >
            <Input placeholder="如 研发团队" maxLength={100} />
          </Form.Item>
          <Form.Item name="teamCode" label="编码">
            <Input placeholder="如 R_AND_D" maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} placeholder="团队职责描述" maxLength={500} />
          </Form.Item>
          {editingTeam ? (
            <Form.Item name="enabled" label="状态" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="禁用" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      {/* 成员管理弹窗 */}
      <Modal
        title={membersFor ? `${membersFor.teamName} - 成员列表` : '成员列表'}
        open={Boolean(membersFor)}
        footer={null}
        onCancel={() => setMembersFor(null)}
        width={640}
      >
        <Space style={{ width: '100%', marginBottom: 16 }} wrap>
          <Select
            showSearch
            filterOption={false}
            onSearch={(value) => void searchUsers(value)}
            allowClear
            placeholder="按用户名搜索"
            value={selectedUserId}
            options={userOptions}
            loading={searching}
            onChange={(value) => setSelectedUserId(value)}
            style={{ width: 280 }}
            notFoundContent={searching ? '搜索中…' : '输入用户名搜索'}
          />
          <Button
            type="primary"
            onClick={async () => {
              if (!membersFor || !selectedUserId) {
                message.warning('请先按用户名搜索并选择成员')
                return
              }
              try {
                await teamApi.addMembers(membersFor.id, [selectedUserId])
                await loadMembers(membersFor.id)
                setSelectedUserId(undefined)
                setUserOptions([])
                message.success('已添加成员')
              } catch (error) {
                message.error(
                  error instanceof ApiError ? error.message : '添加成员失败',
                )
              }
            }}
          >
            添加成员
          </Button>
        </Space>
        <Table
          rowKey="userId"
          size="small"
          dataSource={members}
          pagination={false}
          columns={[
            { title: '用户名', dataIndex: 'username' },
            { title: '姓名', dataIndex: 'realName' },
            { title: '角色', dataIndex: 'memberRole' },
            {
              title: '操作',
              width: 80,
              render: (_: unknown, m: MemberRow) => (
                <Popconfirm
                  title={`确定将 ${m.username} 移出团队？`}
                  okText="移出"
                  okType="danger"
                  cancelText="取消"
                  onConfirm={async () => {
                    if (!membersFor) return
                    try {
                      await teamApi.removeMembers(membersFor.id, [m.userId])
                      await loadMembers(membersFor.id)
                      message.success('已移出')
                    } catch (error) {
                      message.error(
                        error instanceof ApiError
                          ? error.message
                          : '移出失败',
                      )
                    }
                  }}
                >
                  <a style={{ color: '#c53030' }}>移出</a>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}
