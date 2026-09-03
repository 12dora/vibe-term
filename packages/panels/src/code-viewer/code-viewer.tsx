// 代码/纯文本查看器：highlight.js 高亮 + 终端 seoul256 配色（hljs-terminal-theme.css）。
// 左侧行号栏 + 右侧可横向滚动代码区，font-mono 与终端共享字体栈。
//
// 高亮不在渲染路径上：先把纯文本上屏，highlight.js 在 worker 里跑完再换成高亮 HTML
// （worker 不可用时退回主线程，但先让出一帧）。语言模块按当前文件按需注册，不再全量急加载。

import { cn } from '@tmex/ui';
import { useMemo } from 'react';
import './hljs-terminal-theme.css';
import { HIGHLIGHT_LIMIT } from './language-map';
import {
  GUTTER_BLOCK_LINES,
  countLines,
  gutterBlockText,
  gutterText,
  splitCodeBlocks,
} from './line-gutter';
import { useHighlightedCode } from './use-highlighted-code';

// text-[13px] leading-[1.5]，用于给屏外块估高。
const LINE_HEIGHT_PX = 19.5;

const CONTAINER_CLASS =
  'hljs w-full overflow-x-auto font-mono text-[13px] leading-[1.5] [-webkit-overflow-scrolling:touch]';
const GUTTER_CLASS =
  'm-0 shrink-0 select-none border-r border-current/10 px-3 text-right opacity-40';

export interface CodeViewerProps {
  code: string;
  fileName: string;
  className?: string;
}

function CodeBlocks({ code, lineCount }: { code: string; lineCount: number }) {
  const blocks = useMemo(() => splitCodeBlocks(code, GUTTER_BLOCK_LINES), [code]);
  const gutterWidth = `${String(lineCount).length}ch`;
  return (
    <>
      {blocks.map((block) => (
        <div
          key={block.startLine}
          className="flex w-max min-w-full"
          style={{
            contentVisibility: 'auto',
            containIntrinsicHeight: `auto ${(block.lineCount * LINE_HEIGHT_PX).toFixed(1)}px`,
          }}
        >
          <pre
            aria-hidden="true"
            className={GUTTER_CLASS}
            style={{ whiteSpace: 'pre', width: gutterWidth }}
          >
            {gutterBlockText(block.startLine, block.lineCount)}
          </pre>
          <pre className="m-0 px-3" style={{ whiteSpace: 'pre' }}>
            {block.text}
          </pre>
        </div>
      ))}
    </>
  );
}

export function CodeViewer({ code, fileName, className }: CodeViewerProps) {
  const html = useHighlightedCode(code, fileName);
  const lineCount = useMemo(() => countLines(code), [code]);
  // 超过高亮上限的文件永远是纯文本（planHighlight 判定为 plain，根本不会发高亮请求）：
  // 按行块渲染 + content-visibility，屏外块不参与布局。
  const blocked = code.length > HIGHLIGHT_LIMIT;
  const lineNumbers = useMemo(() => (blocked ? '' : gutterText(lineCount)), [blocked, lineCount]);

  if (blocked) {
    return (
      <div className={cn(CONTAINER_CLASS, 'py-2', className)}>
        <CodeBlocks code={code} lineCount={lineCount} />
      </div>
    );
  }

  return (
    <div className={cn(CONTAINER_CLASS, 'flex', className)}>
      <pre aria-hidden="true" className={cn(GUTTER_CLASS, 'py-2')} style={{ whiteSpace: 'pre' }}>
        {lineNumbers}
      </pre>
      <pre className="m-0 min-w-0 flex-1 px-3 py-2" style={{ whiteSpace: 'pre' }}>
        {html === null ? (
          <code className="hljs bg-transparent">{code}</code>
        ) : (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js 输出，内容已被其转义
          <code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
