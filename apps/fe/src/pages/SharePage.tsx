// 被分享人页（`/s/:shareId`、`/n/:nodeId/s/:shareId`）。挂在 RootLayout 之外：没有侧栏、
// 没有 mesh 轮询、没有设备列表，整页只有「密码 → 终端 → 已结束」三态。

import { useAppMonoFont } from '@/lib/fonts/useAppMonoFont';
import { ShareConsole } from '@/share/share-console';
import { ShareEndedNotice } from '@/share/share-ended';
import { SHARE_KEYBOARD_AVOIDANCE_DISABLED, useShareKeyboardStyle } from '@/share/share-keyboard';
import {
  EMPTY_SHARE_LINK_PREFILL,
  type ShareLinkPrefill,
  advanceShareLinkPrefill,
  consumeShareLinkFragment,
} from '@/share/share-link-password';
import { SharePasswordForm } from '@/share/share-password-form';
import { useShareSession } from '@/share/use-share-session';
import { parseNodeIdFromPath } from '@tmex/api-client';
import { SidebarInset } from '@tmex/ui/sidebar';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams } from 'react-router';

/**
 * 「链接中包含密码」发来的链接：每来一次 `#p=` 就读走一次，随即把 fragment 抹掉。
 *
 * 留着的话密码会一直挂在地址栏、被分享人的浏览历史与他转手贴出去的任何截图里；
 * 抹掉之后本次会话已经拿到了预填值，刷新则退回手工输入，这正是想要的。
 *
 * 只在挂载时读一次不够：同文档内换到另一条带密码的链接（或换一条分享）时，组件不会重挂，
 * 结果是旧预填还留着、新密码还挂在地址栏上。因此按 location 变化重跑，并用 `seq` 让表单重挂。
 */
function useLinkPassword(): ShareLinkPrefill {
  const { pathname, search, hash, key } = useLocation();
  const [prefill, setPrefill] = useState<ShareLinkPrefill>(EMPTY_SHARE_LINK_PREFILL);
  // 抹地址栏走的是 replaceState，router 里的 hash 并不跟着变：再点一次同一条带密码的链接时
  // pathname/search/hash 全都相等，只有 location.key 能说明这是新的一次导航。
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 是「又导航了一次」的显式触发器
  useEffect(() => {
    // 抹地址栏时保留 history.state：react-router 的滚动恢复等都挂在上面。
    const password = consumeShareLinkFragment({ pathname, search, hash }, window.history);
    setPrefill((prev) => advanceShareLinkPrefill(prev, password));
  }, [pathname, search, hash, key]);
  return prefill;
}

export default function SharePage() {
  const { t } = useTranslation();
  const { shareId = '' } = useParams();
  const location = useLocation();
  const nodeId = parseNodeIdFromPath(location.pathname);
  const prefill = useLinkPassword();
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
          key={`${shareId}:${prefill.seq}`}
          name={name}
          error={state.error}
          lockedUntil={state.lockedUntil}
          submitting={state.submitting}
          initialPassword={prefill.password}
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
