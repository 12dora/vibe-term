import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originCertPath } from './provider';

const ARGO_BEGIN = '-----BEGIN ARGO TUNNEL TOKEN-----';
const ARGO_END = '-----END ARGO TUNNEL TOKEN-----';

export type ArgoTunnelCertCredentials = {
  accountId: string;
  apiToken: string;
  zoneId: string | null;
};

export function defaultOriginCertPath(homeDir: string): string {
  return join(homeDir, '.cloudflared', 'cert.pem');
}

export function isOriginCertPresent(tunnelDir: string, homeDir: string): boolean {
  return existsSync(originCertPath(tunnelDir)) || existsSync(defaultOriginCertPath(homeDir));
}

/** 把默认路径 cert 拷进 tunnelDir（0600）。永不删除用户默认 cert。 */
export function ensureManagedOriginCert(tunnelDir: string, homeDir: string): boolean {
  const managed = originCertPath(tunnelDir);
  if (existsSync(managed)) return true;
  const fallback = defaultOriginCertPath(homeDir);
  if (!existsSync(fallback)) return false;
  mkdirSync(tunnelDir, { recursive: true });
  copyFileSync(fallback, managed);
  chmodSync(managed, 0o600);
  return true;
}

export function parseArgoTunnelCert(
  pem: string | null | undefined
): ArgoTunnelCertCredentials | null {
  if (!pem) return null;
  const start = pem.indexOf(ARGO_BEGIN);
  const stop = pem.indexOf(ARGO_END);
  if (start < 0 || stop < 0 || stop <= start) return null;
  const b64 = pem.slice(start + ARGO_BEGIN.length, stop).replace(/\s+/g, '');
  if (!b64) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const accountId = readCertString(rec, ['accountID', 'accountId', 'account_id']);
  const apiToken = readCertString(rec, ['apiToken', 'api_token']);
  if (!accountId || !apiToken) return null;
  return {
    accountId,
    apiToken,
    zoneId: readCertString(rec, ['zoneID', 'zoneId', 'zone_id']),
  };
}

export function readArgoCertCredentials(homeDir: string): ArgoTunnelCertCredentials | null {
  try {
    return parseArgoTunnelCert(readFileSync(defaultOriginCertPath(homeDir), 'utf8'));
  } catch {
    return null;
  }
}

function readCertString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
