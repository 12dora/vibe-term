import { describe, expect, test } from 'bun:test';
import { setLang, t } from '../i18n';
import { relayTurnDoctorCheck } from './doctor-turn';

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

    const listening = await relayTurnDoctorCheck({ VIBETERM_ROLES: 'relay' }, async () => ({
      ok: true,
    }));
    expect(listening).toMatchObject({
      id: 'turn',
      level: 'pass',
      message: t('doctor.turn.builtinListening', { port: 3478 }),
    });
    expect(listening?.detail).toContain('UDP 49160-49259');

    const down = await relayTurnDoctorCheck({ VIBETERM_ROLES: 'relay' }, async () => ({
      ok: false,
    }));
    expect(down?.level).toBe('warn');
    expect(down?.message).toBe(t('doctor.turn.builtinNotListening', { port: 3478 }));
  });
});
