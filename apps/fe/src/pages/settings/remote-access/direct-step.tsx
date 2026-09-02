// 「直接连接」路径的唯一一步：访问保护。
//
// 这条路径不建任何隧道、不改隧道配置——用户自己用固定 IP / 端口映射 / 反向代理把 tmex 暴露出去，
// tmex 能做的只有两件事：说清当前有没有登录门，以及在没有时把门装上。

import type { LocalAuthStatus, TunnelStatusResponse } from '@tmex/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SetupNotice } from '../nodes/setup/form-parts';
import { directProtection } from './direct-model';
import { EnableLocalAuth, LoginProtectionNotice } from './login-protection';
import { DetailRow } from './step-shell';

export function DirectStep({
  status,
  localAuth,
  onLocalAuth,
}: {
  status: TunnelStatusResponse;
  localAuth: LocalAuthStatus | null;
  /** 动作回来的最新状态就地覆盖本地快照，不必再拉一次 `/api/auth/mode`。 */
  onLocalAuth: (next: LocalAuthStatus) => void;
}) {
  const { t } = useTranslation();
  const protection = directProtection(localAuth);

  return (
    <div className="space-y-3" data-testid="remote-access-direct" data-protection={protection}>
      <LoginProtectionNotice localAuth={localAuth} />

      <EntryHint status={status} />

      {protection === 'unprotected' && (
        <EnableLocalAuth localAuth={localAuth} onLocalAuth={onLocalAuth} />
      )}

      <SetupNotice tone="info" testId="remote-access-direct-tls">
        <p>{t('settings.remoteAccess.direct.tls.hint')}</p>
        <Link className="text-primary underline-offset-4 hover:underline" to="?tab=nodes">
          {t('settings.remoteAccess.direct.tls.link')}
        </Link>
      </SetupNotice>

      <p className="text-xs text-muted-foreground" data-testid="remote-access-direct-caveat">
        {t('settings.remoteAccess.direct.caveat')}
      </p>
    </div>
  );
}

/** 入口地址只能给参考值：真正的对外地址由用户自己的映射 / 反向代理决定，tmex 看不到。 */
function EntryHint({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  const origin = typeof window === 'undefined' ? null : window.location.origin;

  return (
    <div className="space-y-1" data-testid="remote-access-direct-entry">
      <DetailRow
        label={t('settings.remoteAccess.direct.entryLabel')}
        testId="remote-access-direct-entry-url"
      >
        <span className="font-mono">{origin ?? '—'}</span>
      </DetailRow>
      <p className="text-xs text-muted-foreground">
        {t('settings.remoteAccess.direct.entryHint', { port: status.config.originPort })}
      </p>
    </div>
  );
}
