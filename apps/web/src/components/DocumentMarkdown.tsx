import { useEffect, useMemo, useRef } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import { AuthenticatedImage } from "./AuthenticatedImage";
import { ShareImage } from "./ShareImage";
import {
  locateAndHighlightInMarkdown,
  type LocateTarget,
} from "./markdown-locate";
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
    th: [
      ...(defaultSchema.attributes?.th ?? []),
      "colSpan",
      "rowSpan",
      "scope",
    ],
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

export function DocumentMarkdown({
  content,
  assetMode = "private",
  locateTarget = null,
  onLocateResult,
}: {
  content: string;
  /** private：登录态 + 文档 ACL；share：公开分享页的签名直链 */
  assetMode?: "private" | "share";
  locateTarget?: LocateTarget | null;
  onLocateResult?: (matched: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onLocateResultRef = useRef(onLocateResult);
  onLocateResultRef.current = onLocateResult;

  const components = useMemo<Components>(
    () =>
      assetMode === "share"
        ? {
            ...safeMarkdownComponents,
            img: ({ src, alt, title }) => (
              <ShareImage src={src} alt={alt} title={title} />
            ),
          }
        : safeMarkdownComponents,
    [assetMode],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!locateTarget) {
      for (const prev of Array.from(
        container.querySelectorAll(".kh-locate-highlight"),
      )) {
        prev.classList.remove("kh-locate-highlight");
      }
      return;
    }

    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled || !containerRef.current) return;
      const res = locateAndHighlightInMarkdown(
        containerRef.current,
        locateTarget,
      );
      onLocateResultRef.current?.(res.matched);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [
    content,
    locateTarget?.heading,
    locateTarget?.excerpt,
    locateTarget?.chunkContent,
    locateTarget?.chunkIndex,
    locateTarget?.nonce,
  ]);

  return (
    <div ref={containerRef} className="kh-doc-body kh-safe-markdown">
      <Markdown {...safeMarkdownPlugins} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
