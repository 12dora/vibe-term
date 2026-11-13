import type { LinkSession } from '@vibeterm/shared/link';
import type { RelayCtlMessage, RelayKickReason } from '@vibeterm/shared/relay';
import type { RelayLiveNode } from './relay-registry';

/** ctl 发送是异步排空的，立刻 close 会把 `relay.kicked` 丢掉，所以下一个宏任务再断。 */
export function kickRelayLink(
  live: RelayLiveNode,
  reason: RelayKickReason,
  send: (link: LinkSession, msg: RelayCtlMessage) => void,
  closeTimers: Set<ReturnType<typeof setTimeout>>
): void {
  send(live.link, { t: 'relay.kicked', reason });
  const link = live.link;
  const timer = setTimeout(() => {
    closeTimers.delete(timer);
    link.close(`relay-${reason}`);
  }, 0);
  closeTimers.add(timer);
}
