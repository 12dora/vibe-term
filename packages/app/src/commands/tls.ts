import { t } from '../i18n';
import { confirmDestructiveReset } from '../lib/destructive-confirm';
import { resetTlsConfig } from '../tls/tls-recovery';
import type { ParsedArgs } from '../types';
import type { CliIo } from './cli-io';
import { withAuth } from './with-auth';

export async function runTlsReset(parsed: ParsedArgs, io: CliIo = {}): Promise<void> {
  await confirmDestructiveReset(parsed, io, t('tls.reset.warning'));
  await withAuth(parsed, io, async (ctx) => {
    resetTlsConfig(ctx.db);
    (io.log ?? console.log)(t('tls.reset.done'));
  });
}
