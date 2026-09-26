import type { LinkSession } from '@vibeterm/shared/link';
import type { RtcSignalMessage } from './mesh-deps';
import type { DcUpgradeCoordinator, DcUpgradeLivePeer, UpgradeGate } from './peer-dc-upgrade';
import type { IncomingWakeGate, RtcWakeGate, WakeGate } from './peer-rtc-wake';
import type { RtcSignaling, RtcWakeFields } from './rtc/ice';

/** PeerManager 上那些只是转发给 coordinator / wake gate 的方法。 */
export abstract class PeerCollaboratorHost {
  protected abstract readonly dcUpgrade: DcUpgradeCoordinator;
  protected abstract readonly rtcWake: RtcWakeGate;

  protected wantsUpgrade(live: DcUpgradeLivePeer): boolean {
    return this.dcUpgrade.wantsUpgrade(live);
  }
  protected ensureGate(nodeId: string): UpgradeGate {
    return this.dcUpgrade.ensureGate(nodeId);
  }
  protected noteUpgradeResult(nodeId: string, ok: boolean): void {
    this.dcUpgrade.noteUpgradeResult(nodeId, ok);
  }
  protected scheduleCoalescedUpgrade(nodeId: string): void {
    this.dcUpgrade.scheduleCoalescedUpgrade(nodeId);
  }
  protected acquireUpgradeSlot(): Promise<void> {
    return this.dcUpgrade.acquireUpgradeSlot();
  }
  protected releaseUpgradeSlot(): void {
    this.dcUpgrade.releaseUpgradeSlot();
  }
  protected queueUpgrade(nodeId: string): void {
    this.dcUpgrade.queueUpgrade(nodeId);
  }
  protected runUpgradeDial(nodeId: string, before: LinkSession | null): Promise<LinkSession> {
    return this.dcUpgrade.runUpgradeDial(nodeId, before);
  }
  protected maybeUpgrade(nodeId: string, opts: { cooldown: boolean; userPath?: boolean }): void {
    this.dcUpgrade.maybeUpgrade(nodeId, opts);
  }
  protected handleIncomingRtcWake(fromNodeId: string, msg: RtcSignalMessage): void {
    this.rtcWake.handleIncomingRtcWake(fromNodeId, msg);
  }
  protected ensureIncomingWakeGate(fromNodeId: string): IncomingWakeGate {
    return this.rtcWake.ensureIncomingWakeGate(fromNodeId);
  }
  protected cancelDcUpgradeRetry(nodeId: string): void {
    this.dcUpgrade.cancelDcUpgradeRetry(nodeId);
  }
  protected nextDcAttemptId(): string {
    return this.dcUpgrade.nextDcAttemptId();
  }
  protected cancelDcHealthTimer(nodeId: string): void {
    this.dcUpgrade.cancelDcHealthTimer(nodeId);
  }
  protected armDcHealthTimer(nodeId: string, attemptId: string): void {
    this.dcUpgrade.armDcHealthTimer(nodeId, attemptId);
  }
  protected armDcUpgradeRetry(nodeId: string): void {
    this.dcUpgrade.armDcUpgradeRetry(nodeId);
  }
  protected releaseRtcWakeAttempt(peerNodeId: string): void {
    this.rtcWake.releaseRtcWakeAttempt(peerNodeId);
  }
  protected dispatchRtcWake(peerNodeId: string, opts?: { gated?: boolean }): void {
    this.rtcWake.dispatchRtcWake(peerNodeId, opts);
  }
  protected signalingFor(peerNodeId: string): RtcSignaling {
    return this.rtcWake.signalingFor(peerNodeId);
  }
  protected sendRtcSignal(peerNodeId: string, msg: RtcSignalMessage): void {
    this.rtcWake.sendRtcSignal(peerNodeId, msg);
  }
  protected acceptSignedRtcWake(
    fromNodeId: string,
    msg: RtcSignalMessage,
    wake: RtcWakeFields
  ): boolean {
    return this.rtcWake.acceptSignedRtcWake(fromNodeId, msg, wake);
  }
  protected rememberRtcWakeNonce(fromNodeId: string, nonce: string, issuedAt: number): boolean {
    return this.rtcWake.rememberRtcWakeNonce(fromNodeId, nonce, issuedAt);
  }
  protected pruneRtcWakeNonces(peer: Map<string, number>): void {
    this.rtcWake.pruneRtcWakeNonces(peer);
  }
  protected consumeWakeVerifyToken(gate: IncomingWakeGate, now: number): boolean {
    return this.rtcWake.consumeWakeVerifyToken(gate, now);
  }
  protected dcUpgradeRetryDelayMs(attempt: number): number {
    return this.dcUpgrade.dcUpgradeRetryDelayMs(attempt);
  }
  protected ensureWakeGate(peerNodeId: string): WakeGate {
    return this.rtcWake.ensureWakeGate(peerNodeId);
  }
  protected abortDeferredRtcWakes(): void {
    this.rtcWake.abortDeferredRtcWakes();
  }
  protected disarmDeferredRtcWake(gate: WakeGate): void {
    this.rtcWake.disarmDeferredRtcWake(gate);
  }
  protected armDeferredRtcWake(peerNodeId: string, gate: WakeGate): void {
    this.rtcWake.armDeferredRtcWake(peerNodeId, gate);
  }
}
