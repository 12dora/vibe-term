// 直连信令的扇出：`/mesh/ws` 上的 `RTC_SIGNAL` 按 `rtcSession` 分给各 node 的直连控制器。

import type { DirectSignalMessage, DirectSignalingTransport } from '@vibeterm/ws-client/direct';
import type { MeshEventSource } from './mesh-events';

/**
 * `/mesh/ws` 的 `RTC_SIGNAL` 只有**一个** handler 槽（见 `mesh-events.ts` 的注释），
 * 而每个非 self 的 node 各有一个控制器，所以这里做一层扇出：信令按 `rtcSession` 由
 * 各控制器自行过滤，扇出不会让某个控制器抢答别人的 answer。
 *
 * `send` 如实返回 `sendRtcSignal` 的结果，并透出 `isReady` / `onReady`：`/mesh/ws` 未连上时
 * 控制器把 offer 排进 outbox，不把 attempt 判失败；连上后泵出信令。
 */
export class MeshRtcSignalFanout {
  private readonly handlers = new Set<(signal: DirectSignalMessage) => void>();
  private bound: MeshEventSource | null = null;

  constructor(private readonly resolveSource: () => MeshEventSource) {}

  transport(): DirectSignalingTransport {
    return {
      send: (signal) => this.source().sendRtcSignal(signal),
      onSignal: (cb) => {
        this.handlers.add(cb);
        this.bind();
        return () => {
          this.handlers.delete(cb);
        };
      },
      isReady: () => this.resolveSource().connected,
      onReady: (cb) => {
        const source = this.source();
        return source.onStatusChange(() => cb(source.connected));
      },
    };
  }

  private source(): MeshEventSource {
    const source = this.resolveSource();
    source.start();
    return source;
  }

  private bind(): void {
    const source = this.source();
    if (this.bound === source) return;
    this.bound = source;
    source.setRtcSignalHandler((signal) => {
      for (const handler of [...this.handlers]) handler(signal);
    });
  }
}
