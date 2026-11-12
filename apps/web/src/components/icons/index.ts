/* 由 design/kh-icons/build.mjs 自动生成，请勿手改。 */

export { KhIcon, type KhIconName, type KhIconProps } from './KhIcon'
export { default } from './KhIcon'

export const KH_ICON_META = [
  { name: 'home', zh: '首页大盘', group: 'nav', use: '顶栏「首页大盘」、侧栏「工作概览」' },
  { name: 'documents', zh: '文档管理', group: 'nav', use: '顶栏「文档管理」、侧栏「全部文档」' },
  { name: 'search', zh: '全文检索', group: 'nav', use: '顶栏「文档搜索」、搜索框前缀' },
  { name: 'chat', zh: 'AI 智能问答', group: 'nav', use: '顶栏「AI智能问答」、侧栏「知识问答」、对话空状态' },
  { name: 'graph', zh: '知识图谱', group: 'nav', use: '顶栏「知识图谱」、侧栏「全景图谱」' },
  { name: 'memory', zh: '长期记忆', group: 'nav', use: '侧栏「我的记忆」、记忆层级标签' },
  { name: 'admin', zh: '系统管理', group: 'nav', use: '顶栏「系统管理」、权限相关标题' },
  { name: 'intent', zh: '意图识别', group: 'agent', use: '过程条「意图识别」节点' },
  { name: 'retrieve', zh: '知识库检索', group: 'agent', use: '过程条「知识库」节点、「已检索可见文档」' },
  { name: 'evaluate', zh: '检索评估', group: 'agent', use: '过程条「检索评估」节点、切题/不足徽标' },
  { name: 'rewrite', zh: '查询改写', group: 'agent', use: '过程条「改写」节点、「已改写检索词」' },
  { name: 'web', zh: '联网搜索', group: 'agent', use: '过程条「联网」节点、公开信息搜索卡' },
  { name: 'think', zh: '思考过程', group: 'agent', use: '过程条「思考过程」折叠块' },
  { name: 'answer', zh: '生成回答', group: 'agent', use: '过程条「生成」阶段、回答正文标记' },
  { name: 'cite', zh: '引用溯源', group: 'agent', use: '引用卡片标题、「查看原文」前置图标' },
  { name: 'new-doc', zh: '新建文档', group: 'doc', use: '侧栏「新建文档」、工作台新建入口' },
  { name: 'upload', zh: '上传导入', group: 'doc', use: '文档导入区主图标、「上传文件」按钮' },
  { name: 'version', zh: '版本历史', group: 'doc', use: '详情页「版本」按钮、版本列表' },
  { name: 'publish', zh: '发布上线', group: 'doc', use: '「发布」按钮（触发 RAG 索引的唯一入口）' },
  { name: 'archive', zh: '归档', group: 'doc', use: '「归档」按钮、归档态文档筛选' },
  { name: 'favorite', zh: '收藏', group: 'doc', use: '侧栏「我的收藏」、收藏态切换' },
  { name: 'success', zh: '成功 / 通过', group: 'state', use: '审核通过、操作成功、导入完成' },
  { name: 'processing', zh: '处理中', group: 'state', use: '导入任务「处理中」、流式生成中、排队态' },
  { name: 'failed', zh: '失败 / 警告', group: 'state', use: '导入失败、检索失败、表单校验错误' },
  { name: 'empty', zh: '空状态', group: 'state', use: '无结果、无会话、无导入记录的品牌空状态' },
  { name: 'locked', zh: '权限受限', group: 'state', use: '403 无权查看、仅自己可见的私有文档' },
  { name: 'concept', zh: '实体 / 概念', group: 'graph', use: '图谱图例「实体/概念」、热门知识点条目' },
  { name: 'tag', zh: '标签', group: 'graph', use: '图谱图例「标签」、文档标签前置图标' },
  { name: 'share', zh: '分享', group: 'collab', use: '文档分享、分享链接页标题' },
] as const

export const KH_ICON_NAMES = KH_ICON_META.map((i) => i.name)
