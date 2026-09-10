import type { IceServerConfig } from './native';
import type { IceTypeCounts } from './rtc-log';

export type RtcFailureStage = 'gathering' | 'no-remote-sdp' | 'checking' | 'dtls' | 'handshake';

export type RtcDialProgress = {
  gatheringComplete: boolean;
  remoteDescriptionApplied: boolean;
  selectedPair: boolean;
  channelOpen: boolean;
  handshakeStarted: boolean;
};

export function createRtcDialProgress(): RtcDialProgress {
  return {
    gatheringComplete: false,
    remoteDescriptionApplied: false,
    selectedPair: false,
    channelOpen: false,
    handshakeStarted: false,
  };
}

export function rtcFailureStage(progress: RtcDialProgress): RtcFailureStage {
  if (progress.handshakeStarted || progress.channelOpen) return 'handshake';
  if (progress.selectedPair) return 'dtls';
  if (progress.remoteDescriptionApplied) return 'checking';
  if (progress.gatheringComplete) return 'no-remote-sdp';
  return 'gathering';
}

export function rtcGatherFailureHint(
  progress: RtcDialProgress,
  ice: IceServerConfig,
  localCounts: Pick<IceTypeCounts, 'srflx' | 'relay'>
): 'stun unconfigured' | 'no srflx candidates' | null {
  if (progress.channelOpen || progress.selectedPair) return null;
  if (ice.stun.length === 0) return 'stun unconfigured';
  if (progress.gatheringComplete && localCounts.srflx === 0 && localCounts.relay === 0) {
    return 'no srflx candidates';
  }
  return null;
}

export function isRtcTimeoutFailure(reason: string): boolean {
  return /timeout|timed out/i.test(reason);
}

export function isSupersededDcLoss(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)) === 'superseded';
}
