import { useEffect, useState } from 'react'
import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Tree,
  message,
} from 'antd'
import type { TreeDataNode } from 'antd'
import { permissionApi, roleApi } from '../../api'
import { ApiError } from '../../api/client'
import type { PermissionNode, RoleItem } from '../../types'

const BUILTIN_ROLE_CODES = new Set(['ROLE_ADMIN', 'ROLE_REVIEWER', 'ROLE_USER'])

function toTree(nodes: PermissionNode[]): TreeDataNode[] {
  return nodes.map((n) => ({
    title: `${n.permissionName} (${n.permissionCode})`,
    key: n.id,
    children: n.children?.length ? toTree(n.children) : undefined,
  }))
}

export default function RolesPage() {
  const [items, setItems] = useState<RoleItem[]>([])
  const [tree, setTree] = useState<PermissionNode[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<RoleItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [permRole, setPermRole] = useState<RoleItem | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [form] = Form.useForm()

  async function load() {
    try {
      setItems(await roleApi.list())
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    }
  }

  useEffect(() => {
    void load()
    permissionApi.tree().then(setTree).catch(() => undefined)
  }, [])

  function openCreate() {
    setEditingRole(null)
    form.resetFields()
    form.setFieldsValue({ enabled: true })
    setModalOpen(true)
  }

  function openEdit(row: RoleItem) {
    setEditingRole(row)
    form.setFieldsValue({
      roleName: row.roleName,
      roleCode: row.roleCode,
      description: row.description ?? '',
      enabled: (row.status ?? 1) === 1,
    })
    setModalOpen(true)
  }

  async function handleDelete(row: RoleItem) {
    try {
      await roleApi.remove(row.id)
      message.success('角色已删除')
      void load()
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '删除失败')
    }
  }

  const editingBuiltin = Boolean(
    editingRole && BUILTIN_ROLE_CODES.has(editingRole.roleCode),
  )

  return (
    <div className="kh-page">
      <Button type="primary" style={{ marginBottom: 16 }} onClick={openCreate}>
        新建角色
      </Button>
      <Table
        rowKey="id"
        dataSource={items}
        columns={[
          {
            title: '角色名称',
            dataIndex: 'roleName',
            render: (name: string, row: RoleItem) => (
              <Space size={8}>
                <span>{name}</span>
                {BUILTIN_ROLE_CODES.has(row.roleCode) ? (
                  <Tag color="geekblue">系统预置</Tag>
                ) : null}
              </Space>
            ),
          },
          { title: '角色编码', dataIndex: 'roleCode' },
          {
            title: '说明',
            dataIndex: 'description',
            render: (v?: string | null) => v || '-',
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
            render: (_: unknown, row: RoleItem) => {
              const builtin = BUILTIN_ROLE_CODES.has(row.roleCode)
              return (
                <Space size={12}>
                  <a onClick={() => openEdit(row)}>编辑</a>
                  <a
                    onClick={async () => {
                      setPermRole(row)
                      try {
                        const res = await roleApi.permissions(row.id)
                        setChecked(res.permissionIds)
                      } catch (error) {
                        message.error(
                          error instanceof ApiError
                            ? error.message
                            : '读取权限失败',
                        )
                      }
                    }}
                  >
                    分配权限
                  </a>
                  {builtin ? (
                    <Tooltip title="系统预置角色不允许删除">
                      <span style={{ color: '#bfbfbf', cursor: 'not-allowed' }}>
                        删除
                      </span>
                    </Tooltip>
                  ) : (
                    <Popconfirm
                      title={`确定删除角色「${row.roleName}」？`}
                      description="已被用户绑定的角色需先解除绑定后才可删除。"
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

      {/* 新建 / 编辑角色弹窗 */}
      <Modal
        title={editingRole ? `编辑角色 - ${editingRole.roleName}` : '新建角色'}
        open={modalOpen}
        confirmLoading={saving}
        onCancel={() => {
          setModalOpen(false)
          setEditingRole(null)
        }}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            roleName: string
            roleCode: string
            description?: string
            enabled?: boolean
          }) => {
            setSaving(true)
            try {
              if (editingRole) {
                await roleApi.update(editingRole.id, {
                  roleName: values.roleName.trim(),
                  description: values.description?.trim() ?? '',
                  status: values.enabled ? 1 : 0,
                })
                message.success('角色已更新')
              } else {
                await roleApi.create({
                  roleName: values.roleName.trim(),
                  roleCode: values.roleCode.trim(),
                  description: values.description?.trim() || undefined,
                })
                message.success('角色已创建')
              }
              setModalOpen(false)
              setEditingRole(null)
              form.resetFields()
              void load()
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
            name="roleName"
            label="角色名称"
            rules={[{ required: true, message: '请输入角色名称' }]}
          >
            <Input placeholder="如 编辑员" maxLength={50} />
          </Form.Item>
          <Form.Item
            name="roleCode"
            label="角色编码"
            rules={[{ required: true, message: '请输入角色编码' }]}
            extra={editingRole ? '角色编码为鉴权标识，创建后不可修改' : undefined}
          >
            <Input
              placeholder="如 ROLE_EDITOR"
              maxLength={50}
              disabled={Boolean(editingRole)}
            />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input placeholder="角色职能描述" maxLength={200} />
          </Form.Item>
          {editingRole ? (
            <Form.Item
              name="enabled"
              label="状态"
              valuePropName="checked"
              extra={
                editingBuiltin
                  ? '系统预置角色不允许禁用'
                  : '禁用后该角色将不参与权限判定'
              }
            >
              <Switch
                checkedChildren="启用"
                unCheckedChildren="禁用"
                disabled={editingBuiltin}
              />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      {/* 分配权限弹窗 */}
      <Modal
        title={`分配权限 - ${permRole?.roleName}`}
        open={Boolean(permRole)}
        onCancel={() => setPermRole(null)}
        onOk={async () => {
          if (!permRole) return
          try {
            await roleApi.assignPermissions(permRole.id, checked)
            message.success('角色权限已更新')
            setPermRole(null)
          } catch (error) {
            message.error(
              error instanceof ApiError ? error.message : '更新权限失败',
            )
          }
        }}
      >
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <Tree
            checkable
            treeData={toTree(tree)}
            checkedKeys={checked}
            onCheck={(keys) => {
              const ids = Array.isArray(keys) ? keys : keys.checked
              setChecked(ids.map(String))
            }}
          />
        </div>
      </Modal>
    </div>
  )
}
