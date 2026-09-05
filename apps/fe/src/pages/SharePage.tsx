// 被分享人页（`/s/:shareId`、`/n/:nodeId/s/:shareId`）。挂在 RootLayout 之外：没有侧栏、
// 没有 mesh 轮询、没有设备列表，整页只有「密码 → 终端 → 已结束」三态。

import { useAppMonoFont } from '@/lib/fonts/useAppMonoFont';
import { ShareConsole } from '@/share/share-console';
import { ShareEndedNotice } from '@/share/share-ended';
import { SHARE_KEYBOARD_AVOIDANCE_DISABLED, useShareKeyboardStyle } from '@/share/share-keyboard';
import { SharePasswordForm } from '@/share/share-password-form';
import { useShareSession } from '@/share/use-share-session';
import { parseNodeIdFromPath } from '@tmex/api-client';
import { SidebarInset } from '@tmex/ui/sidebar';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams } from 'react-router';

export default function SharePage() {
  const { t } = useTranslation();
  const { shareId = '' } = useParams();
  const nodeId = parseNodeIdFromPath(useLocation().pathname);
  useAppMonoFont();

  const session = useShareSession({ nodeId, shareId });
  const { state } = session;
  const name = state.name || t('shareAccess.defaultName');
  const style = useShareKeyboardStyle(SHARE_KEYBOARD_AVOIDANCE_DISABLED);

  return (
    <SidebarInset className="h-dvh overflow-hidden" style={style} data-testid="share-page">
      {state.status === 'terminal' && session.handle && state.deviceId && state.windowId ? (
        <ShareConsole
          handle={session.handle}
          name={name}
          expiresAt={state.expiresAt}
          deviceId={state.deviceId}
          windowId={state.windowId}
          onDisconnect={session.disconnect}
        />
      ) : state.status === 'password' ? (
        <SharePasswordForm
          name={name}
          error={state.error}
          lockedUntil={state.lockedUntil}
          submitting={state.submitting}
          onSubmit={session.submitPassword}
        />
      ) : state.status === 'ended' ? (
        <ShareEndedNotice reason={state.endedReason ?? 'ended'} />
      ) : (
        <div
          className="flex min-h-full items-center justify-center p-8 text-muted-foreground"
          aria-label={t('shareAccess.loading')}
          data-testid="share-loading"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        </div>
      )}
    </SidebarInset>
  );
}
