import type { WatchEvalOutput } from './evaluator';

/** match 型：无命中 miss；有命中则把触发闸门结果映射为 hit。 */
export function evaluateMatchRule(
  match: RegExpExecArray | null,
  canTrigger: boolean
): WatchEvalOutput {
  if (!match) {
    return { hit: false, stateUpdates: {} };
  }
  return {
    hit: canTrigger,
    matchedText: match[0],
    stateUpdates: {},
  };
}
