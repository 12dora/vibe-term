export const ACCOUNT_PASSWORD_MIN_LENGTH = 12;

export type AccountPasswordIssue = 'too_short' | 'too_simple';

const MIN_USERNAME_LENGTH = 3;
const DOMINANT_CHARACTER_RATIO = 0.6;
const MIN_BLOCK_REPEATS = 3;

const SEQUENCE_ALPHABETS = [
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz',
  '1234567890qwertyuiopasdfghjklzxcvbnm',
  'qwertyuiopasdfghjklzxcvbnm',
] as const;

const COMMON_PASSWORDS = new Set([
  '1234567890ab',
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789abc',
  '1q2w3e4r5t6y',
  '1q2w3e4r5t6y7u8i',
  '1qaz2wsx3edc',
  '1qaz2wsx3edc4rfv',
  'abc123456789',
  'abcd1234abcd',
  'admin1234567',
  'admin12345678',
  'administrator',
  'changeme1234',
  'changeme12345',
  'correcthorsebatterystaple',
  'dragon123456',
  'football1234',
  'iloveyou1234',
  'iloveyou12345',
  'letmein12345',
  'letmein123456',
  'monkey123456',
  'p@ssw0rd1234',
  'p@ssw0rd12345',
  'passw0rd1234',
  'passw0rd12345',
  'password1234',
  'password12345',
  'password123456',
  'password1234567',
  'password@1234',
  'password!1234',
  'qazwsxedc123',
  'qwerty123456',
  'qwerty1234567',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwertyuiop1234',
  'welcome12345',
  'welcome123456',
  'zaq12wsxcde3',
  'zxcvbnm12345',
]);

function dominantCharacterTooLarge(chars: string[]): boolean {
  const counts = new Map<string, number>();
  let max = 0;
  for (const char of chars) {
    const next = (counts.get(char) ?? 0) + 1;
    counts.set(char, next);
    if (next > max) max = next;
  }
  return max / chars.length >= DOMINANT_CHARACTER_RATIO;
}

function isCodePointRun(value: string): boolean {
  const points = Array.from(value, (char) => char.codePointAt(0) ?? 0);
  const step = (points[1] ?? 0) - (points[0] ?? 0);
  if (step !== 1 && step !== -1) return false;
  return points.every((point, index) => index === 0 || point - (points[index - 1] ?? 0) === step);
}

function reversed(value: string): string {
  return Array.from(value).reverse().join('');
}

function isAlphabetRun(lower: string): boolean {
  return SEQUENCE_ALPHABETS.some((alphabet) => {
    const haystack = alphabet.repeat(Math.ceil(lower.length / alphabet.length) + 1);
    return haystack.includes(lower) || haystack.includes(reversed(lower));
  });
}

function isRepeatedBlock(chars: string[]): boolean {
  const maxPeriod = Math.floor(chars.length / MIN_BLOCK_REPEATS);
  for (let period = 1; period <= maxPeriod; period++) {
    let repeats = true;
    for (let i = period; i < chars.length; i++) {
      if (chars[i] !== chars[i - period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

export function checkAccountPassword(
  password: string,
  options: { username?: string } = {}
): AccountPasswordIssue | null {
  const normalized = password.normalize('NFKC');
  const chars = Array.from(normalized);
  if (chars.length < ACCOUNT_PASSWORD_MIN_LENGTH) return 'too_short';

  const lower = normalized.toLowerCase();
  const lowerChars = Array.from(lower);
  if (dominantCharacterTooLarge(chars)) return 'too_simple';
  if (isCodePointRun(lower) || isAlphabetRun(lower)) return 'too_simple';
  if (isRepeatedBlock(lowerChars)) return 'too_simple';
  if (COMMON_PASSWORDS.has(lower)) return 'too_simple';

  const username = options.username?.normalize('NFKC').trim().toLowerCase();
  if (username && Array.from(username).length >= MIN_USERNAME_LENGTH && lower.includes(username)) {
    return 'too_simple';
  }
  return null;
}
