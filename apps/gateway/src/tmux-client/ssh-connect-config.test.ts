import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';

import { resolveSshConnectConfig } from './ssh-connect-config';

const now = '2026-04-16T00:00:00.000Z';

function createConfigRefDevice(): Device {
  return {
    id: 'device-config-ref',
    name: 'ssh-config-ref',
    type: 'ssh',
    authMode: 'configRef',
    sshConfigRef: 'prod-alias',
    session: 'tmex',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createAgentDevice(): Device {
  return {
    id: 'device-agent',
    name: 'ssh-agent',
    type: 'ssh',
    host: '10.77.88.5',
    port: 22,
    username: 'root',
    authMode: 'agent',
    session: 'tmex',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// 复现 pve/pve2 根因：非 configRef 模式残留的 sshConfigRef 不得劫持 host
function createPasswordDeviceWithStaleConfigRef(): Device {
  return {
    id: 'device-password-stale-ref',
    name: 'ssh-password',
    type: 'ssh',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authMode: 'password',
    passwordEnc: 'ENCRYPTED_PASSWORD',
    sshConfigRef: '~/.ssh/config',
    session: 'tmex',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('resolveSshConnectConfig', () => {
  test('resolves ssh config alias with SSH_AUTH_SOCK agent', async () => {
    const config = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: () => ({
        exitCode: 0,
        stdout: [
          'host prod-alias',
          'user root',
          'hostname 10.10.10.10',
          'port 2200',
          'identityagent SSH_AUTH_SOCK',
        ].join('\n'),
        stderr: '',
      }),
      fileExists: (path: string) => path === '/tmp/test-agent.sock',
      readTextFile: () => {
        throw new Error('readTextFile should not be called when agent is available');
      },
    });

    expect(config).toMatchObject({
      host: '10.10.10.10',
      port: 2200,
      username: 'root',
      agent: '/tmp/test-agent.sock',
    });
  });

  test('loads the first readable identity file from ssh config alias', async () => {
    const config = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
      },
      runSync: () => ({
        exitCode: 0,
        stdout: [
          'host prod-alias',
          'user alice',
          'hostname 10.20.30.40',
          'port 22',
          'identityfile ~/.ssh/first_key',
          'identityfile ~/.ssh/second_key',
        ].join('\n'),
        stderr: '',
      }),
      fileExists: (path: string) => path === '/Users/tester/.ssh/second_key',
      readTextFile: (path: string) => {
        expect(path).toBe('/Users/tester/.ssh/second_key');
        return 'PRIVATE_KEY_CONTENT';
      },
    });

    expect(config).toMatchObject({
      host: '10.20.30.40',
      port: 22,
      username: 'alice',
      privateKey: 'PRIVATE_KEY_CONTENT',
    });
  });

  test('agent mode falls back to implicit identity files with auth handler ordering', async () => {
    const config = await resolveSshConnectConfig(createAgentDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: (cmd) => {
        expect(cmd).toEqual(['ssh', '-G', '-p', '22', 'root@10.77.88.5']);
        return {
          exitCode: 0,
          stdout: [
            'host 10.77.88.5',
            'user root',
            'hostname 10.77.88.5',
            'port 22',
            'identityfile ~/.ssh/id_ed25519',
          ].join('\n'),
          stderr: '',
        };
      },
      fileExists: (path: string) =>
        path === '/tmp/test-agent.sock' || path === '/Users/tester/.ssh/id_ed25519',
      readTextFile: (path: string) => {
        expect(path).toBe('/Users/tester/.ssh/id_ed25519');
        return 'PRIVATE_KEY_CONTENT';
      },
    });

    expect(config).toMatchObject({
      host: '10.77.88.5',
      port: 22,
      username: 'root',
      agent: '/tmp/test-agent.sock',
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.authHandler).toEqual([
      {
        type: 'agent',
        username: 'root',
        agent: '/tmp/test-agent.sock',
      },
      {
        type: 'publickey',
        username: 'root',
        key: 'PRIVATE_KEY_CONTENT',
      },
    ]);
  });

  test('non-configRef mode ignores stale sshConfigRef and never resolves host via ssh -G', async () => {
    const config = await resolveSshConnectConfig(
      createPasswordDeviceWithStaleConfigRef(),
      async () => 'decrypted-password',
      {
        env: {
          HOME: '/Users/tester',
        },
        runSync: () => {
          throw new Error('ssh -G must not run for non-configRef auth modes');
        },
        fileExists: () => false,
        readTextFile: () => {
          throw new Error('readTextFile should not be called');
        },
      }
    );

    expect(config).toMatchObject({
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      password: 'decrypted-password',
    });
  });

  test('agent mode keeps current behavior when implicit identity file discovery fails', async () => {
    const config = await resolveSshConnectConfig(createAgentDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: (cmd) => {
        expect(cmd).toEqual(['ssh', '-G', '-p', '22', 'root@10.77.88.5']);
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'ssh lookup failed',
        };
      },
      fileExists: (path: string) => path === '/tmp/test-agent.sock',
      readTextFile: () => {
        throw new Error('readTextFile should not be called when ssh -G fails');
      },
    });

    expect(config).toMatchObject({
      host: '10.77.88.5',
      port: 22,
      username: 'root',
      agent: '/tmp/test-agent.sock',
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.authHandler).toBeUndefined();
  });

  test('agent mode keeps ssh -G identity file order for multiple readable keys', async () => {
    const config = await resolveSshConnectConfig(createAgentDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: (cmd) => {
        expect(cmd).toEqual(['ssh', '-G', '-p', '22', 'root@10.77.88.5']);
        return {
          exitCode: 0,
          stdout: [
            'host 10.77.88.5',
            'user root',
            'hostname 10.77.88.5',
            'port 22',
            'identityfile ~/.ssh/id_rsa',
            'identityfile ~/.ssh/id_ed25519',
          ].join('\n'),
          stderr: '',
        };
      },
      fileExists: (path: string) =>
        path === '/tmp/test-agent.sock' ||
        path === '/Users/tester/.ssh/id_rsa' ||
        path === '/Users/tester/.ssh/id_ed25519',
      readTextFile: (path: string) => {
        if (path === '/Users/tester/.ssh/id_rsa') {
          return 'RSA_PRIVATE_KEY_CONTENT';
        }
        if (path === '/Users/tester/.ssh/id_ed25519') {
          return 'ED25519_PRIVATE_KEY_CONTENT';
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });

    expect(config.authHandler).toEqual([
      {
        type: 'agent',
        username: 'root',
        agent: '/tmp/test-agent.sock',
      },
      {
        type: 'publickey',
        username: 'root',
        key: 'RSA_PRIVATE_KEY_CONTENT',
      },
      {
        type: 'publickey',
        username: 'root',
        key: 'ED25519_PRIVATE_KEY_CONTENT',
      },
    ]);
  });

  function baseDevice(overrides: Partial<Device> & Pick<Device, 'id' | 'authMode'>): Device {
    return {
      name: 'ssh',
      type: 'ssh',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      session: 'work',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  const silentDeps = {
    env: { HOME: '/Users/tester' },
    runSync: () => {
      throw new Error('ssh -G must not run');
    },
    fileExists: () => false,
    readTextFile: () => {
      throw new Error('readTextFile should not be called');
    },
  };

  test('password mode throws when passwordEnc is missing', async () => {
    await expect(
      resolveSshConnectConfig(
        baseDevice({ id: 'pw-missing', authMode: 'password' }),
        async () => '',
        silentDeps
      )
    ).rejects.toThrow('auth_password_missing');
  });

  test('key mode decrypts private key and optional passphrase with exact crypto context', async () => {
    const calls: Array<{ ciphertext: string; field: string }> = [];
    const config = await resolveSshConnectConfig(
      baseDevice({
        id: 'key-device',
        authMode: 'key',
        privateKeyEnc: 'ENC_KEY',
        privateKeyPassphraseEnc: 'ENC_PASS',
      }),
      async (ciphertext, context) => {
        calls.push({ ciphertext, field: context.field ?? '' });
        return `plain:${ciphertext}`;
      },
      silentDeps
    );

    expect(config).toMatchObject({
      host: '10.0.0.1',
      privateKey: 'plain:ENC_KEY',
      passphrase: 'plain:ENC_PASS',
    });
    expect(calls).toEqual([
      { ciphertext: 'ENC_KEY', field: 'private_key_enc' },
      { ciphertext: 'ENC_PASS', field: 'private_key_passphrase_enc' },
    ]);
  });

  test('key mode throws when privateKeyEnc is missing', async () => {
    await expect(
      resolveSshConnectConfig(
        baseDevice({ id: 'key-missing', authMode: 'key' }),
        async () => '',
        silentDeps
      )
    ).rejects.toThrow('auth_key_missing');
  });

  test('throws when host cannot be resolved', async () => {
    await expect(
      resolveSshConnectConfig(
        baseDevice({ id: 'no-host', authMode: 'password', host: undefined, passwordEnc: 'x' }),
        async () => '',
        silentDeps
      )
    ).rejects.toThrow('SSH device missing host');
  });

  test('configRef throws when sshConfigRef is empty', async () => {
    await expect(
      resolveSshConnectConfig(
        baseDevice({ id: 'cfg-empty', authMode: 'configRef', sshConfigRef: '  ' }),
        async () => '',
        silentDeps
      )
    ).rejects.toThrow('ssh_config_ref_missing');
  });

  test('configRef throws when ssh -G fails', async () => {
    await expect(
      resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
        ...silentDeps,
        runSync: () => ({ exitCode: 1, stdout: '', stderr: 'alias missing' }),
      })
    ).rejects.toThrow('ssh_config_ref_resolve_failed: alias missing');
  });

  test('configRef throws when hostname is missing from ssh -G output', async () => {
    await expect(
      resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
        ...silentDeps,
        runSync: () => ({ exitCode: 0, stdout: 'user root\nport 22', stderr: '' }),
      })
    ).rejects.toThrow('ssh_config_ref_invalid');
  });

  test('configRef IdentityAgent none falls through to identity file', async () => {
    const config = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: { HOME: '/Users/tester' },
      runSync: () => ({
        exitCode: 0,
        stdout: [
          'hostname 10.1.2.3',
          'port 22',
          'user root',
          'identityagent none',
          'identityfile ~/.ssh/id_ed25519',
        ].join('\n'),
        stderr: '',
      }),
      fileExists: (path) => path === '/Users/tester/.ssh/id_ed25519',
      readTextFile: () => 'FROM_IDENTITY_FILE',
    });
    expect(config).toMatchObject({
      host: '10.1.2.3',
      privateKey: 'FROM_IDENTITY_FILE',
    });
    expect(config.agent).toBeUndefined();
  });

  test('configRef IdentityAgent path and $SSH_AUTH_SOCK are honored', async () => {
    const viaPath = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: { HOME: '/Users/tester' },
      runSync: () => ({
        exitCode: 0,
        stdout: ['hostname 10.1.2.3', 'user root', 'identityagent ~/.ssh/agent.sock'].join('\n'),
        stderr: '',
      }),
      fileExists: (path) => path === '/Users/tester/.ssh/agent.sock',
      readTextFile: () => {
        throw new Error('should not read identity file');
      },
    });
    expect(viaPath.agent).toBe('/Users/tester/.ssh/agent.sock');

    const viaEnv = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: { HOME: '/Users/tester', SSH_AUTH_SOCK: '/tmp/env-agent.sock' },
      runSync: () => ({
        exitCode: 0,
        stdout: ['hostname 10.1.2.3', 'user root', 'identityagent $SSH_AUTH_SOCK'].join('\n'),
        stderr: '',
      }),
      fileExists: () => false,
      readTextFile: () => {
        throw new Error('should not read identity file');
      },
    });
    expect(viaEnv.agent).toBe('/tmp/env-agent.sock');
  });

  test('configRef throws when no agent or identity file is available', async () => {
    await expect(
      resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
        env: { HOME: '/Users/tester' },
        runSync: () => ({
          exitCode: 0,
          stdout: 'hostname 10.1.2.3\nuser root',
          stderr: '',
        }),
        fileExists: () => false,
        readTextFile: () => {
          throw new Error('readTextFile should not be called');
        },
      })
    ).rejects.toThrow('ssh_config_ref_auth_missing');
  });

  test('auto mode prefers env agent, then encrypted key, then password', async () => {
    const withAgent = await resolveSshConnectConfig(
      baseDevice({ id: 'auto-agent', authMode: 'auto', passwordEnc: 'ENC_PW' }),
      async () => 'plain-password',
      { ...silentDeps, env: { HOME: '/Users/tester', SSH_AUTH_SOCK: '/tmp/auto.sock' } }
    );
    expect(withAgent.agent).toBe('/tmp/auto.sock');
    expect(withAgent.password).toBe('plain-password');

    const decryptCalls: string[] = [];
    const withKey = await resolveSshConnectConfig(
      baseDevice({
        id: 'auto-key',
        authMode: 'auto',
        privateKeyEnc: 'ENC_KEY',
        passwordEnc: 'ENC_PW',
      }),
      async (ciphertext) => {
        decryptCalls.push(ciphertext);
        return `plain:${ciphertext}`;
      },
      silentDeps
    );
    expect(withKey).toMatchObject({ privateKey: 'plain:ENC_KEY' });
    expect(withKey.password).toBeUndefined();
    expect(decryptCalls).toEqual(['ENC_KEY']);

    const withPassword = await resolveSshConnectConfig(
      baseDevice({ id: 'auto-pw', authMode: 'auto', passwordEnc: 'ENC_PW' }),
      async () => 'plain-password',
      silentDeps
    );
    expect(withPassword.password).toBe('plain-password');
  });

  test('auto mode throws when no auth material is available', async () => {
    await expect(
      resolveSshConnectConfig(
        baseDevice({ id: 'auto-none', authMode: 'auto' }),
        async () => '',
        silentDeps
      )
    ).rejects.toThrow('auth_auto_missing');
  });
});
