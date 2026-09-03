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

function briefLength(value: unknown): number {
  return JSON.stringify(value, null, 2)?.length ?? 0;
}

// 序列化长度已够铺满预览时停手；减 2 是让出末尾的 "\n]" / "\n}"，
// 保证保留部分与完整序列化在前 budget 个字符上逐字相同。
function enough(value: unknown, budget: number): boolean {
  return briefLength(value) - 2 >= budget;
}

// 深度上限只为兜住自引用结构：真实 input 到这个深度时预览预算早已铺满
const BRIEF_MAX_DEPTH = 32;

function capForBrief(value: unknown, budget: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length > budget ? value.slice(0, budget) : value;
  if (depth >= BRIEF_MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(capForBrief(item, budget, depth + 1));
      if (enough(out, budget)) break;
    }
    return out;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  // 用 Object.keys 逐个取值，避免 Object.entries 一次性读遍整个 input
  for (const key of Object.keys(value)) {
    out[key] = capForBrief(value[key], budget, depth + 1);
    if (enough(out, budget)) break;
  }
  return out;
}

/** 摘要专用：先按预算裁剪结构再序列化，未知工具的巨型 input 不必为 60 字符预览整体展开 */
export function asBriefText(value: unknown, max: number): string {
  if (typeof value === 'string') return value.slice(0, max);
  try {
    return (JSON.stringify(capForBrief(value, max), null, 2) ?? '').slice(0, max);
  } catch {
    return String(value).slice(0, max);
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

const fallbackBrief: BriefBuilder = (_input, call) =>
  truncated(asBriefText(call.input, 60), 60, '');

export function actionBrief(call: UiToolCall): string {
  const build = TOOL_BRIEFS.get(call.toolName) ?? fallbackBrief;
  return build(isRecord(call.input) ? call.input : {}, call);
}
