// 宿主注入的默认 clientVersion。网关按它做 canonical v1.1 版本门（fail-closed），
// 应用启动时必须先注入真实版本，否则新建的连接会被直接拒绝。

let defaultClientVersion = '0.0.0';

export function setDefaultClientVersion(version: string): void {
  defaultClientVersion = version;
}

export function getDefaultClientVersion(): string {
  return defaultClientVersion;
}
