import { describe, expect, test } from 'bun:test';
import { TRANSFER_CAPABILITIES } from './transfer';

describe('TRANSFER_CAPABILITIES', () => {
  test('array is the TransferCapability source', () => {
    expect([...TRANSFER_CAPABILITIES]).toEqual(['transfer-v2', 'transfer-ranged-parallel']);
  });
});
