import { describe, expect, it } from 'bun:test';
import { enrollSas } from './enroll-sas';

describe('enrollSas', () => {
  it('is deterministic and formatted as 4-4 digits', () => {
    const cert = new Uint8Array([1, 2, 3, 4, 5]);
    expect(enrollSas(cert)).toBe(enrollSas(cert.slice()));
    expect(enrollSas(cert)).toMatch(/^\d{4}-\d{4}$/);
  });

  it('changes when the certificate changes', () => {
    expect(enrollSas(new Uint8Array([1, 2, 3]))).not.toBe(enrollSas(new Uint8Array([1, 2, 4])));
  });
});
