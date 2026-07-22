// control mode 订阅所需的核心通知（%output / %window-add / %layout-change 等）自 3.0 起齐备。
export const MIN_CONTROL_MODE_VERSION = { major: 3, minor: 0 };

export interface TmuxVersion {
  major: number;
  minor: number;
}

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

// 解析 `tmux -V` 输出，如 "tmux 3.4" / "tmux 3.3a" / "tmux next-3.6"。
// master/openbsd 等无数字版本返回 null，调用方应放行。
export function parseTmuxVersion(versionOutput: string): TmuxVersion | null {
  const match = normalizeTmuxVersionOutput(versionOutput).versionLine?.match(/(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
  };
}

export function isControlModeSupported(version: TmuxVersion | null): boolean {
  if (!version) {
    return true;
  }
  if (version.major !== MIN_CONTROL_MODE_VERSION.major) {
    return version.major > MIN_CONTROL_MODE_VERSION.major;
  }
  return version.minor >= MIN_CONTROL_MODE_VERSION.minor;
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
