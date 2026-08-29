import type { TmuxWindow } from '@tmex/shared';

import type { TmuxConnectionOptions } from '../connection-types';
import type { ControlModeCommandQueue } from '../control-mode-capture';
import type { CommandResult } from './types';

export interface SessionCommandHost {
  deviceId: string;
  sessionName: string;
  connected: boolean;
  manualDisconnect: boolean;
  logPrefix: string;
  activeWindowId: string | null;
  activePaneId: string | null;
  snapshotWindows: Map<string, TmuxWindow>;
  callbacks: TmuxConnectionOptions;
  controlCommands: ControlModeCommandQueue;
  resolveDefaultWorkingDir(): string;
  shouldInstallGhosttyTerminfo(): Promise<boolean>;
  configureWindowStyle(styleValue?: string): Promise<void>;
  getParkingCommand(): string;
  runTmuxAllowFailure(argv: string[], timeoutMs?: number): Promise<CommandResult>;
  requestSnapshotInternal(): Promise<void>;
  requestSnapshot(): void;
  reportTmuxCommandFailure(message: string): void;
  onTmuxServerGone(message: string): void;
  notifySessionClosed(message: string): void;
  shutdownInternal(notifyClose: boolean): Promise<void>;
  getControlWriter(): ((data: string) => void) | null;
  getControlCommandTimeoutMs(): number;
  runHistoryQuery(argv: string[]): Promise<CommandResult>;
  runHistoryCapture(argv: string[], maxOutputBytes: number): Promise<string>;
}
