import {
  type ExplicitLinkSource,
  type ExplicitLinkSpan,
  explicitSpanAt,
  explicitSpanHit,
  overlapsExplicitSpan,
} from './explicit-links';
import { type FileLinkContext, resolveValidFilePath } from './file-path';
import { type WrappedMatch, detectMatchesInWrappedLines } from './link-detector';
import type { SelectionLineModel } from './selection-model';
import type { TerminalLinkHit } from './terminal-pointer';

export type LineModelReader = (line: number) => SelectionLineModel;

export type WrappedLogicalLine = {
  startLine: number;
  endLine: number;
  models: SelectionLineModel[];
};

export type LinkUnderlineSegment = {
  row: number;
  startCol: number;
  endCol: number;
};

export type LinkQuery = {
  getLineModel: LineModelReader;
  cache: LinkMatchCache;
  fileLinkContext: FileLinkContext | null;
  explicitLinks?: ExplicitLinkSource;
};

const NO_EXPLICIT_SPANS: readonly ExplicitLinkSpan[] = [];

// 把 line 所在的软换行逻辑行整体取出：向前回溯到起始行、向后延伸到结束行，并收集沿途
// 行模型。越界行 getLineModel 返回 EMPTY（wrappedToNext=false），使前后扩展在视口边界
// 自然停止。
export function collectWrappedLogicalLine(
  line: number,
  getLineModel: LineModelReader
): WrappedLogicalLine {
  let startLine = line;
  while (getLineModel(startLine - 1).wrappedToNext) {
    startLine -= 1;
  }
  let endLine = line;
  while (getLineModel(endLine).wrappedToNext) {
    endLine += 1;
  }

  const models: SelectionLineModel[] = [];
  for (let l = startLine; l <= endLine; l += 1) {
    models.push(getLineModel(l));
  }

  return { startLine, endLine, models };
}

// 逻辑行的缓存键：滚动时每秒要为整屏逻辑行各建一次（约 120 列 × 行数），逐字符 += 会
// 沿途产生一长串中间字符串，改用整段 join 一次成串。
export function cacheKey(models: SelectionLineModel[]): string {
  const parts: string[] = [];
  for (const model of models) {
    const chars = model.colChars;
    const cells = new Array<string>(chars.length);
    for (let index = 0; index < chars.length; index += 1) {
      cells[index] = chars[index] ?? '\u0000';
    }
    parts.push(cells.join(''), '\u0001');
  }
  return parts.join('');
}

// 逻辑行文本 → 检测结果（候选，不含有效性），LRU；正则只对新出现的文本执行。
export class LinkMatchCache {
  private readonly entries = new Map<string, WrappedMatch[]>();

  constructor(private readonly limit: number) {}

  detect(models: SelectionLineModel[]): WrappedMatch[] {
    const key = cacheKey(models);

    const cached = this.entries.get(key);
    if (cached) {
      // LRU：命中后移到末尾
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const matches = detectMatchesInWrappedLines(models);
    this.entries.set(key, matches);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    return matches;
  }

  clear(): void {
    this.entries.clear();
  }
}

// explicit 段先落下划线，并按行留存供正则结果做重叠剔除。
function collectExplicitSegments(
  options: LinkQuery & { offset: number; rows: number },
  segments: LinkUnderlineSegment[]
): Map<number, readonly ExplicitLinkSpan[]> {
  const byLine = new Map<number, readonly ExplicitLinkSpan[]>();
  const explicitLinks = options.explicitLinks;
  if (!explicitLinks) {
    return byLine;
  }
  for (let line = options.offset; line < options.offset + options.rows; line += 1) {
    const spans = explicitLinks(line);
    byLine.set(line, spans);
    for (const span of spans) {
      if (explicitSpanHit(span, options.fileLinkContext)) {
        segments.push({ row: line - options.offset, startCol: span.startCol, endCol: span.endCol });
      }
    }
  }
  return byLine;
}

// 只扫可见区：按 wrap 分组成逻辑行（经行缓存可延伸出视口边界），检测结果按逻辑行文本
// 缓存；文件候选用当前上下文过滤有效性后连同 URL 一起返回。
export function collectLinkUnderlineSegments(
  options: LinkQuery & { offset: number; rows: number }
): LinkUnderlineSegment[] {
  const { offset, getLineModel, cache, fileLinkContext } = options;
  const end = offset + options.rows;
  const segments: LinkUnderlineSegment[] = [];
  const explicitByLine = collectExplicitSegments(options, segments);

  let line = offset;
  while (line < end) {
    if (getLineModel(line).colChars.length === 0) {
      line += 1;
      continue;
    }

    const { startLine, endLine, models } = collectWrappedLogicalLine(line, getLineModel);
    for (const match of cache.detect(models)) {
      const matchLine = startLine + match.lineIndex;
      if (matchLine < offset || matchLine >= end) {
        continue;
      }
      if (match.kind === 'file' && !resolveValidFilePath(match.text, fileLinkContext)) {
        continue;
      }
      const explicit = explicitByLine.get(matchLine) ?? NO_EXPLICIT_SPANS;
      if (overlapsExplicitSpan(explicit, match.startCol, match.endCol)) {
        continue;
      }
      segments.push({
        row: matchLine - offset,
        startCol: match.startCol,
        endCol: match.endCol,
      });
    }

    line = endLine + 1;
  }

  return segments;
}

// 命中检测：OSC 8 段优先（带标记的格子即便 URI 不可打开也不再走正则）；否则把目标行所在的
// 软换行逻辑行整体取出做链接识别，与 explicit 段重叠的正则匹配丢弃。文件候选须经 cwd/授权根
// 解析有效才算命中，返回解析后的绝对路径。
export function findLinkAtPoint(
  options: LinkQuery & { line: number; col: number }
): TerminalLinkHit | null {
  const { line, col, getLineModel, cache, fileLinkContext } = options;
  const explicit = options.explicitLinks?.(line) ?? NO_EXPLICIT_SPANS;
  const span = explicitSpanAt(explicit, col);
  if (span) {
    return explicitSpanHit(span, fileLinkContext);
  }
  if (getLineModel(line).colChars.length === 0) {
    return null;
  }

  const { startLine, models } = collectWrappedLogicalLine(line, getLineModel);
  const targetIndex = line - startLine;
  for (const match of cache.detect(models)) {
    if (match.lineIndex !== targetIndex || col < match.startCol || col > match.endCol) {
      continue;
    }
    if (overlapsExplicitSpan(explicit, match.startCol, match.endCol)) {
      continue;
    }
    const hit = detectedHit(match.kind, match.text, fileLinkContext);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function detectedHit(
  kind: 'url' | 'file',
  text: string,
  fileLinkContext: FileLinkContext | null
): TerminalLinkHit | null {
  if (kind === 'url') {
    return { kind: 'url', url: text, explicit: false };
  }
  const resolved = resolveValidFilePath(text, fileLinkContext);
  return resolved ? { kind: 'file', path: resolved, explicit: false } : null;
}
