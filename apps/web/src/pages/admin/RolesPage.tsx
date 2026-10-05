import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Table, Tree, message } from 'antd'
import type { TreeDataNode } from 'antd'
import { permissionApi, roleApi } from '../../api'
import { ApiError } from '../../api/client'
import type { PermissionNode, RoleItem } from '../../types'

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
  const [createOpen, setCreateOpen] = useState(false)
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

  return (
    <div className="kh-page">
      <Button
        type="primary"
        style={{ marginBottom: 16 }}
        onClick={() => setCreateOpen(true)}
      >
        新建角色
      </Button>
      <Table
        rowKey="id"
        dataSource={items}
        columns={[
          { title: '角色名称', dataIndex: 'roleName' },
          { title: '角色编码', dataIndex: 'roleCode' },
          { title: '说明', dataIndex: 'description' },
          {
            title: '操作',
            render: (_: unknown, row: RoleItem) => (
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
            ),
          },
        ]}
      />

      {/* 新建角色弹窗 */}
      <Modal
        title="新建角色"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            roleName: string
            roleCode: string
            description?: string
          }) => {
            try {
              await roleApi.create(values)
              message.success('角色已创建')
              setCreateOpen(false)
              form.resetFields()
              void load()
            } catch (error) {
              message.error(
                error instanceof ApiError ? error.message : '创建失败',
              )
            }
          }}
        >
          <Form.Item
            name="roleName"
            label="角色名称"
            rules={[{ required: true, message: '请输入角色名称' }]}
          >
            <Input placeholder="如 编辑员" />
          </Form.Item>
          <Form.Item
            name="roleCode"
            label="角色编码"
            rules={[{ required: true, message: '请输入角色编码' }]}
          >
            <Input placeholder="如 ROLE_EDITOR" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input placeholder="角色职能描述" />
          </Form.Item>
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
