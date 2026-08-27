import {
  MIN_TMUX_VERSION,
  type TmuxVersion,
  compareTmuxVersion,
  parseTmuxVersion,
} from '@tmex/shared';

export { parseTmuxVersion, type TmuxVersion };

// control mode 订阅所需的核心通知（%output / %window-add / %layout-change 等）自 3.0 起齐备。
export const MIN_CONTROL_MODE_VERSION = MIN_TMUX_VERSION;

export interface TmuxVersionOutput {
  versionLine: string | null;
  provenance: string | null;
}

// tmux 通常只输出一行；兼容实现可能在首行之后追加构建来源。协议身份只取首个非空行，
// 其余内容作为 provenance 单独保留，避免 client/server 因说明文字不同而误判冲突。
export function normalizeTmuxVersionOutput(output: string): TmuxVersionOutput {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\uFEFF/, ''))
    .filter(Boolean);
  const versionLine = lines.shift() ?? null;
  return {
    versionLine,
    provenance: lines.length > 0 ? lines.join('\n') : null,
  };
}

export function isControlModeSupported(version: TmuxVersion | null): boolean {
  return compareTmuxVersion(version, MIN_CONTROL_MODE_VERSION);
}

function normalizedTmuxIdentity(output: string): string | null {
  const normalized = normalizeTmuxVersionOutput(output)
    .versionLine?.trim()
    .replace(/^tmux\s+/i, '')
    .trim();
  return normalized || null;
}

export function tmuxVersionIdentity(output: string): string | null {
  return normalizedTmuxIdentity(output);
}

export function tmuxClientMatchesServer(clientOutput: string, serverOutput: string): boolean {
  const client = normalizedTmuxIdentity(clientOutput);
  const server = normalizedTmuxIdentity(serverOutput);
  return client !== null && server !== null && client === server;
}
