import {
  type KdfParams,
  type RootKey,
  bytesEqual,
  deriveSeed,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { promptPassword } from './prompt';

export async function resolvePassword(options: {
  password?: string;
  envKey?: string;
  confirm?: boolean;
  prompt?: string;
  confirmPrompt?: string;
}): Promise<string> {
  if (options.password !== undefined) {
    if (!options.password) {
      throw new Error('password cannot be empty');
    }
    return options.password;
  }
  return await promptPassword(options.prompt ?? 'Password', {
    envKey: options.envKey ?? 'TMEX_PASSWORD',
    confirm: options.confirm,
    confirmMessage: options.confirmPrompt,
  });
}

export async function deriveRootKey(password: string, kdfParams: KdfParams): Promise<RootKey> {
  const seed = await deriveSeed(password, kdfParams);
  return rootKeyFromSeed(seed);
}

export function assertRootKeyMatches(rootKey: RootKey, expectedPublicKey: Uint8Array): void {
  if (!bytesEqual(rootKey.publicKey, expectedPublicKey)) {
    throw new Error('password does not match stored root public key');
  }
}
