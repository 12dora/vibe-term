import {
  type KeywordRule,
  classifyByKeywords,
  truncateReason,
} from '../../../../packages/shared/src/net/classify-by-keywords';

const DIRECT_DIAL_FAILURE_RULES: ReadonlyArray<KeywordRule<string | null>> = [
  [['signaling not ready'], null],
  [['no_connection', 'multiple_connections'], null],
  [['connection lookup'], 'lookup'],
  [['authoriz'], 'authorization'],
  [['fingerprint'], 'fingerprint'],
  [['timeout', 'timed out'], 'timeout'],
  [['ice'], 'ice'],
  [['protocol'], 'protocol'],
  [['carrier', 'switched back'], 'carrier'],
  [['channel', 'datachannel'], 'channel'],
];

/** 拨号失败原因 → 熔断记账种类；`null` 表示不计入熔断。 */
export function classifyDirectDialFailure(reason: string | null | undefined): string | null {
  if (!reason) return 'unknown';
  return classifyByKeywords<string | null>(reason, DIRECT_DIAL_FAILURE_RULES, () =>
    truncateReason(reason)
  );
}
