import mammoth from 'mammoth';
import TurndownService from 'turndown';
import turndownPluginGfm, { gfm as namedGfm } from 'turndown-plugin-gfm';
import { cleanMarkdown } from '../utils/markdown.util.js';

// 兼容 ESM 与 CJS 的导出结构差异
const gfm =
  namedGfm ??
  (turndownPluginGfm as unknown as { gfm?: (service: TurndownService) => void })
    ?.gfm ??
  (turndownPluginGfm as unknown as (service: TurndownService) => void);


/**
 * 将 DOCX 解析为 Markdown。
 *
 * 整体流程：
 * 1. mammoth 把 DOCX 转为 HTML（保留标题 / 列表 / 表格等结构）；
 * 2. turndown(+GFM) 把 HTML 转为 Markdown；
 * 3. cleanMarkdown 做换行与空白规范化。
 *
 * styleMap 同时覆盖英文与中文 Word 内置样式名，避免中文版 Word 标题丢失层级。
 */
export async function parseDocx(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [
        // 英文样式
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        // 中文 Word 内置「标题 N」
        "p[style-name='标题 1'] => h1:fresh",
        "p[style-name='标题 2'] => h2:fresh",
        "p[style-name='标题 3'] => h3:fresh",
        "p[style-name='标题 4'] => h4:fresh",
      ],
    },
  );

  const turndown = new TurndownService({
    headingStyle: 'atx', // # 标题
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // GFM：表格、删除线、任务列表等扩展语法
  turndown.use(gfm);

  return cleanMarkdown(turndown.turndown(html));
}
