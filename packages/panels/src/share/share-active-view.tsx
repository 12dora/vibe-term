// 进行中的分享：链接 / 密码 / 在线人数 / 有效期 + 终止。
// 密码只有刚创建那一次拿得到明文（接口只返回一次），已有分享一律遮罩。

import { formatDateTime } from '@tmex/shared';
import type { ShareRecord } from '@tmex/shared/share';
import { useSiteStore } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ShareCopyField } from './share-copy-field';
import { shareRemaining, shareRemainingKey } from './share-dialog-model';

const MASKED_PASSWORD = '••••••••';

export interface ShareActiveViewProps {
  share: ShareRecord;
  /** 刚创建时的明文密码；已有分享为 null。 */
  password: string | null;
  stopping: boolean;
  onStop: () => void;
  now?: number;
}

function ShareExpiryLine({ share, now }: { share: ShareRecord; now: number }) {
  const { t } = useTranslation();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  const remaining = shareRemaining(share.expiresAt, now);

  if (!remaining) {
    return <span data-testid="share-expires">{t('share.dialog.permanent')}</span>;
  }

  return (
    <span data-testid="share-expires">
      {t(shareRemainingKey(remaining), { value: remaining.value })}
      <span className="ml-2 text-muted-foreground" title={t('share.dialog.expires')}>
        {formatDateTime(share.expiresAt, language)}
      </span>
    </span>
  );
}

export function ShareActiveView({
  share,
  password,
  stopping,
  onStop,
  now = Date.now(),
}: ShareActiveViewProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4" data-testid="share-active-view">
      <ShareCopyField
        label={t('share.dialog.link')}
        value={share.url}
        copyLabel={t('share.dialog.copy')}
        testId="share-link"
      />

      <div className="space-y-2">
        <ShareCopyField
          label={t('share.dialog.password')}
          value={password ?? ''}
          display={password ?? MASKED_PASSWORD}
          copyLabel={t('share.dialog.copy')}
          testId="share-active-password"
          disabled={password === null}
        />
        {password === null && (
          <p className="text-xs text-muted-foreground">{t('share.dialog.passwordOnce')}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span data-testid="share-viewers">
          {t('share.dialog.viewers', { count: share.viewers })}
        </span>
        <ShareExpiryLine share={share} now={now} />
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="destructive"
          disabled={stopping}
          onClick={onStop}
          data-testid="share-stop"
        >
          {stopping && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('share.dialog.stop')}
        </Button>
      </div>
    </div>
  );
}
