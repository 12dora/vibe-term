import { normalizePosixPath } from '@tmex/shared';
import { cn } from '@tmex/ui';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import '../code-viewer/hljs-terminal-theme.css';
import { MermaidBlock } from './mermaid-block';

/** 把归一化后的绝对路径映射为图片 URL；宿主必须注入自有文件端点（含 rootId 等定位信息） */
export type ImgUrlResolver = (absPath: string) => string;

/** 解析图片 src：外链/data 原样；绝对/相对路径经 resolver 转文件 URL（resolver 为 null 时不改写） */
export function resolveImgSrc(
  src: string,
  basePath: string,
  resolver: ImgUrlResolver | null
): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) {
    return src;
  }
  if (!resolver) {
    return src;
  }

  if (src.startsWith('/')) {
    return resolver(normalizePosixPath(src));
  }

  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return resolver(normalizePosixPath(`${base}${src}`));
}

/**
 * highlightAuto 要拿所有语法各跑一遍，代价随体积暴涨（1 MiB 未标语言的块要十秒量级，直接冻住主线程）。
 * 超限的未标语言代码块打上 no-highlight，rehype-highlight 会整块跳过；显式 ```lang 的块不受影响，
 * 走的是快两个数量级的 hljs.highlight。块级阈值与 CodeViewer 的自动识别护栏一致，
 * 文档级阈值挡住「成百上千个小块累加」这种块级阈值看不见的情况。
 */
const AUTO_DETECT_BLOCK_LIMIT = 64 * 1024;
const AUTO_DETECT_DOC_LIMIT = 256 * 1024;

export function skipsAutoDetect(blockLength: number, docLength: number): boolean {
  return blockLength > AUTO_DETECT_BLOCK_LIMIT || docLength > AUTO_DETECT_DOC_LIMIT;
}

interface MdastNode {
  type: string;
  lang?: string | null;
  value?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MdastNode[];
}

/** remark 阶段给超限的未标语言代码块挂上 no-highlight（经 data.hProperties 落到 `<code>` 上）。 */
function guardAutoDetect(docLength: number) {
  return () => (tree: MdastNode) => {
    const walk = (node: MdastNode): void => {
      if (node.type === 'code') {
        if (!node.lang && skipsAutoDetect((node.value ?? '').length, docLength)) {
          node.data = { ...node.data, hProperties: { className: ['no-highlight'] } };
        }
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

function buildComponents(basePath: string, resolver: ImgUrlResolver | null): Components {
  return {
    a: ({ node: _node, ...props }) => (
      <a
        {...props}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 break-all"
      />
    ),
    img: ({ node: _node, src, alt, ...props }) => (
      <img
        {...props}
        src={typeof src === 'string' ? resolveImgSrc(src, basePath, resolver) : src}
        alt={alt ?? ''}
        className="max-w-full rounded"
      />
    ),
    pre: ({ node: _node, ...props }) => (
      <pre
        {...props}
        className="bg-muted my-2 overflow-x-auto rounded-md p-3 font-mono text-[13px] leading-relaxed"
      />
    ),
    code: ({ node: _node, className, children, ...props }) => {
      const lang = /language-([\w-]+)/.exec(className ?? '')?.[1];
      if (lang === 'mermaid') {
        return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
      }
      // fenced 代码块（rehype-highlight 会附加 hljs / language-* class），
      // inline code 没有 language-* 也不会被 hljs 处理；
      // 被护栏打上 no-highlight 的块拿不到 language-*，但它仍然是 fenced 块。
      if (lang || className?.includes('no-highlight')) {
        return (
          <code {...props} className={cn('font-mono text-[13px]', className)}>
            {children}
          </code>
        );
      }
      return (
        <code {...props} className={cn('bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em]')}>
          {children}
        </code>
      );
    },
    h1: ({ node: _node, ...props }) => (
      <h1 {...props} className="mt-4 mb-2 text-xl font-semibold first:mt-0" />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2 {...props} className="border-border mt-4 mb-2 border-b pb-1 text-lg font-semibold" />
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 {...props} className="mt-3 mb-1.5 text-base font-semibold" />
    ),
    h4: ({ node: _node, ...props }) => (
      <h4 {...props} className="mt-3 mb-1.5 text-sm font-semibold" />
    ),
    p: ({ node: _node, ...props }) => <p {...props} className="my-2 leading-relaxed" />,
    ul: ({ node: _node, ...props }) => <ul {...props} className="my-2 list-disc pl-6" />,
    ol: ({ node: _node, ...props }) => <ol {...props} className="my-2 list-decimal pl-6" />,
    li: ({ node: _node, ...props }) => <li {...props} className="my-0.5" />,
    blockquote: ({ node: _node, ...props }) => (
      <blockquote
        {...props}
        className="border-border text-muted-foreground my-2 border-l-2 pl-3 italic"
      />
    ),
    hr: ({ node: _node, ...props }) => <hr {...props} className="border-border my-4" />,
    table: ({ node: _node, ...props }) => (
      <div className="my-2 overflow-x-auto">
        <table {...props} className="border-border w-full border-collapse border text-sm" />
      </div>
    ),
    thead: ({ node: _node, ...props }) => <thead {...props} className="bg-muted" />,
    th: ({ node: _node, ...props }) => (
      <th {...props} className="border-border border px-3 py-1.5 text-left font-semibold" />
    ),
    td: ({ node: _node, ...props }) => (
      <td {...props} className="border-border border px-3 py-1.5" />
    ),
  };
}

export function MarkdownPreview({
  source,
  basePath,
  className,
  urlResolver,
}: {
  source: string;
  basePath: string;
  className?: string;
  /** 本地图片 URL 解析器；未注入时不改写 src（包内无法构造带 rootId 的文件 URL） */
  urlResolver?: ImgUrlResolver;
}) {
  const components = buildComponents(basePath, urlResolver ?? null);
  return (
    <div className={cn('min-w-0 text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, guardAutoDetect(source.length)]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
