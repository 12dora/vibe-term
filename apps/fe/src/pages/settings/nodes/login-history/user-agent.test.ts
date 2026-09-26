import { describe, expect, test } from 'bun:test';
import { userAgentSummary } from './user-agent';

describe('userAgentSummary', () => {
  test('common desktop and mobile browsers', () => {
    expect(
      userAgentSummary(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
      )
    ).toBe('Chrome · macOS');
    expect(
      userAgentSummary(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
      )
    ).toBe('Edge · Windows');
    expect(
      userAgentSummary(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari · iOS');
    expect(
      userAgentSummary('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')
    ).toBe('Firefox · Linux');
    expect(
      userAgentSummary(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
      )
    ).toBe('Chrome · Android');
    expect(
      userAgentSummary(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Chrome · iOS');
  });

  test('CLI and tooling', () => {
    expect(userAgentSummary('vibeterm-cli/2.10.0 (darwin; arm64)')).toBe('VibeTerm CLI · macOS');
    expect(userAgentSummary('Bun/1.3.0')).toBe('Bun');
    expect(userAgentSummary('curl/8.7.1')).toBe('curl');
  });

  test('unknown or empty', () => {
    expect(userAgentSummary(null)).toBeNull();
    expect(userAgentSummary('   ')).toBeNull();
    expect(userAgentSummary('SomethingElse/1.0')).toBeNull();
  });
});
