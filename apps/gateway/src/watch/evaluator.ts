// Watch 规则纯函数求值器（match / unchanged 两型；llm 型由 service 编排）。
// 不做任何 IO：输入屏幕文本 + 规则 + 持久化状态 + 当前时间，输出命中判定与状态增量。

import { errorMessage } from '@tmex/shared';
import type { WatchRuleRecord, WatchRuleStateRecord } from '../db/watch';
import { evaluateMatchRule } from './evaluator-match';
import { evaluateUnchangedRule } from './evaluator-unchanged';

export interface WatchEvalInput {
  screen: string;
  rule: WatchRuleRecord;
  state: WatchRuleStateRecord | null;
  now: Date;
}

/** 求值产生的持久化状态增量（lastTriggeredAt/triggeredSinceChange 的触发侧更新由 service 在真正触发后写入） */
export interface WatchEvalStateUpdates {
  lastValue?: string | null;
  lastValueChangedAt?: string | null;
  triggeredSinceChange?: boolean;
}

export interface WatchEvalOutput {
  /** 命中且通过触发闸门（once 防重 / repeat cooldown） */
  hit: boolean;
  matchedText?: string;
  /** unchanged 型的提取值 */
  value?: string;
  /** unchanged 型命中时的卡住分钟数 */
  stuckMinutes?: number;
  stateUpdates: WatchEvalStateUpdates;
  /** 规则错误（pattern 编译失败等），不是命中 */
  error?: string;
}

/** flags 追加 g 并去重；非法 flags 由 RegExp 构造器抛错 */
export function compileWatchPattern(pattern: string, flags: string): RegExp {
  const dedupedFlags = Array.from(new Set(`${flags}g`)).join('');
  return new RegExp(pattern, dedupedFlags);
}

/** 取屏幕上最后一个命中（进度行通常在底部）；零宽匹配时推进 lastIndex 防死循环 */
export function findLastMatch(screen: string, regex: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  regex.lastIndex = 0;
  let match = regex.exec(screen);
  while (match !== null) {
    last = match;
    if (match.index === regex.lastIndex) {
      regex.lastIndex += 1;
    }
    match = regex.exec(screen);
  }
  return last;
}

/** once：unchanged 用 triggeredSinceChange 防重（match 型触发后由 service 置 enabled=false）；repeat：cooldown */
function passesTriggerGate(
  rule: WatchRuleRecord,
  state: WatchRuleStateRecord | null,
  now: Date
): boolean {
  if (rule.fireMode === 'once') {
    if (rule.triggerType === 'unchanged') {
      return !state?.triggeredSinceChange;
    }
    return true;
  }

  const lastTriggeredAtMs = state?.lastTriggeredAt ? Date.parse(state.lastTriggeredAt) : Number.NaN;
  if (!Number.isNaN(lastTriggeredAtMs)) {
    const cooldownMs = Math.max(0, rule.cooldownSeconds) * 1000;
    if (now.getTime() - lastTriggeredAtMs < cooldownMs) {
      return false;
    }
  }
  return true;
}

interface CachedRuleRegex {
  pattern: string;
  flags: string;
  regex: RegExp;
}

const ruleRegexCache = new Map<string, CachedRuleRegex>();

function compileCachedRuleRegex(
  rule: WatchRuleRecord
): { ok: true; regex: RegExp } | { ok: false; error: string } {
  const pattern = rule.pattern;
  if (!pattern) {
    return { ok: false, error: 'pattern is empty' };
  }

  const flags = rule.patternFlags ?? '';
  const cached = ruleRegexCache.get(rule.id);
  if (cached && cached.pattern === pattern && cached.flags === flags) {
    return { ok: true, regex: cached.regex };
  }

  try {
    const regex = compileWatchPattern(pattern, flags);
    ruleRegexCache.set(rule.id, { pattern, flags, regex });
    return { ok: true, regex };
  } catch (error) {
    const detail = errorMessage(error);
    return { ok: false, error: `invalid pattern: ${detail}` };
  }
}

export function evaluateWatchRule(input: WatchEvalInput): WatchEvalOutput {
  const { screen, rule, state, now } = input;

  if (rule.triggerType === 'llm') {
    return {
      hit: false,
      stateUpdates: {},
      error: 'llm rules are not handled by the regex evaluator',
    };
  }

  const compiled = compileCachedRuleRegex(rule);
  if (!compiled.ok) {
    return { hit: false, stateUpdates: {}, error: compiled.error };
  }

  const match = findLastMatch(screen, compiled.regex);
  const canTrigger = passesTriggerGate(rule, state, now);

  if (rule.triggerType === 'match') {
    return evaluateMatchRule(match, canTrigger);
  }

  return evaluateUnchangedRule({ match, rule, state, now, canTrigger });
}
