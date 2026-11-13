import { describe, expect, test } from 'bun:test';
import { ACCOUNT_PASSWORD_MIN_LENGTH, checkAccountPassword } from './password-policy';

describe('checkAccountPassword', () => {
  test('最小长度是 12', () => {
    expect(ACCOUNT_PASSWORD_MIN_LENGTH).toBe(12);
  });

  const accepted = [
    'hunter2hunter2',
    'correct horse battery',
    'Tr0ub4dor&3xK9!',
    'xK9#mP2$vL7@qR4n',
    'k3Qz8TnW5vBx',
    '我的密码是很长的一句话才对',
    'пароль-для-входа-2024',
    'a1b2c3d4e5f6g7h8',
  ];
  for (const password of accepted) {
    test(`接受 ${password}`, () => {
      expect(checkAccountPassword(password, { username: 'alice' })).toBeNull();
    });
  }

  const tooShort = ['', 'short', '1234567', 'abcdefghijk', 'xK9#mP2$vL7', '密码太短了'];
  for (const password of tooShort) {
    test(`过短 ${JSON.stringify(password)}`, () => {
      expect(checkAccountPassword(password)).toBe('too_short');
    });
  }

  test('长度按 NFKC 归一后的码点数计', () => {
    expect(checkAccountPassword('😀😀😀😀😀😀😀😀😀😀😀')).toBe('too_short');
    expect(checkAccountPassword('😀a😁b😂c😃d😄e😅f')).toBeNull();
    expect(checkAccountPassword('ｋ３Ｑｚ８ＴｎＷ５ｖＢ')).toBe('too_short');
    expect(checkAccountPassword('ｋ３Ｑｚ８ＴｎＷ５ｖＢｘ')).toBeNull();
  });

  const tooSimple = [
    'aaaaaaaaaaaa',
    'aaaaaaaaaaaaaab',
    '1111111111112',
    'abababababab',
    'abcabcabcabc',
    '121212121212',
    'abcdabcdabcd',
    'x9y8x9y8x9y8',
    '123456789012',
    '1234567890123456',
    '987654321098',
    'abcdefghijkl',
    'zyxwvutsrqpo',
    'xyzabcdefghi',
    'qwertyuiopas',
    'qwertyuiopasdfghjkl',
    'asdfghjklzxc',
    'zxcvbnmqwert',
    '1234567890qwerty',
    'ABCDEFGHIJKL',
    'ＡＢＣＤＥＦＧＨＩＪＫＬ',
    'password1234',
    'PassWord1234',
    'Qwerty123456',
    'iloveyou1234',
    '1q2w3e4r5t6y',
    'passw0rd1234',
    'Correcthorsebatterystaple',
    'ｐａｓｓｗｏｒｄ１２３４',
  ];
  for (const password of tooSimple) {
    test(`过于简单 ${password}`, () => {
      expect(checkAccountPassword(password)).toBe('too_simple');
    });
  }

  test('包含用户名（不分大小写、用户名至少 3 位）', () => {
    expect(checkAccountPassword('xK9#alice#mP2$vL', { username: 'alice' })).toBe('too_simple');
    expect(checkAccountPassword('xK9#ALICE#mP2$vL', { username: 'Alice' })).toBe('too_simple');
    expect(checkAccountPassword('xK9#mP2$vL7@qR4n', { username: 'alice' })).toBeNull();
    expect(checkAccountPassword('xK9#al#mP2$vL7', { username: 'al' })).toBeNull();
    expect(checkAccountPassword('xK9#alice#mP2$vL')).toBeNull();
    expect(checkAccountPassword('xK9#mP2$vL7@qR4n', { username: '' })).toBeNull();
  });

  test('过短优先于过于简单', () => {
    expect(checkAccountPassword('aaaa')).toBe('too_short');
    expect(checkAccountPassword('abc', { username: 'abc' })).toBe('too_short');
  });
});
