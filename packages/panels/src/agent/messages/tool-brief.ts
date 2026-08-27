// 工具调用的纯文本摘要：按 toolName 查表，未知工具回退到 input 序列化。

import type { UiToolCall } from '@tmex/stores';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ToolInput = Record<string, unknown>;
type BriefBuilder = (input: ToolInput, call: UiToolCall) => string;

function stringField(input: ToolInput, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function truncated(text: string, max: number, fallback: string): string {
  return text.slice(0, max) || fallback;
}

function sendInputBrief(input: ToolInput): string {
  const parts: string[] = [];
  const text = stringField(input, 'text');
  if (text) parts.push(text.slice(0, 40));
  const keyCount = arrayLength(input.combos) + arrayLength(input.keys);
  if (keyCount > 0) parts.push(`+${keyCount} key${keyCount > 1 ? 's' : ''}`);
  return parts.join(' · ') || '(empty)';
}

function readScreenBrief(_input: ToolInput, call: UiToolCall): string {
  const output = isRecord(call.output) ? call.output : {};
  const rows = typeof output.rows === 'number' ? output.rows : null;
  return rows !== null ? `(${rows} rows)` : '(screen)';
}

// 用 Map 而非对象字面量：toolName 来自模型/MCP，对象查表会命中 Object.prototype 上的同名成员
export const TOOL_BRIEFS = new Map<string, BriefBuilder>([
  ['send_input', sendInputBrief],
  ['read_screen', readScreenBrief],
  ['run_command', (input) => truncated(stringField(input, 'command'), 60, '(command)')],
  ['web_search', (input) => truncated(stringField(input, 'query'), 60, '(query)')],
  ['fetch_url', (input) => truncated(stringField(input, 'url'), 60, '(url)')],
  ['get_pane_info', () => '(pane info)'],
]);

const fallbackBrief: BriefBuilder = (_input, call) => truncated(asText(call.input), 60, '');

export function actionBrief(call: UiToolCall): string {
  const build = TOOL_BRIEFS.get(call.toolName) ?? fallbackBrief;
  return build(isRecord(call.input) ? call.input : {}, call);
}
