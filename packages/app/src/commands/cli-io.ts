import type { LocalAuthContext } from '../lib/local-auth';
import type { NodeFetch } from '../lib/node-client';
import type { ServiceManagerKind } from '../lib/platform';
import type { DirectEnableResult, EnableDirectOptions } from './direct';

export type CliIo = {
  enableDirect?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
  log?: (message: string) => void;
  password?: string;
  oldPassword?: string;
  newPassword?: string;
  restart?: (serviceName: string, installDir: string) => Promise<void>;
  auth?: LocalAuthContext;
  now?: () => number;
  fetcher?: NodeFetch;
  insecureLocal?: boolean;
  skipRestart?: boolean;
  stop?: (serviceName: string, installDir: string) => Promise<void>;
  start?: (serviceName: string, installDir: string) => Promise<void>;
  nodeEnv?: string;
  totpCode?: string;
  /** 测试用：在密钥打印之后、写入之前提供验证码。 */
  readTotpCode?: (secret: Uint8Array) => string | Promise<string>;
  serviceManager?: ServiceManagerKind;
  confirm?: () => boolean | Promise<boolean>;
  isTTY?: boolean;
  readConfirmation?: () => Promise<string>;
  /** r3 加入时每个中继请求的超时（毫秒）；只在测试里下调。 */
  relayTimeoutMs?: number;
  /** r3 加入后等待批准的轮询间隔与总时限（毫秒）；只在测试里改。 */
  joinPollIntervalMs?: number;
  joinWaitTimeoutMs?: number;
  /** 等待批准时的休眠；测试里换成推进假时钟。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 中断等待（Ctrl+C）；缺省时由 SIGINT 触发。 */
  interruptSignal?: AbortSignal;
  /** 设置进程退出码；缺省写 `process.exitCode`。只在测试里替换。 */
  setExitCode?: (code: number) => void;
};
