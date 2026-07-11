// watch 触发通知的文案组装（纯函数，i18n 经 t 注入）

import type { TranslateFn } from './notification-format';

const WATCH_DESCRIPTION_MAX = 200;

export function formatWatchTriggeredNotification(
  ruleName: string | null,
  payload: { summary?: string; matchedText?: string },
  t: TranslateFn
): { title: string; description: string } {
  const title = ruleName ?? t('watch.toast.triggeredTitle');
  const rawDescription = payload.summary || payload.matchedText || '';
  const description =
    rawDescription.length > WATCH_DESCRIPTION_MAX
      ? `${rawDescription.slice(0, WATCH_DESCRIPTION_MAX)}…`
      : rawDescription;
  return { title, description };
}
