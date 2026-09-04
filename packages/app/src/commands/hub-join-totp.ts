import {
  type PublishHubJoinSelfAdmitInput,
  publishHubJoinSelfAdmit,
} from '../lib/hub-password-self-admit';
import { promptPassword } from '../lib/prompt';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';

export type JoinTotpIo = {
  totpCode?: string;
};

export function joinErrorHttpStatus(code: string): number {
  if (code === 'node_revoked' || code === 'node_exists') return 409;
  if (code === 'hub_unreachable') return 502;
  return 400;
}

export function resolveJoinTotpCode(parsed: ParsedArgs, io: JoinTotpIo): string | undefined {
  const flag = asString(parsed.flags.totp);
  if (flag) return flag;
  if (typeof io.totpCode === 'string' && io.totpCode.trim()) return io.totpCode.trim();
  const env = process.env.TMEX_TOTP?.trim();
  return env || undefined;
}

export async function promptJoinTotpCode(): Promise<string> {
  return await promptPassword('TOTP code', { envKey: 'TMEX_TOTP', confirm: false });
}

function isTotpRequired(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: unknown }).code === 'totp_required'
  );
}

type PasswordJoinAdmitInput = Omit<PublishHubJoinSelfAdmitInput, 'rootKey'> & {
  rootKey?: PublishHubJoinSelfAdmitInput['rootKey'];
  publish?: typeof publishHubJoinSelfAdmit;
  onPending?: () => void;
};

export async function publishPasswordJoinAdmitIfNeeded(
  input: PasswordJoinAdmitInput
): Promise<boolean> {
  if (!input.rootKey) return false;
  const { rootKey, publish, onPending, ...rest } = input;
  const admit = await (publish ?? publishHubJoinSelfAdmit)({ ...rest, rootKey });
  if (admit.admitPending) onPending?.();
  return admit.admitPending;
}

export async function publishHubJoinAdmitForCli(input: PasswordJoinAdmitInput): Promise<boolean> {
  try {
    return await publishPasswordJoinAdmitIfNeeded(input);
  } catch (error) {
    if (!isTotpRequired(error) || input.totpCode?.trim()) throw error;
    const totpCode = await promptJoinTotpCode();
    return await publishPasswordJoinAdmitIfNeeded({ ...input, totpCode });
  }
}
