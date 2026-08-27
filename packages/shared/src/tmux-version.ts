export interface TmuxVersion {
  major: number;
  minor: number;
}

export const MIN_TMUX_VERSION: TmuxVersion = { major: 3, minor: 0 };

function firstNonEmptyLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\uFEFF/, ''))
    .filter(Boolean);
  return lines[0] ?? null;
}

// 解析 `tmux -V` 输出，如 "tmux 3.4" / "tmux 3.3a" / "tmux next-3.6"。
// 只取首个非空行，避免 provenance 文本中的数字被误识别。
// master/openbsd 等无数字版本返回 null，调用方应放行。
export function parseTmuxVersion(versionOutput: string): TmuxVersion | null {
  const match = firstNonEmptyLine(versionOutput)?.match(/(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
  };
}

export function compareTmuxVersion(current: TmuxVersion | null, min: TmuxVersion): boolean {
  if (!current) return true;
  if (current.major !== min.major) return current.major > min.major;
  return current.minor >= min.minor;
}
