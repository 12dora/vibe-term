// Watch 规则创建 / 编辑请求体。

import type { FlagValues } from './args';
import { flagBool, flagNumber, flagString } from './args';
import { mergeBody, parseOnOff, resolveJsonBody } from './cmd';
import { UsageError } from './errors';

const TRIGGERS = new Set(['match', 'unchanged', 'llm']);
const FIRE_MODES = new Set(['once', 'repeat']);
const NO_MATCH = new Set(['reset', 'ignore']);

function setString(
  body: Record<string, unknown>,
  flags: FlagValues,
  flag: string,
  key: string
): void {
  const value = flagString(flags, flag);
  if (value) body[key] = value;
}

function setNumber(
  body: Record<string, unknown>,
  flags: FlagValues,
  flag: string,
  key: string
): void {
  const value = flagNumber(flags, flag);
  if (value !== undefined) body[key] = value;
}

function enumFlag(
  flags: FlagValues,
  flag: string,
  allowed: Set<string>,
  message: string
): string | undefined {
  const value = flagString(flags, flag);
  if (!value) return undefined;
  if (!allowed.has(value)) throw new UsageError(message);
  return value;
}

function applyWatchFlags(flags: FlagValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  setString(body, flags, 'name', 'name');
  setString(body, flags, 'device', 'deviceId');
  setString(body, flags, 'pane', 'paneId');
  const trigger = enumFlag(
    flags,
    'trigger-type',
    TRIGGERS,
    '--trigger-type must be match|unchanged|llm'
  );
  if (trigger) body.triggerType = trigger;
  setString(body, flags, 'pattern', 'pattern');
  setString(body, flags, 'flags', 'patternFlags');
  if (flagBool(flags, 'enabled')) body.enabled = true;
  if (flagBool(flags, 'disabled')) body.enabled = false;
  setNumber(body, flags, 'interval', 'intervalSeconds');
  setNumber(body, flags, 'cooldown', 'cooldownSeconds');
  const fireMode = enumFlag(flags, 'fire-mode', FIRE_MODES, '--fire-mode must be once|repeat');
  if (fireMode) body.fireMode = fireMode;
  setNumber(body, flags, 'unchanged-minutes', 'unchangedMinutes');
  const noMatch = enumFlag(flags, 'no-match', NO_MATCH, '--no-match must be reset|ignore');
  if (noMatch) body.noMatchBehavior = noMatch;
  setString(body, flags, 'prompt', 'conditionPrompt');
  return body;
}

function requireWatchFields(
  merged: Record<string, unknown>,
  required: { name?: boolean; device?: boolean; pane?: boolean; trigger?: boolean }
): void {
  if (required.name && typeof merged.name !== 'string') throw new UsageError('missing --name');
  if (required.device && typeof merged.deviceId !== 'string')
    throw new UsageError('missing --device');
  if (required.pane && typeof merged.paneId !== 'string') throw new UsageError('missing --pane');
  if (required.trigger && typeof merged.triggerType !== 'string') {
    throw new UsageError('missing --trigger-type match|unchanged|llm');
  }
}

export async function watchRuleBody(
  flags: FlagValues,
  required: { name?: boolean; device?: boolean; pane?: boolean; trigger?: boolean }
): Promise<Record<string, unknown>> {
  const extra = await resolveJsonBody(flagString(flags, 'body'));
  const merged = mergeBody(applyWatchFlags(flags), extra);
  requireWatchFields(merged, required);
  return merged;
}

export { parseOnOff };
