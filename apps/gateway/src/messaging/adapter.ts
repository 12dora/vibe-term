import { type CommandResult, type MessagingPlatform, chunkText } from '@tmex/shared/messaging';

export interface MessagingAdapter {
  platform: MessagingPlatform;
  limits: { maxTextChars: number; supportsActions: boolean };
  render(result: CommandResult): string[];
}

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapedCharLen(charCode: number): number {
  if (charCode === 38) return 5;
  if (charCode === 60 || charCode === 62) return 4;
  return 1;
}

function escapedLen(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    n += escapedCharLen(text.charCodeAt(i));
  }
  return n;
}

function hardSplitByEscaped(text: string, maxEscaped: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let used = 0;
    let j = i;
    while (j < text.length) {
      const add = escapedCharLen(text.charCodeAt(j));
      if (used + add > maxEscaped && j > i) break;
      used += add;
      j += 1;
    }
    if (j === i) j = i + 1;
    chunks.push(text.slice(i, j));
    i = j;
  }
  return chunks;
}

function takeEscapedLine(
  line: string,
  maxEscaped: number,
  buffer: string[],
  chunks: string[]
): void {
  if (escapedLen(line) > maxEscaped) {
    if (buffer.length > 0) {
      chunks.push(buffer.join('\n'));
      buffer.length = 0;
    }
    chunks.push(...hardSplitByEscaped(line, maxEscaped));
    return;
  }
  if (buffer.length === 0) {
    buffer.push(line);
    return;
  }
  const joined = `${buffer.join('\n')}\n${line}`;
  if (escapedLen(joined) <= maxEscaped) {
    buffer.push(line);
    return;
  }
  chunks.push(buffer.join('\n'));
  buffer.length = 0;
  buffer.push(line);
}

function chunkRawByEscapedLimit(text: string, maxEscaped: number): string[] {
  if (maxEscaped < 1) {
    throw new Error('maxEscaped must be >= 1');
  }
  if (text.length === 0) return [];
  if (escapedLen(text) <= maxEscaped) return [text];
  const chunks: string[] = [];
  const buffer: string[] = [];
  for (const line of text.split('\n')) {
    takeEscapedLine(line, maxEscaped, buffer, chunks);
  }
  if (buffer.length > 0) chunks.push(buffer.join('\n'));
  return chunks;
}

function escapeChunks(raw: string, maxChars: number): string[] {
  return chunkRawByEscapedLimit(raw, maxChars).map(escapeHtml);
}

function wrapEscapedChunks(raw: string, maxChars: number, open: string, close: string): string[] {
  const inner = Math.max(1, maxChars - open.length - close.length);
  return chunkRawByEscapedLimit(raw, inner).map((chunk) => `${open}${escapeHtml(chunk)}${close}`);
}

function packBlocks(blocks: string[], maxChars: number): string[] {
  const packed: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (block.length > maxChars) {
      if (current) packed.push(current);
      current = '';
      packed.push(...chunkText(block, maxChars));
      continue;
    }
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) packed.push(current);
    current = block;
  }
  if (current) packed.push(current);
  return packed;
}

function actionLines(result: CommandResult): string[] {
  return (result.actions ?? []).map((action) => `${action.command} — ${action.label}`);
}

export function renderPlain(result: CommandResult, maxChars: number): string[] {
  const blocks: string[] = [];
  if (result.text) blocks.push(result.text);
  for (const section of result.sections ?? []) {
    const body = section.lines.join('\n');
    blocks.push(section.title ? `${section.title}\n${body}` : body);
  }
  const actions = actionLines(result);
  if (actions.length > 0) blocks.push(actions.join('\n'));
  return packBlocks(blocks, maxChars);
}

export function renderTelegramHtml(result: CommandResult, maxChars: number): string[] {
  const blocks: string[] = [];
  if (result.text) blocks.push(...escapeChunks(result.text, maxChars));
  for (const section of result.sections ?? []) {
    if (section.title) blocks.push(...wrapEscapedChunks(section.title, maxChars, '<b>', '</b>'));
    const body = section.lines.join('\n');
    if (section.code) {
      if (body) blocks.push(...wrapEscapedChunks(body, maxChars, '<pre>', '</pre>'));
    } else if (body) {
      blocks.push(...escapeChunks(body, maxChars));
    }
  }
  const actions = actionLines(result);
  if (actions.length > 0) blocks.push(...escapeChunks(actions.join('\n'), maxChars));
  return packBlocks(blocks, maxChars);
}

export function createTelegramAdapter(): MessagingAdapter {
  return {
    platform: 'telegram',
    limits: { maxTextChars: 4000, supportsActions: true },
    render(result) {
      return renderTelegramHtml(result, 4000);
    },
  };
}

export function createWeixinAdapter(): MessagingAdapter {
  return {
    platform: 'weixin',
    limits: { maxTextChars: 2000, supportsActions: false },
    render(result) {
      return renderPlain(result, 2000);
    },
  };
}
