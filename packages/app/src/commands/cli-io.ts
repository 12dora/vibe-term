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
  serviceManager?: ServiceManagerKind;
  confirm?: () => boolean | Promise<boolean>;
  isTTY?: boolean;
  readConfirmation?: () => Promise<string>;
  /** r3 加入时每个中继请求的超时（毫秒）；只在测试里下调。 */
  relayTimeoutMs?: number;
};
