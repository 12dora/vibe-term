import { describe, expect, test } from 'bun:test';
import { resolveTmuxBin } from './config';

// config 是模块级常量（import 时快照 process.env），
// 用 query-busting 动态 import 在不同 env 下重新求值。
let bustCounter = 0;

async function loadConfigWith(env: Record<string, string | undefined>): Promise<{
  bindHost: string;
  tmuxBin: string;
  gatewayOwnerToken: string | null;
}> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    bustCounter += 1;
    const mod = (await import(`./config.ts?bust=${bustCounter}`)) as {
      config: { bindHost: string; tmuxBin: string; gatewayOwnerToken: string | null };
    };
    return mod.config;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('config.bindHost', () => {
  test('未设 TMEX_BIND_HOST 时默认 0.0.0.0', async () => {
    const config = await loadConfigWith({ TMEX_BIND_HOST: undefined });
    expect(config.bindHost).toBe('0.0.0.0');
  });

  test('TMEX_BIND_HOST 覆盖默认值（仅 localhost 绑定）', async () => {
    const config = await loadConfigWith({ TMEX_BIND_HOST: '127.0.0.1' });
    expect(config.bindHost).toBe('127.0.0.1');
  });

  test('支持任意主机地址值', async () => {
    const config = await loadConfigWith({ TMEX_BIND_HOST: '::1' });
    expect(config.bindHost).toBe('::1');
  });
});

describe('config.tmuxBin', () => {
  test('未设置时保持开源 Gateway 的 PATH 兼容默认值', async () => {
    const config = await loadConfigWith({ TMEX_TMUX_BIN: undefined });
    expect(config.tmuxBin).toBe('tmux');
  });

  test('接受 TMEX_TMUX_BIN 的绝对路径', async () => {
    const config = await loadConfigWith({ TMEX_TMUX_BIN: '/opt/vibex/bin/tmux' });
    expect(config.tmuxBin).toBe('/opt/vibex/bin/tmux');
  });

  test('拒绝相对 TMEX_TMUX_BIN', async () => {
    await expect(loadConfigWith({ TMEX_TMUX_BIN: './bundled/tmux' })).rejects.toThrow(
      'TMEX_TMUX_BIN must be an absolute path'
    );
  });

  test('Windows 使用 Windows 路径语义接受盘符与 UNC 绝对路径', () => {
    expect(
      resolveTmuxBin({ TMEX_TMUX_BIN: 'C:\\Program Files\\tmex\\psmux.exe' }, 'win32', true)
    ).toBe('C:\\Program Files\\tmex\\psmux.exe');
    expect(resolveTmuxBin({ TMEX_TMUX_BIN: '\\\\server\\share\\psmux.exe' }, 'win32', true)).toBe(
      '\\\\server\\share\\psmux.exe'
    );
  });

  test('managed Windows 必须由调用方提供绝对 multiplexer 路径', () => {
    expect(() => resolveTmuxBin({}, 'win32', true)).toThrow(
      'TMEX_TMUX_BIN must be set to an absolute path on managed Windows'
    );
    expect(() =>
      resolveTmuxBin({ TMEX_TMUX_BIN: '.\\resources\\psmux.exe' }, 'win32', true)
    ).toThrow('TMEX_TMUX_BIN must be an absolute path');
    expect(resolveTmuxBin({}, 'win32', false)).toBe('tmux');
  });
});

describe('config.gatewayOwnerToken', () => {
  test('is optional for the open-source standalone Gateway', async () => {
    const config = await loadConfigWith({ TMEX_GATEWAY_OWNER_TOKEN: undefined });
    expect(config.gatewayOwnerToken).toBeNull();
  });

  test('accepts and normalizes a 32-byte managed owner token', async () => {
    const config = await loadConfigWith({ TMEX_GATEWAY_OWNER_TOKEN: 'AB'.repeat(32) });
    expect(config.gatewayOwnerToken).toBe('ab'.repeat(32));
  });

  test('rejects malformed owner tokens', async () => {
    await expect(loadConfigWith({ TMEX_GATEWAY_OWNER_TOKEN: 'not-a-token' })).rejects.toThrow(
      'exactly 32 bytes'
    );
  });
});
