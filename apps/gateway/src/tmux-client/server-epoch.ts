export const TMEX_SERVER_EPOCH_OPTION = '@tmex-server-epoch';

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
    throw new Error(`invalid ${TMEX_SERVER_EPOCH_OPTION} value`);
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

  const existing = await runTmux(['show-options', '-gqv', TMEX_SERVER_EPOCH_OPTION]);
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    return decodeServerEpoch(existing.stdout);
  }

  await runTmux(['set-option', '-gq', '-o', TMEX_SERVER_EPOCH_OPTION, candidate]);

  const resolved = await runTmux(['show-options', '-gqv', TMEX_SERVER_EPOCH_OPTION]);
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    const detail = resolved.stderr.trim() || 'option remained unset';
    throw new Error(`failed to establish ${TMEX_SERVER_EPOCH_OPTION}: ${detail}`);
  }
  return decodeServerEpoch(resolved.stdout);
}
