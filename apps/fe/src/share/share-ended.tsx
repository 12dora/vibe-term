// 分享结束 / 不存在 / 不可用：一屏一行，不给任何跳转出口（访客没有本站的其它权限）。

import { Link2Off } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ShareEndedReason } from './share-state';

const REASON_KEYS: Record<ShareEndedReason, string> = {
  ended: 'shareAccess.ended',
  notFound: 'shareAccess.notFound',
  unavailable: 'shareAccess.unavailable',
};

export function ShareEndedNotice({ reason }: { reason: ShareEndedReason }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="share-ended"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Link2Off className="size-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">{t(REASON_KEYS[reason])}</p>
    </div>
  );
}
