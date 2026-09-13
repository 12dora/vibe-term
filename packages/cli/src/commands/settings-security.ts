import {
  PASSKEY_REGISTER_HINT,
  changeAccountPassword,
  decodeTotpSecret,
  disableTotp,
  enableTotp,
  generateTotpSecret,
  listPasskeys,
  removePasskey,
  totpPreview,
} from '../core/account-security';
import { flagBool, flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  emit,
  readSecretField,
  rejectExtra,
  requireArg,
} from '../core/cmd';
import { UsageError } from '../core/errors';
import { readAccountPassword } from '../core/nodes-keylog';
import { isInteractive, promptHidden } from '../core/prompt';
import { enabledFromFlags } from '../core/settings-body';
import { jsonSelf, print } from './settings-http';

async function readNewPassword(ctx: Parameters<SubHandler>[0], flags: Parameters<SubHandler>[1]) {
  const fromField = await readSecretField(ctx, flags, {
    flag: 'new-password',
    envName: 'VIBETERM_NEW_PASSWORD',
  });
  if (fromField) return fromField;
  if (!isInteractive()) {
    throw new UsageError(
      'new password is required and stdin is not a terminal',
      'pass --new-password-stdin, --new-password-file, or VIBETERM_NEW_PASSWORD'
    );
  }
  const first = await promptHidden('New password: ');
  if (!first) throw new UsageError('new password is empty');
  const second = await promptHidden('Confirm new password: ');
  if (first !== second) throw new UsageError('passwords do not match');
  return first;
}

export const passwd: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  const fullReset = flagBool(flags, 'full-reset');
  if (fullReset) {
    await confirmOrYes(
      flags,
      'full reset clears every passkey and authenticator and signs you out everywhere'
    );
  }
  const oldPassword = await readAccountPassword();
  const newPassword = await readNewPassword(ctx, flags);
  const result = await changeAccountPassword(ctx, { fullReset, oldPassword, newPassword });
  print(ctx, result);
};

function totpSecretFromFlags(flags: Parameters<SubHandler>[1]): Uint8Array {
  const raw = flagString(flags, 'totp-secret') ?? process.env.VIBETERM_TOTP_SECRET;
  return raw ? decodeTotpSecret(raw) : generateTotpSecret();
}

async function totpCodeFromFlags(flags: Parameters<SubHandler>[1]): Promise<string> {
  const fromFlag = flagString(flags, 'code');
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.VIBETERM_TOTP;
  if (fromEnv) return fromEnv;
  if (!isInteractive()) {
    throw new UsageError(
      'TOTP code is required and stdin is not a terminal',
      'pass --code or set VIBETERM_TOTP after scanning the otpauth URI'
    );
  }
  const value = (await promptHidden('TOTP code: ')).trim();
  if (!value) throw new UsageError('TOTP code is empty');
  return value;
}

export const totp: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'enable|disable');
  rejectExtra(positionals, 1);
  if (action === 'disable') {
    const result = await disableTotp(ctx, await readAccountPassword());
    print(ctx, result);
    return;
  }
  if (action !== 'enable') {
    throw new UsageError(`unknown totp action: ${action}`, 'use enable|disable');
  }
  const secret = totpSecretFromFlags(flags);
  const preview = await totpPreview(ctx, secret);
  if (!ctx.globals.json) {
    ctx.out.info(`Secret (base32): ${preview.secretBase32}`);
    ctx.out.info(preview.otpauthUri);
  }
  const code = await totpCodeFromFlags(flags);
  const password = await readAccountPassword();
  const outcome = await enableTotp(ctx, { password, secret, code });
  secret.fill(0);
  emit(ctx, outcome, () => {
    ctx.out.line(`Secret (base32): ${outcome.secretBase32}`);
    ctx.out.line(outcome.otpauthUri);
    ctx.out.line('TOTP enabled');
  });
};

export const passkey: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|rm');
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    const passkeys = await listPasskeys(ctx);
    emit(ctx, { passkeys, hint: PASSKEY_REGISTER_HINT }, () => {
      ctx.out.info(PASSKEY_REGISTER_HINT);
      ctx.out.table(passkeys, [
        { header: 'ID', value: (row) => row.credential_id },
        { header: 'NAME', value: (row) => row.name ?? '-' },
        { header: 'ORIGIN', value: (row) => row.origin },
        { header: 'HERE', value: (row) => (row.usableHere === false ? 'no' : 'yes') },
      ]);
    });
    return;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, 'credential id');
    rejectExtra(positionals, 2);
    await confirmOrYes(flags, `delete passkey ${id}`);
    const result = await removePasskey(ctx, id, await readAccountPassword());
    print(ctx, result);
    return;
  }
  throw new UsageError(`unknown passkey action: ${action}`, 'use ls|rm');
};

export const localAuth: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'bootstrap|set');
  if (action === 'bootstrap') {
    rejectExtra(positionals, 1);
    const username = flagString(flags, 'user');
    if (!username) {
      throw new UsageError('local-auth bootstrap requires --user <username>');
    }
    const password = await readSecretField(ctx, flags, {
      flag: 'password',
      envName: 'VIBETERM_PASSWORD',
      required: true,
      prompt: 'Password: ',
    });
    print(ctx, await jsonSelf(ctx, 'POST', '/api/auth/local/bootstrap', { username, password }));
    return;
  }
  if (action === 'set') {
    print(
      ctx,
      await jsonSelf(ctx, 'POST', '/api/auth/local', {
        enabled: enabledFromFlags(flags, positionals[1]),
      })
    );
    return;
  }
  throw new UsageError(`unknown local-auth action: ${action}`, 'use bootstrap|set');
};
