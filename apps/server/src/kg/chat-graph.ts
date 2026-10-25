import type { GraphChatHit } from './types/kg.types.js';

const KEYWORD_SEPARATOR = /[\s/／、，,；;]+/;

/**
 * 模型常把「发票 报销」写成一项，图匹配要拆成短名，否则对不上节点。
 * 除空白和斜杠外，也接受中文顿号/逗号/分号；大小写不敏感去重。
 */
export function splitGraphKeywords(keyword: string | string[]): string[] {
  const parts = Array.isArray(keyword) ? keyword : [keyword];
  const seen = new Set<string>();
  const kws: string[] = [];
  for (const part of parts) {
    for (const raw of String(part).split(KEYWORD_SEPARATOR)) {
      const kw = raw.trim();
      if (!kw) continue;
      const key = kw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kws.push(kw);
    }
  }
  return kws;
}

/** 给模型看的图谱上下文：只写关系与来源，不返回 chunk 正文。 */
export function formatGraphContext(hit: GraphChatHit): string {
  if (!hit.entities.length && !hit.relations.length) return '';
  const lines: string[] = [];
  if (hit.relations.length) {
    lines.push('关系：');
    for (const rel of hit.relations) {
      lines.push(`- ${rel.source} → ${rel.target}（${rel.relation}）`);
    }
  } else {
    lines.push(`实体：${hit.entities.map((entity) => entity.name).join('、')}`);
  }
  const titles = hit.documents
    .map((doc) => doc.title)
    .filter(Boolean);
  if (titles.length) {
    lines.push(`来源文档：${titles.join('；')}`);
  }
  return lines.join('\n');
}

/** 非流式问答用的图谱 system 文本：明确图谱不是制度原文。 */
export function formatGraphSystemText(hit: GraphChatHit): string {
  const body = formatGraphContext(hit);
  if (!body) return '';
  return (
    `【本轮知识图谱】\n${body}\n\n` +
    '以上只说明实体之间的关系，不能当制度原文；制度/流程以知识库检索资料为准。'
  );
}
