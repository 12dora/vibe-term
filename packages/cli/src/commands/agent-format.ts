// `vibeterm agent` 人读输出：短表、消息预览。

import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
} from '@vibeterm/shared';
import { dash, shortId } from '../core/cmd';
import type { CliContext } from '../core/context';

const PREVIEW_MAX = 60;
const SHOW_MESSAGE_LIMIT = 20;

export function sessionColumns(): {
  header: string;
  value: (row: AgentSessionDto) => string;
}[] {
  return [
    { header: 'ID', value: (row) => shortId(row.id) },
    { header: 'TITLE', value: (row) => row.title },
    { header: 'STATUS', value: (row) => row.status },
    { header: 'DEVICE', value: (row) => dash(row.deviceId ? shortId(row.deviceId) : null) },
    { header: 'PANE', value: (row) => dash(row.paneId) },
    { header: 'MODEL', value: (row) => dash(row.modelId) },
    { header: 'WRITE', value: (row) => row.writeMode },
  ];
}

export function printSessionRows(ctx: CliContext, sessions: AgentSessionDto[]): void {
  ctx.out.table(sessions, sessionColumns());
}

export function printSessionDetail(
  ctx: CliContext,
  session: AgentSessionDto,
  messages: AgentMessageDto[]
): void {
  ctx.out.line(`id       ${session.id}`);
  ctx.out.line(`title    ${session.title}`);
  ctx.out.line(`status   ${session.status}`);
  ctx.out.line(`device   ${dash(session.deviceId)}`);
  ctx.out.line(`pane     ${dash(session.paneId)}`);
  ctx.out.line(`node     ${dash(session.nodeId)}`);
  ctx.out.line(`provider ${dash(session.providerId)}`);
  ctx.out.line(`model    ${session.modelId}`);
  ctx.out.line(`write    ${session.writeMode}`);
  ctx.out.line(`chars    ${session.allowControlChars ? 'on' : 'off'}`);
  if (session.lastError) ctx.out.line(`error    ${session.lastError}`);
  const recent = messages.slice(-SHOW_MESSAGE_LIMIT);
  if (recent.length === 0) {
    ctx.out.line('messages (none)');
    return;
  }
  ctx.out.line(`messages ${recent.length}${messages.length > recent.length ? '+' : ''}`);
  ctx.out.table(recent, [
    { header: 'SEQ', value: (row) => String(row.seq) },
    { header: 'ROLE', value: (row) => row.role },
    { header: 'TEXT', value: (row) => messagePreview(row.content) },
  ]);
}

export function printQueued(ctx: CliContext, queued: AgentQueuedMessageDto[]): void {
  ctx.out.table(queued, [
    { header: 'ID', value: (row) => shortId(row.id) },
    { header: 'SEQ', value: (row) => String(row.seq) },
    { header: 'TEXT', value: (row) => preview(row.text) },
  ]);
}

export function printConfirmations(ctx: CliContext, rows: AgentConfirmationDto[]): void {
  ctx.out.table(rows, [
    { header: 'ID', value: (row) => shortId(row.id) },
    { header: 'TOOL', value: (row) => row.toolName },
    { header: 'STATUS', value: (row) => row.status },
    { header: 'REASON', value: (row) => dash(row.reason) },
  ]);
}

export function messagePreview(content: unknown): string {
  return preview(extractText(content));
}

function preview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '-';
  return compact.length > PREVIEW_MAX ? `${compact.slice(0, PREVIEW_MAX - 1)}…` : compact;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join(' ');
  }
  if (!content || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (obj.content !== undefined) return extractText(obj.content);
  return '';
}
