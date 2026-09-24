// 采样脚本本来就会补上用户总线；set-property / stop / 孤儿清扫必须用同一段，
// 否则 show-environment 能通、写属性却报 Failed to connect to bus。

export const USER_BUS_EXPORT_LINES = [
  'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"',
  'if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then',
  '  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"',
  'fi',
] as const;

const USER_BUS_PREAMBLE = [
  'uid=$(id -u 2>/dev/null) || uid=0',
  '[ -n "$uid" ] || uid=0',
  ...USER_BUS_EXPORT_LINES,
].join('\n');

export function withUserBus(body: string): string {
  return `${USER_BUS_PREAMBLE}\n${body}`;
}
