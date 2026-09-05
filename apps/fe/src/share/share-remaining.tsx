// 头部的剩余期限：永久分享显示「永久」，其余按量级倒数（不足 1 小时才每秒刷新）。

import { useTranslation } from 'react-i18next';
import { shareCountdownIntervalMs, shareRemainingLabel, shareRemainingMs } from './share-format';
import { useShareNow } from './use-share-now';

export function ShareRemaining({ expiresAt }: { expiresAt: number | null }) {
  const { t } = useTranslation();
  const tickMs = shareCountdownIntervalMs(shareRemainingMs(expiresAt, Date.now()));
  const now = useShareNow(expiresAt !== null, tickMs);
  const remaining = shareRemainingMs(expiresAt, now);

  const text = (): string => {
    if (remaining === null) return t('shareAccess.permanent');
    if (remaining <= 0) return t('shareAccess.expired');
    const label = shareRemainingLabel(remaining);
    return `${t('shareAccess.expiresIn')} ${t(label.key, label.params)}`;
  };

  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground" data-testid="share-remaining">
      {text()}
    </span>
  );
}
