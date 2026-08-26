import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { cleanTerminalText } from './run-command';
import {
  type TerminalToolContext,
  checkRuntimeAlive,
  failTool,
  liveEmulator,
  toToolErrorMessage,
} from './terminal-context';
import {
  COMBO_KEY_ENUM,
  KEY_SEQUENCES,
  SEND_INPUT_KEYS,
  SEND_INPUT_MODIFIERS,
  type SendInputKey,
  encodeCombo,
} from './terminal-encoding';
import { wrapUntrusted } from './untrusted';

const SEND_INPUT_SETTLE_MS = 300;
const SEND_INPUT_TAIL_LINES = 15;
const SEND_INPUT_TEXT_MAX_CHARS = 16384;
const RAW_CONTROL_CHARS_MAX = 4096;

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

export function createSendInputTool(ctx: TerminalToolContext): Tool {
  return tool({
    description:
      'Send raw input/keystrokes to the bound tmux pane (for interactive programs and TUIs). Use `text` for literal text, `combos` for modifier+key combinations (e.g. {modifiers:["ctrl"], key:"c"} or {key:"up"}), and `rawControlChars` for low-level control bytes (only honored when the session has control-chars mode enabled — otherwise ignored with a warning). `keys` is the legacy special-key list, kept for backward compatibility. Returns the new output since sending (line mode) or the full re-rendered screen (TUI/alternate mode), both untrusted data, plus live size. For running a shell command and capturing its full output + exit code, prefer run_command.',
    inputSchema: z
      .object({
        text: z
          .string()
          .max(SEND_INPUT_TEXT_MAX_CHARS)
          .optional()
          .describe('Literal text to type into the pane.'),
        combos: z
          .array(
            z.object({
              modifiers: z.array(z.enum(SEND_INPUT_MODIFIERS)).optional(),
              key: COMBO_KEY_ENUM,
            })
          )
          .optional()
          .describe(
            'Modifier+key combinations to send after the text, in order. Each item: {modifiers?: ["ctrl"|"alt"|"meta"|"shift"], key: single char or named key (enter/tab/escape/backspace/space/up/down/left/right/home/end/pageup/pagedown/insert/delete/f1..f12)}.'
          ),
        rawControlChars: z
          .string()
          .max(RAW_CONTROL_CHARS_MAX)
          .optional()
          .describe(
            'Raw control bytes (e.g. "\\x03") injected verbatim. SECURITY: only honored when the session explicitly enables control-chars mode; otherwise silently ignored with a warning. Prefer combos (ctrl+c) whenever possible.'
          ),
        keys: z
          .array(z.enum(SEND_INPUT_KEYS))
          .optional()
          .describe(
            'Legacy special-key list (backward compat). Mapped onto combos internally; prefer combos for new calls.'
          ),
      })
      .refine(
        (value) =>
          Boolean(value.text?.length) ||
          Boolean(value.combos?.length) ||
          Boolean(value.keys?.length) ||
          Boolean(value.rawControlChars?.length),
        { message: 'Either text, combos, keys, or rawControlChars must be provided.' }
      ),
    needsApproval: () => ctx.needsApprovalForWrite,
    execute: async ({ text, combos, rawControlChars, keys }) => {
      const aliveError = checkRuntimeAlive(ctx);
      if (aliveError) {
        return aliveError;
      }
      const runtime = ctx.getRuntime();
      if (!runtime) {
        return failTool(ctx, 'Terminal connection is not available.');
      }
      const emulator = liveEmulator(ctx);
      const warnings: string[] = [];
      if (rawControlChars && !ctx.allowControlChars) {
        warnings.push(
          'rawControlChars was ignored because the session does not allow control characters; use combos (e.g. ctrl+c) instead.'
        );
      }
      try {
        const data =
          (text ?? '') +
          (combos ?? []).map((c) => encodeCombo({ modifiers: c.modifiers, key: c.key })).join('') +
          (keys ?? []).map((k) => KEY_SEQUENCES[k as SendInputKey] ?? '').join('') +
          (ctx.allowControlChars ? (rawControlChars ?? '') : '');

        if (emulator) {
          const buf: number[] = [];
          const untap = emulator.tap({
            onBytes: (chunk) => {
              for (const byte of chunk) {
                buf.push(byte);
              }
            },
          });
          try {
            runtime.sendInput(ctx.paneId, data);
            await ctx.sleepMs(SEND_INPUT_SETTLE_MS);
          } finally {
            untap();
          }
          ctx.onSuccess();
          const info = await runtime.getPaneInfo(ctx.paneId).catch(() => null);
          if (emulator.isAlternateScreen()) {
            return {
              screen: wrapUntrusted(emulator.render(), 'terminal'),
              mode: 'screen' as const,
              cols: info?.cols ?? emulator.size().cols,
              rows: info?.rows ?? emulator.size().rows,
              cursorX: info?.cursorX ?? null,
              cursorY: info?.cursorY ?? null,
              ...(warnings.length > 0 ? { warnings } : {}),
              capturedAt: new Date().toISOString(),
            };
          }
          const delta = cleanTerminalText(new TextDecoder().decode(new Uint8Array(buf)));
          return {
            delta: wrapUntrusted(delta, 'terminal'),
            mode: 'delta' as const,
            cols: info?.cols ?? emulator.size().cols,
            rows: info?.rows ?? emulator.size().rows,
            cursorX: info?.cursorX ?? null,
            cursorY: info?.cursorY ?? null,
            ...(warnings.length > 0 ? { warnings } : {}),
            capturedAt: new Date().toISOString(),
          };
        }

        runtime.sendInput(ctx.paneId, data);
        await ctx.sleepMs(SEND_INPUT_SETTLE_MS);
        const [screen, info] = await Promise.all([
          runtime.capturePaneText(ctx.paneId, { historyLines: 0 }),
          runtime.getPaneInfo(ctx.paneId).catch(() => null),
        ]);
        ctx.onSuccess();
        return {
          screenTail: wrapUntrusted(tailLines(screen, SEND_INPUT_TAIL_LINES), 'terminal'),
          cols: info?.cols ?? null,
          rows: info?.rows ?? null,
          ...(warnings.length > 0 ? { warnings } : {}),
          capturedAt: new Date().toISOString(),
        };
      } catch (error) {
        return failTool(ctx, `Failed to send input to pane: ${toToolErrorMessage(error)}`);
      }
    },
  });
}
