import type { StateSnapshotPayload, wsBorsh } from '@tmex/shared';
import type { GatewaySession } from './gateway-session';
import { shareVisibleClients } from './share-gate';
import { getShareWsService } from './share-hooks';
import { filterCanonicalEventForShare } from './share-metadata-filter';
import { type SharePaneOracle, type ShareScope, isPaneInShareScope } from './share-scope';

export interface ShareSessionIndexHost {
  getLastSnapshot(deviceId: string): StateSnapshotPayload | null;
  closeSession(session: GatewaySession, code: number, reason: string): void;
}

export const SHARE_ENDED_CLOSE_CODE = 4410;
export const SHARE_ENDED_CLOSE_REASON = 'SHARE_ENDED';

/**
 * 分享连接不进常规 SessionRegistry：按 shareId 单独索引，承担「终止/到期即断开」、
 * 在线人数、以及 scope 判定（pane 归属、出站事件过滤）。
 */
export class ShareSessionIndex {
  private readonly sessions = new Map<string, Set<GatewaySession>>();
  private host: ShareSessionIndexHost | null = null;
  private wired = false;

  bind(host: ShareSessionIndexHost): void {
    this.host = host;
  }

  add(session: GatewaySession, scope: ShareScope): void {
    session.shareScope = scope;
    const existing = this.sessions.get(scope.shareId);
    if (existing) existing.add(session);
    else this.sessions.set(scope.shareId, new Set([session]));
    this.wire();
  }

  remove(session: GatewaySession): void {
    const scope = session.shareScope;
    if (!scope) return;
    const existing = this.sessions.get(scope.shareId);
    if (!existing) return;
    existing.delete(session);
    if (existing.size === 0) this.sessions.delete(scope.shareId);
  }

  count(shareId: string): number {
    return this.sessions.get(shareId)?.size ?? 0;
  }

  closeAll(
    shareId: string,
    code = SHARE_ENDED_CLOSE_CODE,
    reason = SHARE_ENDED_CLOSE_REASON
  ): number {
    const existing = this.sessions.get(shareId);
    if (!existing) return 0;
    this.sessions.delete(shareId);
    const targets = Array.from(existing);
    for (const session of targets) this.host?.closeSession(session, code, reason);
    return targets.length;
  }

  /** pane 归属以设备最新快照为准；快照未就绪一律判越权（fail-closed）。 */
  paneInScope(scope: ShareScope, deviceId: string, paneId: string): boolean {
    return isPaneInShareScope(
      this.host?.getLastSnapshot(scope.deviceId) ?? null,
      scope,
      deviceId,
      paneId
    );
  }

  paneVisibleTo(session: GatewaySession, deviceId: string, paneId: string): boolean {
    const scope = session.shareScope;
    return scope ? this.paneInScope(scope, deviceId, paneId) : true;
  }

  paneOracle(session: GatewaySession): SharePaneOracle {
    return (deviceId, paneId) => this.paneVisibleTo(session, deviceId, paneId);
  }

  visibleClients(
    clients: Iterable<GatewaySession>,
    deviceId: string,
    paneId: string | null
  ): Iterable<GatewaySession> {
    return shareVisibleClients(clients, deviceId, paneId, (scope, device, pane) =>
      this.paneInScope(scope, device, pane)
    );
  }

  filterEvent(
    session: GatewaySession,
    event: wsBorsh.CanonicalEvent
  ): wsBorsh.CanonicalEvent | null {
    const scope = session.shareScope;
    if (!scope) return event;
    return filterCanonicalEventForShare(event, scope, this.paneOracle(session));
  }

  /** 分享服务的装配晚于 ws 层，因此推迟到第一条分享连接接入时再挂钩（未就绪则下次重试）。 */
  private wire(): void {
    if (this.wired) return;
    const service = getShareWsService();
    if (!service) return;
    this.wired = true;
    service.onEnded((shareId) => {
      this.closeAll(shareId);
    });
    service.setViewerCounter((shareId) => this.count(shareId));
  }
}
