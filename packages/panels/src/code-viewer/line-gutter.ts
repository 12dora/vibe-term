// 行号栏与超大文件的分块切分。
//
// 行号不用 CSS counter：counter 需要每行一个元素，6 万行文件等于多 6 万个 DOM 节点，
// 比一个文本节点更贵（实测拼串本身 60k 行仅 2.0 ms，瓶颈从来不是拼串而是整段 <pre> 的布局）。
// 真正省下的是布局：块按固定行数切分并缓存——块内容与文件无关，只与起始行号有关，
// 于是同一批块串在所有文件之间复用；块再配 content-visibility 让屏外块不参与布局。

export const GUTTER_BLOCK_LINES = 500;

const BLOCK_CACHE_LIMIT = 256;
const blockCache = new Map<number, string>();

/** 统计行数：不走 split，避免为 6 万行文件额外分配一个 6 万项数组。 */
export function countLines(code: string): number {
  let lines = 1;
  let index = code.indexOf('\n');
  while (index !== -1) {
    lines++;
    index = code.indexOf('\n', index + 1);
  }
  return lines;
}

/** 一个块的行号文本（含换行分隔）。整块结果跨文件复用。 */
export function gutterBlockText(startLine: number, lineCount: number): string {
  const cacheable = lineCount === GUTTER_BLOCK_LINES && blockCache.size < BLOCK_CACHE_LIMIT;
  const cached = lineCount === GUTTER_BLOCK_LINES ? blockCache.get(startLine) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  let text = '';
  for (let i = 0; i < lineCount; i++) {
    text += i > 0 ? `\n${startLine + i}` : `${startLine}`;
  }
  if (cacheable) {
    blockCache.set(startLine, text);
  }
  return text;
}

/** 整栏行号文本，由缓存块拼出。 */
export function gutterText(lineCount: number): string {
  let text = '';
  for (let start = 1; start <= lineCount; start += GUTTER_BLOCK_LINES) {
    const lines = Math.min(GUTTER_BLOCK_LINES, lineCount - start + 1);
    text += start > 1 ? `\n${gutterBlockText(start, lines)}` : gutterBlockText(start, lines);
  }
  return text;
}

export interface CodeBlock {
  startLine: number;
  lineCount: number;
  text: string;
}

/** 按行数切块；各块 lineCount 之和恒等于 countLines(code)，块文本不含结尾换行。 */
export function splitCodeBlocks(code: string, blockLines: number): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let offset = 0;
  let startLine = 1;
  for (;;) {
    let end = offset;
    let lineCount = 0;
    let isLast = false;
    while (lineCount < blockLines) {
      const newline = code.indexOf('\n', end);
      lineCount++;
      if (newline === -1) {
        end = code.length;
        isLast = true;
        break;
      }
      end = newline + 1;
    }
    blocks.push({
      startLine,
      lineCount,
      text: isLast ? code.slice(offset) : code.slice(offset, end - 1),
    });
    if (isLast) {
      return blocks;
    }
    offset = end;
    startLine += lineCount;
  }
}
