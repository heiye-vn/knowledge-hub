import { describe, expect, it } from 'vitest'
import {
  citedSources,
  historyToUIMessages,
  sourcesFromParts,
  textFromParts,
  type KhUIMessage,
} from './chat-message-utils'
import type { ChatSource } from './types'

function source(index: number): ChatSource {
  return {
    index,
    documentId: `doc-${index}`,
    documentTitle: `文档 ${index}`,
    heading: null,
    excerpt: `摘录 ${index}`,
    score: 1,
  }
}

function parts(
  input: Array<Record<string, unknown>>,
): KhUIMessage['parts'] {
  return input as KhUIMessage['parts']
}

describe('聊天消息转换', () => {
  it('从 data-sources part 提取引用资料', () => {
    const sources = [source(1), source(2)]
    expect(
      sourcesFromParts(parts([{ type: 'text', text: '答案' }, { type: 'data-sources', data: sources }])),
    ).toEqual(sources)
  })

  it('多次检索时取最后一个非空 data-sources', () => {
    const first = [source(1)]
    const all = [source(1), source(2)]
    expect(
      sourcesFromParts(
        parts([
          { type: 'data-sources', data: [] },
          { type: 'data-sources', data: first },
          { type: 'data-sources', data: all },
        ]),
      ),
    ).toEqual(all)
  })

  it('最后一段为空时仍回退到最近的非空 sources', () => {
    const sources = [source(1), source(2)]
    expect(
      sourcesFromParts(
        parts([
          { type: 'data-sources', data: sources },
          { type: 'data-sources', data: [] },
        ]),
      ),
    ).toEqual(sources)
  })

  it('没有 data-sources 时返回空数组', () => {
    expect(sourcesFromParts(parts([{ type: 'text', text: '答案' }]))).toEqual(
      [],
    )
  })

  it('只保留回答中实际引用的资料', () => {
    const sources = [source(1), source(2), source(3)]
    expect(citedSources(sources, '结论见 [1]，补充见 [3] 与 [9]')).toEqual([
      source(1),
      source(3),
    ])
    expect(citedSources(sources, '没有引用')).toEqual([])
  })

  it('拼接所有 text part，忽略过程事件', () => {
    expect(
      textFromParts(
        parts([
          { type: 'text', text: '第一段' },
          { type: 'data-status', data: { stage: 'retrieve', text: '检索中' } },
          { type: 'text', text: '第二段' },
        ]),
      ),
    ).toBe('第一段第二段')
  })

  it('剔除评估/改写/路由结构化 JSON，不进入回答正文', () => {
    const text = [
      '{"relevant":false,"reason":"只是词沾边"}',
      '{"query":"差旅 报销 餐补"}',
      '{"intent":"kb","standalone_query":"报销流程"}',
      '这是正式回答。',
    ].join('\n')

    expect(textFromParts(parts([{ type: 'text', text }]))).toBe('这是正式回答。')
  })

  it('只包含内部 JSON 的 text part 不产生正文', () => {
    expect(
      textFromParts(
        parts([
          { type: 'text', text: '{"query":"改写词"}' },
          { type: 'text', text: '回答' },
        ]),
      ),
    ).toBe('回答')
  })

  it('形似 JSON 但非内部结构的内容保留', () => {
    const text = '{"foo":"bar"}\n正常内容'
    expect(textFromParts(parts([{ type: 'text', text }]))).toBe(text)
  })

  it('历史用户消息还原为单个 text part', () => {
    const [message] = historyToUIMessages([
      { id: 'm1', role: 'user', content: '你好' },
    ])
    expect(message).toMatchObject({
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: '你好' }],
    })
  })

  it('历史助手消息保留引用资料并置于正文之前', () => {
    const sources = [source(1)]
    const [withSources, withoutSources] = historyToUIMessages([
      { id: 'm2', role: 'assistant', content: '回答', sources },
      { id: 'm3', role: 'assistant', content: '无引用回答', sources: null },
    ])

    expect(withSources.parts).toEqual([
      { type: 'data-sources', data: sources },
      { type: 'text', text: '回答' },
    ])
    expect(withoutSources.parts).toEqual([{ type: 'text', text: '无引用回答' }])
  })
})
