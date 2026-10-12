import { createServer } from 'node:net';
import { t } from '../i18n';

export type CanBind = (port: number, host: string) => Promise<boolean>;

export const FREE_PORT_ATTEMPTS = 20;

/**
 * 真实绑定一次再立刻释放。只有 EADDRINUSE 表示「被占用」；其余错误（主机名无效、无权限、
 * 地址不属于本机……）换端口也不会好，原样抛出。Bun 下 DNS 失败的 `code` 可能为空，同样按硬错误处理。
 */
export const canBindPort: CanBind = (port, host) =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });

export interface PickFreePortOptions {
  /** 提示信息里指给用户的手动覆盖参数名。 */
  flag: string;
  canBind?: CanBind;
  /** 已被本次安装其他组件占用的端口，直接跳过。 */
  avoid?: readonly number[];
  attempts?: number;
}

/** 从 `preferred` 起依次探测，返回第一个可绑定的端口；有界尝试后仍无可用端口则报错。 */
export async function pickFreePort(
  preferred: number,
  host: string,
  options: PickFreePortOptions
): Promise<number> {
  const canBind = options.canBind ?? canBindPort;
  const avoid = new Set(options.avoid ?? []);
  const last = Math.min(preferred + (options.attempts ?? FREE_PORT_ATTEMPTS) - 1, 65535);
  for (let port = preferred; port <= last; port += 1) {
    if (avoid.has(port)) continue;
    if (await canBind(port, host)) return port;
  }
  throw new Error(
    t('init.error.noFreePort', { from: preferred, to: last, host, flag: options.flag })
  );
}
