import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  AuditOutlined,
  CommentOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  LikeOutlined,
  MessageOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Button, Card, Col, Row, Space, Spin, Tag, Typography, message } from 'antd'
import { userApi } from '../api'
import { ApiError } from '../api/client'
import { useAuth } from '../auth'
import type { UserStats } from '../types'
import { can, displayName, isAdmin, isReviewer } from '../utils'

const { Title, Paragraph, Text } = Typography

export default function DashboardPage() {
  const user = useAuth()
  const navigate = useNavigate()
  const [stats, setStats] = useState<UserStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    userApi
      .stats()
      .then(setStats)
      .catch((error) => {
        message.error(error instanceof ApiError ? error.message : '获取统计数据失败')
      })
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="kh-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px' }}>
      {/* 顶部欢迎卡片 */}
      <Card
        style={{
          marginBottom: 20,
          background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
          color: '#ffffff',
          borderRadius: 8,
          boxShadow: '0 4px 12px rgba(22, 119, 255, 0.15)',
        }}
        bordered={false}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Avatar
              size={64}
              icon={<UserOutlined />}
              src={user?.avatar || undefined}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.25)',
                border: '2px solid rgba(255, 255, 255, 0.6)',
              }}
            />
            <div>
              <div style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', marginBottom: 4 }}>
                你好，{displayName(user)}！
              </div>
              <div style={{ color: 'rgba(255, 255, 255, 0.85)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>账号：{user?.username}</span>
                <span>•</span>
                <span>
                  角色：
                  {user?.roles.map((r) => (
                    <Tag
                      key={r}
                      style={{
                        background: 'rgba(255, 255, 255, 0.2)',
                        color: '#ffffff',
                        border: 'none',
                        marginRight: 4,
                      }}
                    >
                      {r}
                    </Tag>
                  ))}
                </span>
              </div>
            </div>
          </div>
          <Button
            ghost
            onClick={() => navigate('/profile')}
            style={{ borderColor: 'rgba(255, 255, 255, 0.6)', color: '#ffffff' }}
          >
            个人中心
          </Button>
        </div>
      </Card>

      {/* 核心数据指标看板 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ borderRadius: 8, textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            {loading ? (
              <Spin size="small" />
            ) : (
              <div>
                <div style={{ color: '#1677ff', fontSize: 24, marginBottom: 8 }}>
                  <FileTextOutlined />
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1f1f1f' }}>
                  {stats?.documentCount ?? 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>创建文档总数</Text>
              </div>
            )}
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ borderRadius: 8, textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            {loading ? (
              <Spin size="small" />
            ) : (
              <div>
                <div style={{ color: '#52c41a', fontSize: 24, marginBottom: 8 }}>
                  <EyeOutlined />
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1f1f1f' }}>
                  {stats?.viewCount ?? 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>累计浏览次数</Text>
              </div>
            )}
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ borderRadius: 8, textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            {loading ? (
              <Spin size="small" />
            ) : (
              <div>
                <div style={{ color: '#fa8c16', fontSize: 24, marginBottom: 8 }}>
                  <LikeOutlined />
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1f1f1f' }}>
                  {stats?.likeCount ?? 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>获得点赞总数</Text>
              </div>
            )}
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ borderRadius: 8, textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            {loading ? (
              <Spin size="small" />
            ) : (
              <div>
                <div style={{ color: '#722ed1', fontSize: 24, marginBottom: 8 }}>
                  <CommentOutlined />
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1f1f1f' }}>
                  {stats?.commentCount ?? 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>互动评论总数</Text>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* 业务功能快捷入口 */}
      <Title level={5} style={{ marginBottom: 16 }}>
        快捷功能工作台
      </Title>
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {can(user, 'document:create') ? (
          <Col xs={24} sm={12} md={8}>
            <Card
              hoverable
              style={{ borderRadius: 8, height: '100%' }}
              onClick={() => navigate('/documents/new')}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ fontSize: 24, color: '#1677ff' }}>
                  <FileAddOutlined />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>新建与上传文档</div>
                  <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                    支持 Markdown 手动创建及各类文档文件自动解析入库
                  </Paragraph>
                </div>
                <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
              </div>
            </Card>
          </Col>
        ) : null}

        {can(user, 'document:list') ? (
          <Col xs={24} sm={12} md={8}>
            <Card
              hoverable
              style={{ borderRadius: 8, height: '100%' }}
              onClick={() => navigate('/documents')}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ fontSize: 24, color: '#52c41a' }}>
                  <FileTextOutlined />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>文档管理中心</div>
                  <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                    浏览、检索、编辑已创建文档，管理草稿与发布状态
                  </Paragraph>
                </div>
                <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
              </div>
            </Card>
          </Col>
        ) : null}

        {can(user, 'search') ? (
          <>
            <Col xs={24} sm={12} md={8}>
              <Card
                hoverable
                style={{ borderRadius: 8, height: '100%' }}
                onClick={() => navigate('/search')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 24, color: '#fa8c16' }}>
                    <SearchOutlined />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>全文高亮检索</div>
                    <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                      基于 Elasticsearch 的毫秒级全文精确检索与关键字高亮
                    </Paragraph>
                  </div>
                  <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Card
                hoverable
                style={{ borderRadius: 8, height: '100%' }}
                onClick={() => navigate('/chat')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 24, color: '#13c2c2' }}>
                    <MessageOutlined />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>AI 智能问答</div>
                    <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                      基于 RAG 知识库检索增强生成，提供精准解答与引用溯源
                    </Paragraph>
                  </div>
                  <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Card
                hoverable
                style={{ borderRadius: 8, height: '100%' }}
                onClick={() => navigate('/graph')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 24, color: '#722ed1' }}>
                    <ApartmentOutlined />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>知识图谱全景</div>
                    <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                      力导向多维实体关联拓扑、热门概念与知识网络全景漫游
                    </Paragraph>
                  </div>
                  <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
                </div>
              </Card>
            </Col>
          </>
        ) : null}

        {isReviewer(user) ? (
          <Col xs={24} sm={12} md={8}>
            <Card
              hoverable
              style={{ borderRadius: 8, height: '100%' }}
              onClick={() => navigate('/admin/reviews')}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ fontSize: 24, color: '#eb2f96' }}>
                  <AuditOutlined />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>审核工作台</div>
                  <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                    处理待审核文档发布申请，支持审批通过与驳回反馈
                  </Paragraph>
                </div>
                <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
              </div>
            </Card>
          </Col>
        ) : null}

        {isAdmin(user) || can(user, 'system:user') ? (
          <Col xs={24} sm={12} md={8}>
            <Card
              hoverable
              style={{ borderRadius: 8, height: '100%' }}
              onClick={() => navigate('/admin/users')}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ fontSize: 24, color: '#fa541c' }}>
                  <SettingOutlined />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>系统与权限管理</div>
                  <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                    配置企业用户账号、细粒度 RBAC 角色权限与部门团队结构
                  </Paragraph>
                </div>
                <ArrowRightOutlined style={{ color: '#bfbfbf' }} />
              </div>
            </Card>
          </Col>
        ) : null}
      </Row>

      {/* RBAC 权限明细卡片 */}
      <Card title="当前账号授权信息" bordered={false} style={{ borderRadius: 8 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ marginRight: 8 }}>生效角色：</Text>
            {user?.roles.map((r) => (
              <Tag color="blue" key={r}>
                {r}
              </Tag>
            ))}
          </div>
          <div>
            <Text type="secondary" style={{ marginRight: 8 }}>已获权限码：</Text>
            <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {user?.permissions.map((p) => (
                <Tag color="geekblue" key={p}>
                  {p}
                </Tag>
              ))}
            </div>
          </div>
        </Space>
      </Card>
    </div>
  )
}
