import type { GoldenItem } from './eval.types.js';

/**
 * 与业务路由、知识库、改写、拒答、图谱、联网对应的固定评测集。
 *
 * 标题只存子串而不存 documentId：环境重建后 ID 会变。
 * relevantDocTitles: [] 表示库里不应有对应制度，不得省略，否则 false_hit 会跳过。
 * 金标与 keyPoints 必须来自当前知识库的真实条款：换语料后按空召回与误命中重新校准，
 * 不能沿用臆断的制度名（2026-10-27 首次基线时曾因金标超出语料，检索类指标全为 0）。
 */
export const GOLDEN_DATASET: GoldenItem[] = [
  {
    input: { question: '你好' },
    expectedOutput: {
      intent: 'chitchat',
      forbidRetrieve: true,
      forbidGraph: true,
      forbidWeb: true,
      judgeGroundedness: false,
    },
    metadata: { id: 'chitchat-hello', suite: 'routing', access: 'admin' },
  },
  {
    // 2026-10-27 按真实语料校准：库内差旅文档标题为 01-travel-expense-policy，
    // 且不含「预估超五千加签」条款；改为断言真实存在的餐饮补贴规则。
    input: { question: '出差期间餐饮补贴按什么标准？需要发票吗？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      requireGraph: true,
      forbidWeb: true,
      relevantDocTitles: ['travel-expense'],
      keyPoints: ['100 元/天'],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-travel-meal', suite: 'kb-hit', access: 'admin' },
  },
  {
    input: { question: '加班餐补怎么报、标准是多少？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRewrite: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-overtime-meal', suite: 'rewrite', access: 'admin' },
  },
  {
    input: { question: '公司年会抽奖规则是什么？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRefusal: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-annual-party', suite: 'kb-empty', access: 'admin' },
  },
  {
    input: { question: '今天人民币兑美元汇率' },
    expectedOutput: {
      intent: 'web',
      requireWeb: true,
      forbidRetrieve: true,
      forbidGraph: true,
      judgeGroundedness: false,
    },
    metadata: { id: 'web-fx', suite: 'web', access: 'admin' },
  },
  {
    // 2026-10-27 校准：VPN 排查与账号对接写在「新员工入职指南（研发中心）」
    // 的账号权限与常见问题两节；对接人是 Buddy，不存在「信息安全」文档。
    input: { question: 'VPN 连不上先查什么，账号开通找谁？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      relevantDocTitles: ['新员工入职指南'],
      keyPoints: ['Buddy', 'hosts'],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-vpn-account', suite: 'kb-hit', access: 'admin' },
  },
  {
    // 2026-10-27 校准：库内没有灰度发布/生产变更制度，原 kb-hit 期望改为拒答。
    input: { question: '知识库上线怎么做灰度？谁负责窗口？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRefusal: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-release-window', suite: 'kb-empty', access: 'admin' },
  },
  {
    input: { question: '实习生转正答辩要交哪些材料？' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      expectRefusal: true,
      relevantDocTitles: [],
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-intern-defense', suite: 'kb-empty', access: 'admin' },
  },
  {
    input: { question: '预算审核员属于哪个部门' },
    expectedOutput: {
      intent: 'kb',
      requireRetrieve: true,
      forbidWeb: true,
      judgeGroundedness: true,
    },
    metadata: { id: 'kb-budget-role', suite: 'routing', access: 'admin' },
  },
];

/**
 * 受限用户用例依赖环境里的真实账号与问题，避免把内部文档名硬编码进仓库。
 * 两者缺一即跳过，不会用管理员身份伪造权限结论。
 */
export function withAclCase(
  items: GoldenItem[],
  env: NodeJS.ProcessEnv = process.env,
): GoldenItem[] {
  const userId = env.EVAL_ACL_USER_ID?.trim();
  const question = env.EVAL_ACL_QUESTION?.trim();
  if (!userId || !question) return [...items];

  return [
    ...items,
    {
      input: { question },
      expectedOutput: {
        intent: 'kb',
        relevantDocTitles: [],
        expectRefusal: true,
        judgeGroundedness: true,
      },
      metadata: {
        id: 'acl-restricted-document',
        suite: 'acl',
        access: 'restricted',
      },
    },
  ];
}

export function buildGoldenDataset(
  env: NodeJS.ProcessEnv = process.env,
): GoldenItem[] {
  return withAclCase(GOLDEN_DATASET, env);
}
