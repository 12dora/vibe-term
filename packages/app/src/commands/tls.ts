import { t } from '../i18n';
import { confirmDestructiveReset } from '../lib/hub-user-passwd';
import { resetTlsConfig } from '../tls/tls-recovery';
import type { ParsedArgs } from '../types';
import type { HubIo } from './hub';
import { withAuth } from './with-auth';

export async function runTlsReset(parsed: ParsedArgs, io: HubIo = {}): Promise<void> {
  await confirmDestructiveReset(parsed, io, t('tls.reset.warning'));
  await withAuth(parsed, io, async (ctx) => {
    resetTlsConfig(ctx.db);
    (io.log ?? console.log)(t('tls.reset.done'));
  });
}
