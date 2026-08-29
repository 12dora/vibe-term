// Watch 规则纯函数求值器（match / unchanged 两型；llm 型由 service 编排）。
// 不做任何 IO：输入屏幕文本 + 规则 + 持久化状态 + 当前时间，输出命中判定与状态增量。

import type { WatchRuleRecord, WatchRuleStateRecord } from '../db/watch';
import { evaluateMatchTrigger, evaluateUnchangedTrigger } from './evaluator-triggers';

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

function tryCompilePattern(pattern: string, flags: string | null): RegExp | WatchEvalOutput {
  try {
    return compileWatchPattern(pattern, flags ?? '');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { hit: false, stateUpdates: {}, error: `invalid pattern: ${detail}` };
  }
}

function isCompileError(value: RegExp | WatchEvalOutput): value is WatchEvalOutput {
  return !(value instanceof RegExp);
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

  if (!rule.pattern) {
    return { hit: false, stateUpdates: {}, error: 'pattern is empty' };
  }

  const compiled = tryCompilePattern(rule.pattern, rule.patternFlags);
  if (isCompileError(compiled)) {
    return compiled;
  }

  const match = findLastMatch(screen, compiled);
  if (rule.triggerType === 'match') {
    return evaluateMatchTrigger(rule, state, now, match);
  }
  return evaluateUnchangedTrigger(rule, state, now, match);
}
