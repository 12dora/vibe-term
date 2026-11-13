import {
  parseTrustProxyFlag,
  patchTrustProxyEnv,
} from '../../../../apps/gateway/src/tunnel/trust-proxy-env';
import { readEnvFileIfExists, writeEnvFile } from '../lib/env-file';

export async function readTrustProxy(envPath: string): Promise<boolean | null> {
  return parseTrustProxyFlag((await readEnvFileIfExists(envPath))?.VIBETERM_TRUST_PROXY);
}

/** 外部模式（本机反代）：与隧道开关共用一套写入规则，不删除用户自己设的客户端地址头。 */
export async function writeTrustProxy(envPath: string, trustProxy: boolean): Promise<void> {
  const existing = (await readEnvFileIfExists(envPath)) ?? {};
  await writeEnvFile(envPath, patchTrustProxyEnv(existing, trustProxy ? 'proxy' : 'off'));
}
