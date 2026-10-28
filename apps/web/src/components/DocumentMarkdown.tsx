import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import { AuthenticatedImage } from "./AuthenticatedImage";
import "katex/dist/katex.min.css";

const mathClasses: [string, ...string[]] = [
  "className",
  "language-math",
  "math-inline",
  "math-display",
];
const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), mathClasses],
    span: [...(defaultSchema.attributes?.span ?? []), mathClasses],
    div: [...(defaultSchema.attributes?.div ?? []), mathClasses],
    td: [...(defaultSchema.attributes?.td ?? []), "colSpan", "rowSpan"],
    th: [...(defaultSchema.attributes?.th ?? []), "colSpan", "rowSpan"],
  },
};

export const safeMarkdownPlugins: Pick<
  Options,
  "remarkPlugins" | "rehypePlugins"
> = {
  remarkPlugins: [remarkGfm, remarkMath],
  // Sanitize user HTML first; only trusted KaTeX output may introduce styles/MathML.
  rehypePlugins: [
    rehypeRaw,
    [rehypeSanitize, sanitizeSchema],
    [
      rehypeKatex,
      {
        trust: false,
        strict: "ignore",
        throwOnError: false,
        maxExpand: 1000,
        maxSize: 20,
      },
    ],
  ],
};

export const safeMarkdownComponents: Components = {
  img: ({ src, alt, title }) => (
    <AuthenticatedImage src={src} alt={alt} title={title} />
  ),
  table: ({ children }) => (
    <div
      className="kh-markdown-table"
      role="region"
      aria-label="表格（可横向滚动）"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function DocumentMarkdown({ content }: { content: string }) {
  return (
    <div className="kh-doc-body kh-safe-markdown">
      <Markdown {...safeMarkdownPlugins} components={safeMarkdownComponents}>
        {content}
      </Markdown>
    </div>
  );
}
