// 流式 markdown 渲染：按 fence 感知的空行分块，块级 memo，
// 流式追加时只重扫最后一个未封口块并只 parse 它，前面的块直接命中 memo。

import { cn } from '@tmex/ui';
import { memo, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const FENCE = /^\s*(```|~~~)/;

/** 增量分块的续扫点：sealed 是已被空行封口、不会再被追加改变的块 */
export interface MarkdownSplit {
  text: string;
  sealed: string[];
  /** 未封口块在 text 中的起点（该位置必不在围栏内） */
  openStart: number;
  blocks: string[];
}

export const EMPTY_MARKDOWN_SPLIT: MarkdownSplit = {
  text: '',
  sealed: [],
  openStart: 0,
  blocks: [],
};

/** 在代码块围栏外的空行处分块（围栏内的双换行不是块边界） */
function splitTail(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const pushCurrent = (): void => {
    const block = current.join('\n');
    if (block.trim()) {
      blocks.push(block);
    }
    current = [];
  };

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      pushCurrent();
      continue;
    }
    current.push(line);
  }
  pushCurrent();

  return blocks;
}

/**
 * 从上次结果续扫：只有「以换行结尾的围栏外空行」才是终局边界，其前的块不会再变；
 * 尾部未封口区每次重扫（末行是否为空行还可能被下一段 delta 改写）。
 * text 不以上次文本为前缀时退回全量扫描。
 */
export function advanceMarkdownSplit(prev: MarkdownSplit, text: string): MarkdownSplit {
  const base = text.startsWith(prev.text) ? prev : EMPTY_MARKDOWN_SPLIT;
  const appended: string[] = [];
  let openStart = base.openStart;
  let inFence = false;
  let lineStart = openStart;
  let nl = text.indexOf('\n', lineStart);

  while (nl !== -1) {
    const line = text.slice(lineStart, nl);
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (!inFence && line.trim() === '') {
      const block = lineStart > openStart ? text.slice(openStart, lineStart - 1) : '';
      if (block.trim()) appended.push(block);
      openStart = nl + 1;
    }
    lineStart = nl + 1;
    nl = text.indexOf('\n', lineStart);
  }

  const sealed = appended.length ? [...base.sealed, ...appended] : base.sealed;
  const tail = splitTail(text.slice(openStart));
  return { text, sealed, openStart, blocks: tail.length ? [...sealed, ...tail] : sealed };
}

export function splitMarkdownBlocks(text: string): string[] {
  return advanceMarkdownSplit(EMPTY_MARKDOWN_SPLIT, text).blocks;
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 break-all"
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs leading-relaxed"
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code {...props} className={cn('bg-muted rounded px-1 font-mono text-xs', className)} />
  ),
  ul: ({ node: _node, ...props }) => <ul {...props} className="list-disc pl-5" />,
  ol: ({ node: _node, ...props }) => <ol {...props} className="list-decimal pl-5" />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote {...props} className="border-border text-muted-foreground border-l-2 pl-2" />
  ),
  h1: ({ node: _node, ...props }) => <h1 {...props} className="text-base font-semibold" />,
  h2: ({ node: _node, ...props }) => <h2 {...props} className="text-sm font-semibold" />,
  h3: ({ node: _node, ...props }) => <h3 {...props} className="text-sm font-semibold" />,
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className="border-border w-full border-collapse border text-xs" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th {...props} className="border-border bg-muted border px-2 py-1 text-left" />
  ),
  td: ({ node: _node, ...props }) => <td {...props} className="border-border border px-2 py-1" />,
};

const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const splitRef = useRef(EMPTY_MARKDOWN_SPLIT);
  const blocks = useMemo(() => {
    splitRef.current = advanceMarkdownSplit(splitRef.current, text);
    return splitRef.current.blocks;
  }, [text]);

  return (
    <div className={cn('flex min-w-0 flex-col gap-2 text-sm leading-relaxed', className)}>
      {blocks.map((block, index) => (
        // 块序号作 key：流式追加时前面的块内容不变，memo 直接命中
        // biome-ignore lint/suspicious/noArrayIndexKey: 块顺序只会尾部追加
        <MarkdownBlock key={index} content={block} />
      ))}
      {streaming && (
        <span
          data-testid="agent-streaming-cursor"
          className="bg-foreground inline-block h-4 w-2 animate-pulse self-start"
        />
      )}
    </div>
  );
}
