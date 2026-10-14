// `vibeterm forward` 的 ssh 风格转发规格：`[bind:]port:host:hostport`，host/bind 可写成 `[::1]`。

import { UsageError } from './errors';

export type ForwardKind = 'L' | 'R';

export interface ForwardSpec {
  kind: ForwardKind;
  /** 监听地址；缺省 127.0.0.1，`*` 等价 0.0.0.0。 */
  bindHost: string;
  port: number;
  host: string;
  hostPort: number;
}

export const DEFAULT_BIND_HOST = '127.0.0.1';

function splitFields(raw: string): string[] {
  const fields: string[] = [];
  let index = 0;
  while (index <= raw.length) {
    if (raw[index] === '[') {
      const close = raw.indexOf(']', index);
      if (close < 0) throw new UsageError(`转发规格括号不匹配: ${raw}`);
      fields.push(raw.slice(index + 1, close));
      index = close + 1;
      if (index < raw.length && raw[index] !== ':') {
        throw new UsageError(`转发规格 "]" 后应为 ":": ${raw}`);
      }
      index += 1;
      continue;
    }
    const colon = raw.indexOf(':', index);
    const end = colon < 0 ? raw.length : colon;
    fields.push(raw.slice(index, end));
    if (colon < 0) break;
    index = colon + 1;
  }
  return fields;
}

function parsePort(text: string, raw: string): number {
  if (!/^\d{1,5}$/.test(text)) throw new UsageError(`端口无效: "${text}"（${raw}）`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new UsageError(`端口超出 1-65535: ${text}（${raw}）`);
  return port;
}

function requireHost(text: string, raw: string): string {
  if (!text) throw new UsageError(`转发规格缺少主机: ${raw}`);
  return text;
}

export function parseForwardSpec(kind: ForwardKind, raw: string): ForwardSpec {
  const fields = splitFields(raw.trim());
  if (fields.length !== 3 && fields.length !== 4) {
    throw new UsageError(
      `转发规格应为 [bind:]port:host:hostport，收到 "${raw}"`,
      'IPv6 地址写成 [::1]:8080:[::1]:80'
    );
  }
  const hasBind = fields.length === 4;
  const [portText, host, hostPortText] = (hasBind ? fields.slice(1) : fields) as [
    string,
    string,
    string,
  ];
  const bind = hasBind ? fields[0] : undefined;
  const bindHost =
    bind === undefined ? DEFAULT_BIND_HOST : bind === '*' ? '0.0.0.0' : requireHost(bind, raw);
  return {
    kind,
    bindHost,
    port: parsePort(portText, raw),
    host: requireHost(host, raw),
    hostPort: parsePort(hostPortText, raw),
  };
}

export function formatHostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

const CLUSTER_RE = /^-[A-Za-z]/;

/** 展开一个 `-LNR` 簇；返回消费的额外 argv 个数（`-L spec` 分写时为 1）。 */
function rewriteCluster(
  token: string,
  argv: readonly string[],
  index: number,
  out: string[]
): number {
  const letters = token.slice(1);
  for (let at = 0; at < letters.length; at += 1) {
    const letter = letters[at];
    if (letter === 'N') continue;
    if (letter !== 'L' && letter !== 'R') {
      throw new UsageError(`forward 不支持选项 -${letter}`, '仅支持 -L、-R、-N；其余见 --help');
    }
    const inline = letters.slice(at + 1);
    const consumed = inline ? 0 : 1;
    const value = inline || argv[index + consumed];
    if (value === undefined) throw new UsageError(`-${letter} 需要转发规格`);
    out.push(`--${letter === 'L' ? 'local' : 'remote'}=${value}`);
    return consumed;
  }
  return 0;
}

/**
 * 把 ssh 习惯的 `-L spec` / `-Lspec` / `-R spec` / `-N` 改写成 `--local=spec` / `--remote=spec`。
 * 通用解析器把单横线当位置参数，所以必须在派发层之前改写；已是长旗标的 token 原样放行（幂等）。
 */
export function rewriteForwardArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      out.push(...argv.slice(index));
      break;
    }
    if (token === '-h' || !CLUSTER_RE.test(token)) {
      out.push(token);
      continue;
    }
    index += rewriteCluster(token, argv, index, out);
  }
  return out;
}
