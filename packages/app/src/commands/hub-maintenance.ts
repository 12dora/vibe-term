import { canonicalHubUrl } from '../../../shared/src/auth';
import { t } from '../i18n';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { assertHubJoinUrl } from '../lib/hub-client';
import { loadInstallEnv } from '../lib/local-auth';
import { parseAndValidateCaPem } from '../lib/pem';
import type { ParsedArgs } from '../types';
import type { HubIo } from './hub';
import { log, nowMs } from './hub-output';
import { withAuth } from './with-auth';

export async function runHubUrls(
  parsed: ParsedArgs,
  action: 'list' | 'add' | 'remove',
  rawUrl = '',
  io: HubIo = {}
): Promise<string[]> {
  const loaded = io.auth ?? (await loadInstallEnv(parsed));
  const url = action === 'list' ? '' : canonicalHubUrl(assertHubJoinUrl(rawUrl).href);
  const update = (env: Record<string, string>): string[] => {
    const urls = [
      ...new Set(
        (env.VIBETERM_HUB_URLS ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map(canonicalHubUrl)
      ),
    ];
    const next =
      action === 'add'
        ? [...new Set([...urls, url])]
        : action === 'remove'
          ? urls.filter((item) => item !== url)
          : urls;
    if (action !== 'list') env.VIBETERM_HUB_URLS = next.join(',');
    return next;
  };
  let urls: string[];
  if (loaded.envPath) {
    urls = await withEnvLock(async () => {
      const env = await readEnvFile(loaded.envPath);
      const next = update(env);
      if (action !== 'list') await writeEnvFile(loaded.envPath, env);
      return next;
    });
  } else {
    urls = update(loaded.env);
  }
  log(io, `VIBETERM_HUB_URLS=${urls.join(',')}`);
  if (action !== 'list') log(io, t('hub.urls.restartHint'));
  return urls;
}

export async function runHubCaFingerprint(parsed: ParsedArgs, io: HubIo = {}): Promise<string> {
  return await withAuth(parsed, io, async (ctx) => {
    const { TlsConfigStore } = await import('../../../../apps/gateway/src/tls/tls-config-store');
    const config = await new TlsConfigStore(ctx.db).get();
    if (!config.caCertPem) throw new Error('no local self-signed CA configured');
    const { fingerprint } = await parseAndValidateCaPem(config.caCertPem);
    log(io, `SHA256 SPKI ${fingerprint}`);
    return fingerprint;
  });
}

export async function runHubCaRotate(parsed: ParsedArgs, io: HubIo = {}): Promise<string> {
  const { confirmDestructiveReset } = await import('../lib/hub-user-passwd');
  await confirmDestructiveReset(parsed, io, t('hub.ca.rotateWarning'));
  return await withAuth(parsed, io, async (ctx) => {
    const { TlsConfigStore } = await import('../../../../apps/gateway/src/tls/tls-config-store');
    const { rotateSelfSignedCa } = await import('../tls/tls-service');
    await rotateSelfSignedCa(new TlsConfigStore(ctx.db), { now: nowMs(io) });
    const fingerprint = await runHubCaFingerprint(parsed, { ...io, auth: ctx });
    log(io, t('hub.ca.rotateDone', { fingerprint }));
    return fingerprint;
  });
}
