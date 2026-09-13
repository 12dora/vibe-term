/** 环境变量端口 / 布尔解析。不依赖 `node:*`，但不要从浏览器侧主入口再导出。 */

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

export type ParsePortOptions = {
  /** 含端下限，默认 1。动态端口传 0。 */
  min?: number;
  max?: number;
  /** 空值或非法时返回，而不是抛错。 */
  fallback?: number;
  /** 报错前缀，例如 `GATEWAY_PORT`。 */
  name?: string;
};

export function parsePort(raw: string | undefined, options: ParsePortOptions = {}): number {
  const min = options.min ?? PORT_MIN;
  const max = options.max ?? PORT_MAX;
  const name = options.name ?? 'port';
  const value = raw?.trim() ?? '';
  if (!value || !/^\d+$/.test(value)) {
    if (options.fallback !== undefined) return options.fallback;
    throw new Error(`${name} must be a decimal integer`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < min || port > max) {
    if (options.fallback !== undefined) return options.fallback;
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return port;
}

/** 与网关 `getBooleanEnv` 一致：未设置用默认；`'1'` / `'true'` / `'yes'`（大小写不敏感）为真。 */
export function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}
