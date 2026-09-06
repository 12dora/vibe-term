// 进行中的分享：链接 / 密码 / 在线人数 / 有效期 + 终止。
// 密码只有刚创建那一次自动拿得到；已有分享遮罩显示，勾「链接中包含密码」时才按需取回。

import { formatDateTime } from '@vibeterm/shared';
import type { ShareRecord } from '@vibeterm/shared/share';
import { useSiteStore } from '@vibeterm/stores/react';
import { Button } from '@vibeterm/ui/button';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { Loader2 } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ShareCopyField } from './share-copy-field';
import {
  type ShareLinkPassword,
  shareLinkValue,
  shareRemaining,
  shareRemainingKey,
} from './share-dialog-model';

const MASKED_PASSWORD = '••••••••';

export interface ShareActiveViewProps {
  share: ShareRecord;
  /** 刚创建时的明文密码；已有分享为 null。 */
  password: string | null;
  linkPassword: ShareLinkPassword;
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

/** 勾上即把密码拼进链接的 fragment：省掉被分享人手工粘贴，代价是链接本身等同密码。 */
function IncludePasswordField({ link }: { link: ShareLinkPassword }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm" htmlFor={id}>
        <Checkbox
          id={id}
          checked={link.include}
          disabled={link.loading}
          onCheckedChange={(next) => link.setInclude(next === true)}
          data-testid="share-include-password"
        />
        {t('share.dialog.includePassword')}
        {link.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </label>
      <p className="text-xs text-muted-foreground">{t('share.dialog.includePasswordHint')}</p>
      {link.error && (
        <p className="text-xs text-destructive" data-testid="share-include-password-error">
          {t(link.error)}
        </p>
      )}
    </div>
  );
}

export function ShareActiveView({
  share,
  password,
  linkPassword,
  stopping,
  onStop,
  now = Date.now(),
}: ShareActiveViewProps) {
  const { t } = useTranslation();
  // 勾选后取回的明文同样摆进密码栏：链接里已经明文可见，再遮罩只会自相矛盾。
  const plain = password ?? linkPassword.password;
  const link = shareLinkValue(share.url, linkPassword);

  return (
    <div className="space-y-4" data-testid="share-active-view">
      <div className="space-y-2">
        <ShareCopyField
          label={t('share.dialog.link')}
          value={link}
          copyLabel={t('share.dialog.copy')}
          testId="share-link"
        />
        <IncludePasswordField link={linkPassword} />
      </div>

      <div className="space-y-2">
        <ShareCopyField
          label={t('share.dialog.password')}
          value={plain ?? ''}
          display={plain ?? MASKED_PASSWORD}
          copyLabel={t('share.dialog.copy')}
          testId="share-active-password"
          disabled={plain === null}
        />
        {plain === null && (
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
