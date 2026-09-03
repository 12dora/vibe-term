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

export interface OpenFenceTail {
  lang: string;
  body: string;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function stripFenceIndent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && line.charCodeAt(cut) === 32) cut += 1;
  return cut === 0 ? line : line.slice(cut);
}

interface FenceOpen {
  char: string;
  length: number;
  indent: number;
  lang: string;
}

function parseFenceOpen(line: string): FenceOpen | null {
  const opened = FENCE_OPEN.exec(line);
  if (!opened) return null;
  const marker = opened[2];
  const char = marker[0];
  const info = opened[3];
  if (char === '`' && info.includes('`')) return null;
  return {
    char,
    length: marker.length,
    indent: opened[1].length,
    lang: info.trim().split(/\s+/)[0] ?? '',
  };
}

/** 同字符、且不短于开栏长度才算闭合 */
function closesFence(line: string, fence: FenceOpen): boolean {
  const closed = FENCE_CLOSE.exec(line);
  return closed !== null && closed[1][0] === fence.char && closed[1].length >= fence.length;
}

/** 栏内原文；扫到封口行返回 null */
function fenceBody(text: string, bodyStart: number, fence: FenceOpen): string | null {
  const stripped: string[] = [];
  let lineStart = bodyStart;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, nl === -1 ? text.length : nl);
    if (closesFence(line, fence)) return null;
    if (fence.indent > 0) stripped.push(stripFenceIndent(line, fence.indent));
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return fence.indent > 0 ? stripped.join('\n') : text.slice(bodyStart);
}

/**
 * 尾块以「已开、未闭」的围栏开头时返回围栏语言与栏内原文，交给纯 <pre> 直出；否则返回 null 走完整 parse。
 * 按 CommonMark 记住围栏字符与长度：更短或异种的内层围栏不算闭合。
 */
export function openFenceTail(text: string): OpenFenceTail | null {
  const firstBreak = text.indexOf('\n');
  const fence = parseFenceOpen(firstBreak === -1 ? text : text.slice(0, firstBreak));
  if (!fence) return null;
  if (firstBreak === -1) return { lang: fence.lang, body: '' };
  const raw = fenceBody(text, firstBreak + 1, fence);
  if (raw === null) return null;
  // 与 mdast→hast 的 code 节点对齐：栏内文本去掉末尾换行后，非空才补一个换行，封口时不跳版
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return { lang: fence.lang, body: trimmed === '' ? '' : `${trimmed}\n` };
}

const PRE_CLASS = 'bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs leading-relaxed';
const CODE_CLASS = 'bg-muted rounded px-1 font-mono text-xs';

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 break-all"
    />
  ),
  pre: ({ node: _node, ...props }) => <pre {...props} className={PRE_CLASS} />,
  code: ({ node: _node, className, ...props }) => (
    <code {...props} className={cn(CODE_CLASS, className)} />
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

/** 未封口围栏的直出：结构与 markdownComponents 封口后产出的 <pre><code> 一致，封口时不会跳版 */
function OpenFenceBlock({ lang, body }: OpenFenceTail) {
  return (
    <pre className={PRE_CLASS}>
      <code className={cn(CODE_CLASS, lang && `language-${lang}`)}>{body}</code>
    </pre>
  );
}

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
  // 尾块是未封口代码块时（补丁 / 长文件这类 agent 常见输出）只直出 <pre>，
  // 否则每 40 ms 一次 delta 都要把整个尾块重新喂给 react-markdown。
  const { blocks, fence } = useMemo(() => {
    const split = advanceMarkdownSplit(splitRef.current, text);
    splitRef.current = split;
    const open = openFenceTail(text.slice(split.openStart));
    return open ? { blocks: split.sealed, fence: open } : { blocks: split.blocks, fence: null };
  }, [text]);

  return (
    <div className={cn('flex min-w-0 flex-col gap-2 text-sm leading-relaxed', className)}>
      {blocks.map((block, index) => (
        // 块序号作 key：流式追加时前面的块内容不变，memo 直接命中
        // biome-ignore lint/suspicious/noArrayIndexKey: 块顺序只会尾部追加
        <MarkdownBlock key={index} content={block} />
      ))}
      {fence && <OpenFenceBlock lang={fence.lang} body={fence.body} />}
      {streaming && (
        <span
          data-testid="agent-streaming-cursor"
          className="bg-foreground inline-block h-4 w-2 animate-pulse self-start"
        />
      )}
    </div>
  );
}
