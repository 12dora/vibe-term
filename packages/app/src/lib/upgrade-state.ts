import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists, writeTextAtomic } from './fs-utils';

export type UpgradePhase =
  | 'lock'
  | 'staging'
  | 'preflight'
  | 'stopping'
  | 'backup'
  | 'switching'
  | 'started'
  | 'committed'
  | 'aborted'
  | 'rolled_back';

export interface UpgradeJournal {
  txnId: string;
  phase: UpgradePhase;
  fromVersion: string;
  toVersion: string;
  startedAt: string;
  updatedAt: string;
  dbBackup?: boolean;
  keepBackup?: boolean;
  candidatePid?: number;
  candidateStartedAt?: string;
  error?: string;
}

export type RecoveryKind = 'abort_candidate' | 'restart_old' | 'verify_or_rollback' | 'cleanup';

export function journalPath(installDir: string): string {
  return join(installDir, 'upgrade-state.json');
}

export function recoveryAction(journal: UpgradeJournal | null): RecoveryKind {
  if (!journal) return 'cleanup';
  switch (journal.phase) {
    case 'lock':
    case 'staging':
    case 'preflight':
      return 'abort_candidate';
    case 'stopping':
    case 'backup':
    case 'switching':
      return 'restart_old';
    case 'started':
      return 'verify_or_rollback';
    case 'committed':
    case 'rolled_back':
    case 'aborted':
      return 'cleanup';
  }
}

export async function readJournal(installDir: string): Promise<UpgradeJournal | null> {
  const path = journalPath(installDir);
  if (!(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<UpgradeJournal>;
    if (
      typeof parsed.txnId !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.fromVersion !== 'string' ||
      typeof parsed.toVersion !== 'string'
    ) {
      return null;
    }
    return parsed as UpgradeJournal;
  } catch {
    return null;
  }
}

export async function writeJournal(installDir: string, journal: UpgradeJournal): Promise<void> {
  await writeTextAtomic(journalPath(installDir), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

export async function advanceJournal(
  installDir: string,
  current: UpgradeJournal,
  phase: UpgradePhase,
  extra?: Partial<
    Pick<
      UpgradeJournal,
      'dbBackup' | 'error' | 'keepBackup' | 'candidatePid' | 'candidateStartedAt'
    >
  >
): Promise<UpgradeJournal> {
  const next: UpgradeJournal = {
    ...current,
    ...extra,
    phase,
    updatedAt: new Date().toISOString(),
  };
  await writeJournal(installDir, next);
  return next;
}

export function createJournal(input: {
  txnId: string;
  fromVersion: string;
  toVersion: string;
  now?: Date;
}): UpgradeJournal {
  const startedAt = (input.now ?? new Date()).toISOString();
  return {
    txnId: input.txnId,
    phase: 'lock',
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    startedAt,
    updatedAt: startedAt,
  };
}
