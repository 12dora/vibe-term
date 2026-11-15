import { type CgroupPlacement, getCgroupPlacement } from '../../tmux/cgroup-placement';
import type { CommandResult } from './types';

const LOCAL_LOG_PREFIX = '[local]';
const PLACEMENT_TMUX_TIMEOUT_MS = 5_000;

export interface PlacementWiringHost {
  deviceId: string;
  logPrefix: string;
  runTmuxAllowFailure(argv: string[], timeoutMs?: number): Promise<CommandResult>;
}

function parsePid(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^\d+$/.test(text)) return null;
  const pid = Number.parseInt(text, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function parsePidLines(stdout: string): number[] {
  return stdout.split('\n').flatMap((line) => {
    const pid = parsePid(line);
    return pid === null ? [] : [pid];
  });
}

async function runConnectPlacement(
  host: PlacementWiringHost,
  placement: CgroupPlacement
): Promise<void> {
  const probe = await placement.probePlacementSupport();
  if (!probe.supported) {
    placement.disableDevice(host.deviceId);
    console.info(
      `[tmux] placement server_cgroup=- panes_slice=${placement.config.workloadSlice} mode=${placement.modeLabel()}`
    );
    return;
  }
  const info = await host.runTmuxAllowFailure(
    ['display-message', '-p', '#{pid}\t#{socket_path}'],
    PLACEMENT_TMUX_TIMEOUT_MS
  );
  const [pidRaw, socketPath = ''] = info.stdout.trim().split('\t');
  const serverPid = info.exitCode === 0 ? parsePid(pidRaw) : null;
  if (serverPid === null) return;
  const server = await placement.protectTmuxServer(serverPid, socketPath);
  placement.enableDevice(host.deviceId);
  const panes = await host.runTmuxAllowFailure(
    ['list-panes', '-a', '-F', '#{pane_pid}'],
    PLACEMENT_TMUX_TIMEOUT_MS
  );
  const moved =
    panes.exitCode === 0
      ? await placement.placePanes(host.deviceId, parsePidLines(panes.stdout))
      : 0;
  console.info(
    `[tmux] placement server_cgroup=${server.cgroup ?? '-'} panes_slice=${placement.config.workloadSlice} mode=${placement.modeLabel()} server=${server.action} moved_panes=${moved}`
  );
}

/** 本机连接建好会话后：保护 tmux server，再把已有 pane 归位。SSH 设备不做；返回值只给测试等待。 */
export function startConnectPlacement(
  host: PlacementWiringHost,
  placement: CgroupPlacement = getCgroupPlacement()
): Promise<void> {
  if (host.logPrefix !== LOCAL_LOG_PREFIX) return Promise.resolve();
  return runConnectPlacement(host, placement).catch((error) => {
    console.warn(
      `[tmux] placement connect failed device=${host.deviceId}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

/** 放置开着时给 new-window 追加 `-P -F #{pane_pid}`，拿到新 pane 的 pid。 */
export function withPanePidOutput(
  host: PlacementWiringHost,
  argv: string[],
  placement: CgroupPlacement = getCgroupPlacement()
): string[] {
  if (!placement.isDeviceEnabled(host.deviceId)) return argv;
  return [...argv, '-P', '-F', '#{pane_pid}'];
}

export function placeCreatedPane(
  host: PlacementWiringHost,
  rawPid: string | undefined,
  placement: CgroupPlacement = getCgroupPlacement()
): Promise<number> {
  const pid = parsePid(rawPid);
  if (pid === null) return Promise.resolve(0);
  return placement.placePanes(host.deviceId, [pid]);
}
