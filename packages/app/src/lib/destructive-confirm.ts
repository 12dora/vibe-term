import { t } from '../i18n';
import type { ParsedArgs } from '../types';
import { isInteractiveStdin, promptText } from './prompt';

export async function confirmDestructiveReset(
  parsed: ParsedArgs,
  io: {
    log?: (message: string) => void;
    isTTY?: boolean;
    readConfirmation?: () => Promise<string>;
  },
  warning = t('mesh.reset.warning')
): Promise<void> {
  (io.log ?? console.log)(warning);
  if (!(io.isTTY ?? isInteractiveStdin())) {
    if (parsed.flags.yes === true) return;
    throw new Error(t('mesh.reset.requiresYes'));
  }
  const answer = io.readConfirmation
    ? await io.readConfirmation()
    : await promptText({ nonInteractive: false }, t('mesh.reset.confirm'));
  if (answer.trim() !== 'yes') throw new Error(t('mesh.reset.cancelled'));
}
