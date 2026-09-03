// PID 文件解析核心。CLI 与网关操作同一个 `<installDir>/tmex.pid`，但语义已分叉：
// - CLI `parsePidRecord`：JSON 的 pid 必须是 number；保留 runtimePath。
// - 网关 `parsePidFileRecord`：JSON pid 走 asPositiveInt（数字字符串也接受），丢弃 runtimePath。
// 本模块实现 CLI 更严语义。两侧调用点均在其他 agent 占用的文件内，此处不改调用方。
// 网关只读 pid / identity，生产 pid 文件由 CLI `formatPidRecord` 写出（pid 为 JSON number），
// 因此更严解析与网关现网写入格式兼容；不能静默让网关接受 CLI 才依赖的 runtimePath 归属判定。

export type PidFileRecord = {
  pid: number;
  identity?: string | null;
  runtimePath?: string;
};

export type ParsePidFileRecordOptions = {
  allowNumericStringPid?: boolean;
};

export function parsePidFileRecord(
  raw: string,
  options: ParsePidFileRecordOptions = {}
): PidFileRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<PidFileRecord> & { pid?: unknown };
    const pid =
      options.allowNumericStringPid && typeof parsed.pid === 'string'
        ? Number(parsed.pid)
        : parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      identity: typeof parsed.identity === 'string' ? parsed.identity : null,
      runtimePath: typeof parsed.runtimePath === 'string' ? parsed.runtimePath : undefined,
    };
  } catch {
    return null;
  }
}
