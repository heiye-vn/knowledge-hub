import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Space, Table, message } from 'antd'
import { teamApi } from '../../api'
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
  const [open, setOpen] = useState(false)
  const [membersFor, setMembersFor] = useState<TeamItem | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [memberIds, setMemberIds] = useState('')
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

  useEffect(() => {
    void load(1)
  }, [])

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
        <Button type="primary" onClick={() => setOpen(true)}>
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
          { title: '编码', dataIndex: 'teamCode' },
          { title: '说明', dataIndex: 'description' },
          { title: '成员数', dataIndex: 'memberCount' },
          {
            title: '操作',
            render: (_: unknown, row: TeamItem) => (
              <a
                onClick={async () => {
                  setMembersFor(row)
                  try {
                    setMembers((await teamApi.members(row.id)) as MemberRow[])
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
            ),
          },
        ]}
      />

      {/* 新建团队弹窗 */}
      <Modal
        title="新建团队"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            teamName: string
            teamCode?: string
            description?: string
          }) => {
            try {
              await teamApi.create(values)
              message.success('团队已创建')
              setOpen(false)
              form.resetFields()
              void load(1)
            } catch (error) {
              message.error(
                error instanceof ApiError ? error.message : '创建失败',
              )
            }
          }}
        >
          <Form.Item
            name="teamName"
            label="团队名称"
            rules={[{ required: true, message: '请输入团队名称' }]}
          >
            <Input placeholder="如 研发团队" />
          </Form.Item>
          <Form.Item name="teamCode" label="编码">
            <Input placeholder="如 R_AND_D" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input placeholder="团队职责描述" />
          </Form.Item>
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
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input
            placeholder="输入用户 ID（多个用英文逗号分隔）"
            value={memberIds}
            onChange={(e) => setMemberIds(e.target.value)}
          />
          <Button
            type="primary"
            onClick={async () => {
              if (!membersFor) return
              const ids = memberIds
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
              if (!ids.length) return
              try {
                await teamApi.addMembers(membersFor.id, ids)
                message.success('已添加成员')
                setMemberIds('')
                setMembers(
                  (await teamApi.members(membersFor.id)) as MemberRow[],
                )
                void load()
              } catch (error) {
                message.error(
                  error instanceof ApiError ? error.message : '添加成员失败',
                )
              }
            }}
          >
            添加成员
          </Button>
        </Space.Compact>
        <Table
          rowKey="userId"
          size="small"
          dataSource={members}
          pagination={false}
          columns={[
            { title: '用户 ID', dataIndex: 'userId' },
            { title: '用户名', dataIndex: 'username' },
            { title: '姓名', dataIndex: 'realName' },
            {
              title: '操作',
              render: (_: unknown, m: MemberRow) => (
                <a
                  style={{ color: '#ff4d4f' }}
                  onClick={async () => {
                    if (!membersFor) return
                    try {
                      await teamApi.removeMembers(membersFor.id, [m.userId])
                      message.success('已移除成员')
                      setMembers(
                        (await teamApi.members(membersFor.id)) as MemberRow[],
                      )
                      void load()
                    } catch (error) {
                      message.error(
                        error instanceof ApiError
                          ? error.message
                          : '移除失败',
                      )
                    }
                  }}
                >
                  移除
                </a>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}
