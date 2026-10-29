import { describe, expect, it } from 'vitest';
import { cleanMarkdown, stripNullBytes } from './markdown.util.js';

describe('stripNullBytes', () => {
  it('去掉 NUL 字节（解析产物列表符会变成 0x00，PG UTF-8 文本拒收）', () => {
    expect(stripNullBytes('第一章\u0000总则')).toBe('第一章总则');
    expect(stripNullBytes('\u0000\u0000')).toBe('');
    expect(stripNullBytes('a\u0000b\u0000c')).toBe('abc');
  });

  it('无 NUL 时原样返回；空串与空内容不抛错', () => {
    expect(stripNullBytes('正常正文')).toBe('正常正文');
    expect(stripNullBytes('')).toBe('');
  });
});

describe('cleanMarkdown', () => {
  it('统一换行、压缩空行、去首尾空白', () => {
    expect(cleanMarkdown('  a\r\n\r\n\r\n\r\n\r\nb  ')).toBe('a\n\n\nb');
  });

  it('解析链路入口同步过滤 NUL', () => {
    expect(cleanMarkdown('\u0000## 标题\n\n- 项目一')).toBe('## 标题\n\n- 项目一');
  });
});
