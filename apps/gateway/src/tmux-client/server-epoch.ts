export const VIBETERM_SERVER_EPOCH_OPTION = '@vibeterm-server-epoch';
/** tmex 时期的选项名：升级时 tmux 服务端还活着，attach 时把旧值搬到新名再删旧值。 */
export const LEGACY_SERVER_EPOCH_OPTION = '@tmex-server-epoch';

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TmuxCommandRunner = (argv: string[]) => Promise<TmuxCommandResult>;

function createEpochHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeServerEpoch(value: string): Uint8Array {
  const normalized = value.trim();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error(`invalid ${VIBETERM_SERVER_EPOCH_OPTION} value`);
  }
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
  );
}

export async function ensureStableServerEpoch(
  runTmux: TmuxCommandRunner,
  candidate = createEpochHex()
): Promise<Uint8Array> {
  decodeServerEpoch(candidate);

  const existing = await runTmux(['show-options', '-gqv', VIBETERM_SERVER_EPOCH_OPTION]);
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    return decodeServerEpoch(existing.stdout);
  }

  // 从 1.x 原地升级：服务端仍带旧选项，搬到新名后删旧值，epoch 不变（否则会话被判为换了服务端）。
  const legacy = await runTmux(['show-options', '-gqv', LEGACY_SERVER_EPOCH_OPTION]);
  const legacyValue = legacy.exitCode === 0 ? legacy.stdout.trim() : '';
  if (legacyValue && /^[0-9a-f]{32}$/.test(legacyValue)) {
    await runTmux(['set-option', '-gq', '-o', VIBETERM_SERVER_EPOCH_OPTION, legacyValue]);
    await runTmux(['set-option', '-gqu', LEGACY_SERVER_EPOCH_OPTION]);
    return decodeServerEpoch(legacyValue);
  }

  await runTmux(['set-option', '-gq', '-o', VIBETERM_SERVER_EPOCH_OPTION, candidate]);

  const resolved = await runTmux(['show-options', '-gqv', VIBETERM_SERVER_EPOCH_OPTION]);
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    const detail = resolved.stderr.trim() || 'option remained unset';
    throw new Error(`failed to establish ${VIBETERM_SERVER_EPOCH_OPTION}: ${detail}`);
  }
  return decodeServerEpoch(resolved.stdout);
}
