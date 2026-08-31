import { describe, expect, test } from 'bun:test';
import { recoveryAction } from './upgrade-state';
import type { UpgradeJournal } from './upgrade-state';

function journal(phase: UpgradeJournal['phase']): UpgradeJournal {
  return {
    txnId: 'txn-1',
    phase,
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    startedAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:01.000Z',
  };
}

describe('recoveryAction', () => {
  test('null journal only cleans leftovers', () => {
    expect(recoveryAction(null)).toBe('cleanup');
  });

  test('staging and preflight abort the candidate', () => {
    expect(recoveryAction(journal('lock'))).toBe('abort_candidate');
    expect(recoveryAction(journal('staging'))).toBe('abort_candidate');
    expect(recoveryAction(journal('preflight'))).toBe('abort_candidate');
  });

  test('backup and switching restart the old service', () => {
    expect(recoveryAction(journal('backup'))).toBe('restart_old');
    expect(recoveryAction(journal('switching'))).toBe('restart_old');
  });

  test('started verifies then commits or rolls back', () => {
    expect(recoveryAction(journal('started'))).toBe('verify_or_rollback');
  });

  test('terminal phases only clean leftovers', () => {
    expect(recoveryAction(journal('committed'))).toBe('cleanup');
    expect(recoveryAction(journal('rolled_back'))).toBe('cleanup');
    expect(recoveryAction(journal('aborted'))).toBe('cleanup');
  });
});
