import { cleanTerminalText } from './run-command';
import {
  KEY_SEQUENCES,
  type SendInputKey,
  type SendInputModifier,
  encodeCombo,
} from './terminal-encoding';
import { wrapUntrusted } from './untrusted';

const SEND_INPUT_TAIL_LINES = 15;

export interface SendInputCombo {
  modifiers?: readonly SendInputModifier[];
  key: string;
}

export interface SendInputPayloadInput {
  text?: string;
  combos?: readonly SendInputCombo[];
  rawControlChars?: string;
  keys?: readonly SendInputKey[];
  allowControlChars: boolean;
}

export interface SendInputPayload {
  data: string;
  warnings: string[];
}

const RAW_CONTROL_CHARS_WARNING =
  'rawControlChars was ignored because the session does not allow control characters; use combos (e.g. ctrl+c) instead.';

export function buildSendInputPayload(input: SendInputPayloadInput): SendInputPayload {
  const warnings: string[] = [];
  if (input.rawControlChars && !input.allowControlChars) {
    warnings.push(RAW_CONTROL_CHARS_WARNING);
  }
  const data =
    (input.text ?? '') +
    (input.combos ?? [])
      .map((combo) => encodeCombo({ modifiers: combo.modifiers, key: combo.key }))
      .join('') +
    (input.keys ?? []).map((key) => KEY_SEQUENCES[key] ?? '').join('') +
    (input.allowControlChars ? (input.rawControlChars ?? '') : '');
  return { data, warnings };
}

export interface EmulatorPaneInfo {
  cols: number;
  rows: number;
  cursorX: number | null;
  cursorY: number | null;
}

export interface FormatEmulatorResultInput {
  alternateScreen: boolean;
  screen: string;
  deltaBytes: Uint8Array;
  info: EmulatorPaneInfo | null;
  emulatorSize: { cols: number; rows: number };
  warnings: readonly string[];
  capturedAt: string;
}

export type SendInputEmulatorResult =
  | {
      screen: string;
      mode: 'screen';
      cols: number;
      rows: number;
      cursorX: number | null;
      cursorY: number | null;
      warnings?: string[];
      capturedAt: string;
    }
  | {
      delta: string;
      mode: 'delta';
      cols: number;
      rows: number;
      cursorX: number | null;
      cursorY: number | null;
      warnings?: string[];
      capturedAt: string;
    };

export interface FormatFallbackResultInput {
  screen: string;
  info: { cols: number; rows: number } | null;
  warnings: readonly string[];
  capturedAt: string;
}

export interface SendInputFallbackResult {
  screenTail: string;
  cols: number | null;
  rows: number | null;
  warnings?: string[];
  capturedAt: string;
}

function withWarnings<T extends object>(
  result: T,
  warnings: readonly string[]
): T & { warnings?: string[] } {
  if (warnings.length === 0) {
    return result;
  }
  return { ...result, warnings: [...warnings] };
}

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

export function formatEmulatorResult(input: FormatEmulatorResultInput): SendInputEmulatorResult {
  const cols = input.info?.cols ?? input.emulatorSize.cols;
  const rows = input.info?.rows ?? input.emulatorSize.rows;
  const cursorX = input.info?.cursorX ?? null;
  const cursorY = input.info?.cursorY ?? null;
  if (input.alternateScreen) {
    return withWarnings(
      {
        screen: wrapUntrusted(input.screen, 'terminal'),
        mode: 'screen' as const,
        cols,
        rows,
        cursorX,
        cursorY,
        capturedAt: input.capturedAt,
      },
      input.warnings
    );
  }
  const delta = cleanTerminalText(new TextDecoder().decode(input.deltaBytes));
  return withWarnings(
    {
      delta: wrapUntrusted(delta, 'terminal'),
      mode: 'delta' as const,
      cols,
      rows,
      cursorX,
      cursorY,
      capturedAt: input.capturedAt,
    },
    input.warnings
  );
}

export function formatFallbackResult(input: FormatFallbackResultInput): SendInputFallbackResult {
  return withWarnings(
    {
      screenTail: wrapUntrusted(tailLines(input.screen, SEND_INPUT_TAIL_LINES), 'terminal'),
      cols: input.info?.cols ?? null,
      rows: input.info?.rows ?? null,
      capturedAt: input.capturedAt,
    },
    input.warnings
  );
}
