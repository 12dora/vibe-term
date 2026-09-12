import { describe, expect, test } from 'bun:test';
import { setLang, t } from '../i18n';
import { relayTurnDoctorCheck } from './doctor-turn';

const resolve = async (spec: string): Promise<string> => (spec === 'auto' ? '10.0.0.3' : spec);

describe('relayTurnDoctorCheck', () => {
  test('skips non-relay roles', async () => {
    expect(await relayTurnDoctorCheck({ VIBETERM_ROLES: 'node' })).toBeNull();
    expect(await relayTurnDoctorCheck({})).toBeNull();
  });

  test('classifies external, off, and builtin probe results', async () => {
    setLang('en');
    const external = await relayTurnDoctorCheck({
      VIBETERM_ROLES: 'relay',
      VIBETERM_TURN_URL: 'turn:ext.example:3478',
      VIBETERM_TURN_USERNAME: 'u',
      VIBETERM_TURN_CREDENTIAL: 'p',
    });
    expect(external).toMatchObject({
      id: 'turn',
      level: 'pass',
      message: t('doctor.turn.external'),
    });
    expect(external?.detail).toContain('UDP 3478');

    const off = await relayTurnDoctorCheck({
      VIBETERM_ROLES: 'relay,node',
      VIBETERM_TURN_PORT: 'off',
    });
    expect(off).toMatchObject({ id: 'turn', level: 'pass', message: t('doctor.turn.off') });

    const listening = await relayTurnDoctorCheck(
      { VIBETERM_ROLES: 'relay' },
      async () => ({ ok: true }),
      resolve
    );
    expect(listening).toMatchObject({
      id: 'turn',
      level: 'pass',
      message: t('doctor.turn.builtinListening', { port: 3478, bind: '10.0.0.3 (auto)' }),
    });
    expect(listening?.detail).toContain('UDP 49160-49259');

    const down = await relayTurnDoctorCheck(
      { VIBETERM_ROLES: 'relay' },
      async () => ({ ok: false }),
      resolve
    );
    expect(down?.level).toBe('warn');
    expect(down?.message).toBe(
      t('doctor.turn.builtinNotListening', { port: 3478, bind: '10.0.0.3 (auto)' })
    );
  });

  test('prints a literal bind host without (auto) and probes that address', async () => {
    setLang('en');
    const urls: string[] = [];
    const check = await relayTurnDoctorCheck(
      { VIBETERM_ROLES: 'relay', VIBETERM_TURN_BIND_HOST: '192.0.2.8' },
      async (url) => {
        urls.push(url);
        return { ok: true };
      },
      resolve
    );
    expect(urls).toEqual(['stun:192.0.2.8:3478']);
    expect(check?.message).toBe(
      t('doctor.turn.builtinListening', { port: 3478, bind: '192.0.2.8' })
    );
  });

  test('wildcard bind probes loopback', async () => {
    const urls: string[] = [];
    await relayTurnDoctorCheck(
      { VIBETERM_ROLES: 'relay', VIBETERM_TURN_BIND_HOST: '0.0.0.0' },
      async (url) => {
        urls.push(url);
        return { ok: true };
      },
      resolve
    );
    expect(urls).toEqual(['stun:127.0.0.1:3478']);
  });
});
