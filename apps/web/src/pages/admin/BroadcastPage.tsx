import { useEffect, useState } from 'react'
import { Button, Form, Input, Select, message } from 'antd'
import { notificationApi, userApi } from '../../api'
import { ApiError } from '../../api/client'
import type { UserVO } from '../../types'

/** 系统管理 → 发送通知：管理员广播站内通知 */
export default function BroadcastPage() {
  const [users, setUsers] = useState<UserVO[]>([])
  const [sending, setSending] = useState(false)
  const [form] = Form.useForm()

  async function searchUsers(keyword?: string) {
    try {
      const res = await userApi.page({
        page: 1,
        pageSize: 20,
        status: 1,
        keyword: keyword?.trim() || undefined,
      })
      setUsers((prev) => {
        const merged = new Map(prev.map((user) => [user.id, user]))
        for (const user of res.items) merged.set(user.id, user)
        return [...merged.values()]
      })
    } catch {
      // 搜索失败不阻断发送
    }
  }

  useEffect(() => {
    void searchUsers()
  }, [])

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>发送站内通知</h2>
      <p className="kh-access-hint">
        不选接收人时发给所有启用中的用户；接收人支持按用户名 / 姓名 / 邮箱搜索。
      </p>
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 640 }}
        onFinish={async (values: {
          title: string
          content: string
          userIds?: string[]
        }) => {
          setSending(true)
          try {
            const res = await notificationApi.broadcast({
              title: values.title.trim(),
              content: values.content.trim(),
              userIds: values.userIds?.length ? values.userIds : undefined,
            })
            message.success(`已发送给 ${res.count} 人`)
            form.resetFields()
          } catch (error) {
            message.error(error instanceof ApiError ? error.message : '发送失败')
          } finally {
            setSending(false)
          }
        }}
      >
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, message: '请填写标题' }]}
        >
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item
          name="content"
          label="内容"
          rules={[{ required: true, message: '请填写内容' }]}
        >
          <Input.TextArea rows={5} maxLength={2000} />
        </Form.Item>
        <Form.Item name="userIds" label="接收人">
          <Select
            mode="multiple"
            allowClear
            placeholder="不选则发给所有人"
            filterOption={false}
            onSearch={(keyword) => void searchUsers(keyword)}
            options={users.map((user) => ({
              value: user.id,
              label: user.realName
                ? `${user.realName}（${user.username}）`
                : user.username,
            }))}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={sending}>
          发送
        </Button>
      </Form>
    </div>
  )
}
