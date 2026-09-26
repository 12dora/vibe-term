import { describe, expect, test } from 'bun:test';
import {
  DC_PROMOTE_ADDITIVE_MS_DEFAULT,
  DC_PROMOTE_RATIO_DEFAULT,
  dcPromoteTooSlow,
} from './peer-dc-promote-gate';

describe('dcPromoteTooSlow', () => {
  test('2486 ms DC is slower than 89 ms ws-secure; 150 ms is not', () => {
    expect(dcPromoteTooSlow(2486, 89)).toBe(true);
    expect(dcPromoteTooSlow(150, 89)).toBe(false);
    expect(
      dcPromoteTooSlow(
        89 + DC_PROMOTE_ADDITIVE_MS_DEFAULT,
        89,
        DC_PROMOTE_RATIO_DEFAULT,
        DC_PROMOTE_ADDITIVE_MS_DEFAULT
      )
    ).toBe(false);
    expect(dcPromoteTooSlow(89 + DC_PROMOTE_ADDITIVE_MS_DEFAULT + 1, 89)).toBe(true);
  });

  test('threshold is configurable', () => {
    expect(dcPromoteTooSlow(120, 100, 1.1, 0)).toBe(true);
    expect(dcPromoteTooSlow(120, 100, 2, 50)).toBe(false);
  });
});
