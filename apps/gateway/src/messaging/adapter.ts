import { type CommandResult, type MessagingPlatform, chunkText } from '@tmex/shared/messaging';

export interface MessagingAdapter {
  platform: MessagingPlatform;
  limits: { maxTextChars: number; supportsActions: boolean };
  render(result: CommandResult): string[];
}

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
  if (result.text) blocks.push(escapeHtml(result.text));
  for (const section of result.sections ?? []) {
    if (section.title) blocks.push(`<b>${escapeHtml(section.title)}</b>`);
    const body = section.lines.join('\n');
    if (section.code) {
      const innerLimit = Math.max(1, maxChars - 11);
      for (const chunk of chunkText(escapeHtml(body), innerLimit)) {
        blocks.push(`<pre>${chunk}</pre>`);
      }
    } else if (body) {
      blocks.push(escapeHtml(body));
    }
  }
  const actions = actionLines(result);
  if (actions.length > 0) blocks.push(escapeHtml(actions.join('\n')));
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
