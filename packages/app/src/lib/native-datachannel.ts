import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { sha256Hex } from './artifacts-manifest';
import { pathExists, readText } from './fs-utils';

const ADDON_FILENAME = 'node_datachannel.node';

const requireNative = createRequire(import.meta.url);

export interface InstalledNativeManifest {
  platform: string;
  version: string;
  sha256: string;
  napiVersion: number;
}

export interface NodeDatachannelDataChannel {
  close(): void;
  sendMessage(msg: string): boolean;
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean;
  isOpen(): boolean;
  bufferedAmount(): number;
  maxMessageSize(): number;
  setBufferedAmountLowThreshold(bytes: number): void;
  onBufferedAmountLow(cb: () => void): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}

export interface NodeDatachannelPeerConnection {
  close(): void;
  setRemoteDescription(sdp: string, type: string): void;
  localDescription(): { type: string; sdp: string } | null;
  remoteFingerprint(): { value: string; algorithm: string };
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, config?: unknown): NodeDatachannelDataChannel;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onDataChannel(cb: (dc: NodeDatachannelDataChannel) => void): void;
  maxMessageSize(): number;
}

export interface NodeDatachannelModule {
  PeerConnection: new (
    peerName: string,
    config: { iceServers: unknown[] }
  ) => NodeDatachannelPeerConnection;
  cleanup(): void;
  preload(): void;
  initLogger(level: string, cb?: (level: string, message: string) => void): void;
  getLibraryVersion(): string;
}

export interface LoadNodeDatachannelOptions {
  nativeDir: string;
  log?: (message: string) => void;
}

export function nativeAddonPath(nativeDir: string): string {
  return join(nativeDir, ADDON_FILENAME);
}

export function nativeManifestPath(nativeDir: string): string {
  return join(nativeDir, 'manifest.json');
}

function defaultLog(message: string): void {
  console.warn(`[tmex][native-datachannel] ${message}`);
}

export async function readInstalledNativeManifest(
  nativeDir: string
): Promise<InstalledNativeManifest | null> {
  const path = nativeManifestPath(nativeDir);
  if (!(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readText(path)) as Partial<InstalledNativeManifest>;
    if (
      typeof parsed.platform !== 'string' ||
      typeof parsed.version !== 'string' ||
      typeof parsed.sha256 !== 'string' ||
      typeof parsed.napiVersion !== 'number'
    ) {
      return null;
    }
    return {
      platform: parsed.platform,
      version: parsed.version,
      sha256: parsed.sha256,
      napiVersion: parsed.napiVersion,
    };
  } catch {
    return null;
  }
}

export async function loadNodeDatachannel(
  options: LoadNodeDatachannelOptions
): Promise<NodeDatachannelModule | null> {
  const log = options.log ?? defaultLog;
  const addon = nativeAddonPath(options.nativeDir);

  if (!(await pathExists(addon))) {
    log(`native addon not found: ${addon}`);
    return null;
  }

  const manifest = await readInstalledNativeManifest(options.nativeDir);
  if (!manifest) {
    log(`native manifest missing or invalid: ${nativeManifestPath(options.nativeDir)}`);
    return null;
  }

  const bytes = new Uint8Array(await readFile(addon));
  const digest = sha256Hex(bytes);
  if (digest !== manifest.sha256) {
    log(`native addon sha256 mismatch (expected ${manifest.sha256}, got ${digest})`);
    return null;
  }

  try {
    requireNative(addon);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to require native addon: ${message}`);
    return null;
  }

  process.env.TMEX_NATIVE_DIR = options.nativeDir;

  try {
    const imported = await import('../vendor/node-datachannel/index');
    return {
      PeerConnection: imported.PeerConnection as NodeDatachannelModule['PeerConnection'],
      cleanup: imported.cleanup,
      preload: imported.preload,
      initLogger: imported.initLogger,
      getLibraryVersion: imported.getLibraryVersion,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to load vendored node-datachannel JS: ${message}`);
    return null;
  }
}
