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
  Tooltip,
  TreeSelect,
  message,
} from 'antd'
import { permissionApi, roleApi, userApi } from '../../api'
import { ApiError } from '../../api/client'
import { useAuth } from '../../auth'
import type { PermissionNode, RoleItem, UserVO } from '../../types'
import { formatTime } from '../../utils'

interface PermSelectNode {
  title: string
  value: string
  key: string
  children?: PermSelectNode[]
}

function toTreeSelect(nodes: PermissionNode[]): PermSelectNode[] {
  return nodes.map((n) => ({
    title: `${n.permissionName} (${n.permissionCode})`,
    value: n.permissionCode,
    key: n.permissionCode,
    children: n.children?.length ? toTreeSelect(n.children) : undefined,
  }))
}

export default function UsersPage() {
  const currentUser = useAuth()
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<UserVO[]>([])
  const [roles, setRoles] = useState<RoleItem[]>([])
  const [permTree, setPermTree] = useState<PermissionNode[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<UserVO | null>(null)
  const [saving, setSaving] = useState(false)

  // 角色分配
  const [roleUser, setRoleUser] = useState<UserVO | null>(null)
  const [roleCodes, setRoleCodes] = useState<string[]>([])

  // 重置密码
  const [pwdUser, setPwdUser] = useState<UserVO | null>(null)
  const [newPassword, setNewPassword] = useState('')

  // 用户直接赋权（主项目扩展特性）
  const [permUser, setPermUser] = useState<UserVO | null>(null)
  const [userPermCodes, setUserPermCodes] = useState<string[]>([])

  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await userApi.page({
        page: nextPage,
        pageSize: 10,
        keyword: keyword.trim() || undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
    roleApi.list().then(setRoles).catch(() => undefined)
    permissionApi.tree().then(setPermTree).catch(() => undefined)
  }, [])

  function openEdit(row: UserVO) {
    setEditingUser(row)
    editForm.setFieldsValue({
      username: row.username,
      realName: row.realName ?? '',
      email: row.email ?? '',
      enabled: row.status === 1,
    })
  }

  async function toggleStatus(row: UserVO) {
    const nextStatus = row.status === 1 ? 0 : 1
    try {
      await userApi.update(row.id, { status: nextStatus })
      message.success(nextStatus === 1 ? '已启用账号' : '已禁用账号')
      void load(page)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '更新状态失败')
    }
  }

  async function handleDelete(row: UserVO) {
    try {
      await userApi.remove(row.id)
      message.success('用户已删除')
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
          placeholder="用户名 / 姓名 / 邮箱"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => void load(1)}
        />
        <Button onClick={() => void load(1)}>查询</Button>
        <Button
          type="primary"
          onClick={() => {
            createForm.resetFields()
            setCreateOpen(true)
          }}
        >
          新建用户
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{
          current: page,
          pageSize: 10,
          total,
          onChange: (p) => void load(p),
        }}
        columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '姓名', dataIndex: 'realName', render: (v?: string | null) => v || '-' },
          { title: '邮箱', dataIndex: 'email', render: (v?: string | null) => v || '-' },
          {
            title: '角色',
            dataIndex: 'roleCodes',
            render: (codes: string[]) =>
              codes?.map((c) => (
                <Tag color="blue" key={c}>
                  {c}
                </Tag>
              )),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 88,
            render: (s: number) => (
              <Tag color={s === 1 ? 'success' : 'default'}>
                {s === 1 ? '启用' : '禁用'}
              </Tag>
            ),
          },
          { title: '最近登录', dataIndex: 'lastLoginAt', width: 168, render: formatTime },
          {
            title: '操作',
            width: 340,
            render: (_: unknown, row: UserVO) => {
              const isSelf = row.id === currentUser?.userId
              return (
                <Space size={12} wrap>
                  <a onClick={() => openEdit(row)}>编辑</a>
                  {isSelf ? (
                    <Tooltip title="不能禁用当前登录账号">
                      <span style={{ color: '#bfbfbf', cursor: 'not-allowed' }}>
                        禁用
                      </span>
                    </Tooltip>
                  ) : (
                    <Popconfirm
                      title={
                        row.status === 1
                          ? `确定禁用账号「${row.username}」？`
                          : `确定启用账号「${row.username}」？`
                      }
                      okText="确定"
                      cancelText="取消"
                      onConfirm={() => void toggleStatus(row)}
                    >
                      <a>{row.status === 1 ? '禁用' : '启用'}</a>
                    </Popconfirm>
                  )}
                  <a
                    onClick={() => {
                      setPwdUser(row)
                      setNewPassword('')
                    }}
                  >
                    重置密码
                  </a>
                  <a
                    onClick={() => {
                      setRoleUser(row)
                      setRoleCodes(row.roleCodes || [])
                    }}
                  >
                    分配角色
                  </a>
                  <a
                    onClick={async () => {
                      setPermUser(row)
                      try {
                        const res = await userApi.getPermissions(row.id)
                        setUserPermCodes(res.permissionCodes || [])
                      } catch {
                        setUserPermCodes([])
                      }
                    }}
                  >
                    直接授权
                  </a>
                  {isSelf ? (
                    <Tooltip title="不能删除当前登录账号">
                      <span style={{ color: '#bfbfbf', cursor: 'not-allowed' }}>
                        删除
                      </span>
                    </Tooltip>
                  ) : (
                    <Popconfirm
                      title={`确定删除用户「${row.username}」？`}
                      description="采用软删除，其历史创建的文档记录仍会保留。"
                      okText="删除"
                      okType="danger"
                      cancelText="取消"
                      onConfirm={() => void handleDelete(row)}
                    >
                      <a style={{ color: '#c53030' }}>删除</a>
                    </Popconfirm>
                  )}
                </Space>
              )
            },
          },
        ]}
      />

      {/* 新建用户弹窗 */}
      <Modal
        title="新建用户"
        open={createOpen}
        confirmLoading={saving}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={async (values: {
            username: string
            password: string
            realName?: string
            email?: string
            roleCodes?: string[]
          }) => {
            setSaving(true)
            try {
              await userApi.create({
                ...values,
                username: values.username.trim(),
                realName: values.realName?.trim() || undefined,
                email: values.email?.trim() || undefined,
              })
              message.success('用户已创建')
              setCreateOpen(false)
              void load(1)
            } catch (error) {
              message.error(
                error instanceof ApiError ? error.message : '创建失败',
              )
            } finally {
              setSaving(false)
            }
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="用户名" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}
          >
            <Input.Password placeholder="初始密码" />
          </Form.Item>
          <Form.Item name="realName" label="姓名">
            <Input placeholder="真实姓名" />
          </Form.Item>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ type: 'email', message: '请输入正确的邮箱格式' }]}
          >
            <Input placeholder="电子邮箱" />
          </Form.Item>
          <Form.Item name="roleCodes" label="角色">
            <Select
              mode="multiple"
              placeholder="选择角色"
              options={roles.map((r) => ({
                value: r.roleCode,
                label: `${r.roleName} (${r.roleCode})`,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑用户弹窗 */}
      <Modal
        title={editingUser ? `编辑用户 - ${editingUser.username}` : '编辑用户'}
        open={Boolean(editingUser)}
        confirmLoading={saving}
        onCancel={() => setEditingUser(null)}
        onOk={() => editForm.submit()}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={async (values: {
            username: string
            realName?: string
            email?: string
            enabled: boolean
          }) => {
            if (!editingUser) return
            setSaving(true)
            try {
              const body: Record<string, unknown> = {
                username: values.username.trim(),
                realName: values.realName?.trim() ?? '',
                status: values.enabled ? 1 : 0,
              }
              const email = values.email?.trim()
              if (email) body.email = email
              await userApi.update(editingUser.id, body)
              message.success('用户信息已更新')
              setEditingUser(null)
              void load(page)
            } catch (error) {
              message.error(
                error instanceof ApiError ? error.message : '更新失败',
              )
            } finally {
              setSaving(false)
            }
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="用户名" />
          </Form.Item>
          <Form.Item name="realName" label="姓名">
            <Input placeholder="真实姓名" />
          </Form.Item>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ type: 'email', message: '请输入正确的邮箱格式' }]}
          >
            <Input placeholder="电子邮箱" />
          </Form.Item>
          <Form.Item
            name="enabled"
            label="账号状态"
            valuePropName="checked"
            extra={
              editingUser?.id === currentUser?.userId
                ? '当前登录账号不允许禁用'
                : '禁用后该用户将无法登录系统'
            }
          >
            <Switch
              checkedChildren="启用"
              unCheckedChildren="禁用"
              disabled={editingUser?.id === currentUser?.userId}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码弹窗 */}
      <Modal
        title={pwdUser ? `重置 ${pwdUser.username} 的密码` : '重置密码'}
        open={Boolean(pwdUser)}
        onCancel={() => setPwdUser(null)}
        onOk={async () => {
          if (!pwdUser) return
          if (newPassword.length < 6) {
            message.error('密码至少 6 位')
            return
          }
          try {
            await userApi.resetPassword(pwdUser.id, newPassword)
            message.success('密码已重置')
            setPwdUser(null)
          } catch (error) {
            message.error(
              error instanceof ApiError ? error.message : '重置失败',
            )
          }
        }}
      >
        <Input.Password
          placeholder="新密码至少 6 位"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Modal>

      {/* 分配角色弹窗 */}
      <Modal
        title={`分配角色 - ${roleUser?.username}`}
        open={Boolean(roleUser)}
        onCancel={() => setRoleUser(null)}
        onOk={async () => {
          if (!roleUser) return
          if (!roleCodes.length) {
            message.error('至少选择一个角色')
            return
          }
          try {
            await userApi.assignRoles(roleUser.id, roleCodes)
            message.success('角色分配已更新')
            setRoleUser(null)
            void load()
          } catch (error) {
            message.error(
              error instanceof ApiError ? error.message : '更新失败',
            )
          }
        }}
      >
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          value={roleCodes}
          onChange={setRoleCodes}
          options={roles.map((r) => ({
            value: r.roleCode,
            label: `${r.roleName} (${r.roleCode})`,
          }))}
        />
      </Modal>

      {/* 用户直接赋权弹窗（主项目独有功能） */}
      <Modal
        title={`用户直接赋权 - ${permUser?.username}`}
        open={Boolean(permUser)}
        onCancel={() => setPermUser(null)}
        onOk={async () => {
          if (!permUser) return
          try {
            await userApi.assignPermissions(permUser.id, userPermCodes)
            message.success('用户独立权限已更新')
            setPermUser(null)
          } catch (error) {
            message.error(
              error instanceof ApiError ? error.message : '赋权失败',
            )
          }
        }}
      >
        <p style={{ color: '#8c8c8c', marginBottom: 12 }}>
          除角色绑定的权限外，可为该用户单独追加或定制独立权限码。
        </p>
        <TreeSelect
          treeData={toTreeSelect(permTree)}
          value={userPermCodes}
          onChange={setUserPermCodes}
          treeCheckable
          showCheckedStrategy={TreeSelect.SHOW_ALL}
          placeholder="请选择要直接赋予的权限码"
          style={{ width: '100%' }}
          maxTagCount={6}
        />
      </Modal>
    </div>
  )
}
