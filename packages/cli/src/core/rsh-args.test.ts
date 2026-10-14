import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import { type RshInvocation, parseDestination, parseRshArgs, resolveSendEnv } from './rsh-args';

function run(args: string[], env: Record<string, string> = {}): RshInvocation {
  const parsed = parseRshArgs(args, env);
  if (parsed.kind !== 'run') throw new Error('expected a run invocation');
  return parsed.invocation;
}

function rejection(args: string[]): string {
  try {
    parseRshArgs(args, {});
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`expected a rejection for ${args.join(' ')}`);
}

describe('rsh destination and command words', () => {
  test('bare host without a command opens the login shell', () => {
    const invocation = run(['node']);
    expect(invocation.target).toBe('node');
    expect(invocation.command).toEqual({ kind: 'login' });
    expect(invocation.tty).toBe('auto');
    expect(invocation.stdin).toBe('auto');
  });

  test('command words are joined with single spaces like ssh', () => {
    expect(run(['node', 'ls', '-l', '/tmp']).command).toEqual({
      kind: 'shell',
      script: 'ls -l /tmp',
    });
    expect(run(['node', "git-upload-pack '/repo'"]).command).toEqual({
      kind: 'shell',
      script: "git-upload-pack '/repo'",
    });
    expect(run(['node', 'echo', 'a  b', '', 'c']).command).toEqual({
      kind: 'shell',
      script: 'echo a  b  c',
    });
  });

  test('an empty or blank command string behaves like no command', () => {
    expect(run(['node', '']).command).toEqual({ kind: 'login' });
  });

  test('user@host keeps the user separately and splits at the last @', () => {
    expect(run(['root@node']).user).toBe('root');
    expect(run(['root@node']).target).toBe('node');
    expect(run(['a@b@node']).user).toBe('a@b');
    expect(run(['node']).user).toBeNull();
  });

  test('-l supplies the user, user@ wins over it', () => {
    expect(run(['-l', 'alice', 'node']).user).toBe('alice');
    expect(run(['-lalice', 'node']).user).toBe('alice');
    expect(run(['-l', 'alice', 'bob@node']).user).toBe('bob');
  });

  test('node/device targets pass through unchanged', () => {
    expect(run(['office/build-box', 'uptime']).target).toBe('office/build-box');
  });

  test('ssh:// URLs: user, port and a device path', () => {
    expect(parseDestination('ssh://node')).toEqual({ user: null, target: 'node' });
    expect(parseDestination('ssh://root@node:2222')).toEqual({ user: 'root', target: 'node' });
    expect(parseDestination('ssh://root@node:2222/')).toEqual({ user: 'root', target: 'node' });
    expect(parseDestination('ssh://node/build%20box')).toEqual({
      user: null,
      target: 'node/build box',
    });
    expect(run(['ssh://u@node/dev', 'true']).target).toBe('node/dev');
    expect(() => parseDestination('ssh://')).toThrow(UsageError);
  });

  test('a destination starting with - is refused', () => {
    expect(rejection(['--', '-evil'])).toContain('目标无效');
  });

  test('missing destination is a usage error', () => {
    expect(rejection([])).toContain('缺少目标主机');
    expect(rejection(['-q', '-T'])).toContain('缺少目标主机');
  });
});

describe('rsh option grammar', () => {
  test('clusters, attached and separate option arguments', () => {
    const invocation = run([
      '-xq',
      '-p22',
      '-l',
      'root',
      '-oBatchMode=yes',
      '-i',
      'key',
      'node',
      'id',
    ]);
    expect(invocation.quiet).toBe(true);
    expect(invocation.user).toBe('root');
    expect(invocation.command).toEqual({ kind: 'shell', script: 'id' });
  });

  test('a cluster ends at the first valued flag and takes the rest as its argument', () => {
    // -vlroot 等于 -v -l root
    const invocation = run(['-vlroot', 'node']);
    expect(invocation.verbose).toBe(1);
    expect(invocation.user).toBe('root');
  });

  test('options are also parsed after the destination until the first non-option word', () => {
    const invocation = run([
      'node',
      '-T',
      '-o',
      'SetEnv=A=1',
      'rsync',
      '--server',
      '-vlogDtpre.iLsfxCIvu',
      '.',
      '/dst/',
    ]);
    expect(invocation.tty).toBe('no');
    expect(invocation.env).toEqual({ A: '1' });
    expect(invocation.command).toEqual({
      kind: 'shell',
      script: 'rsync --server -vlogDtpre.iLsfxCIvu . /dst/',
    });
  });

  test('flags inside the command are not options', () => {
    const invocation = run(['node', 'ls', '-l', '-t', '-q']);
    expect(invocation.tty).toBe('auto');
    expect(invocation.quiet).toBe(false);
    expect(invocation.command).toEqual({ kind: 'shell', script: 'ls -l -t -q' });
  });

  test('-- ends options before and after the destination', () => {
    expect(run(['-q', '--', 'node', 'uptime']).command).toEqual({
      kind: 'shell',
      script: 'uptime',
    });
    expect(run(['node', '--', '-n', 'x']).command).toEqual({ kind: 'shell', script: '-n x' });
    expect(run(['node', '--', '-n', 'x']).stdin).toBe('auto');
  });

  test('a lone - is a word, not an option', () => {
    expect(run(['node', '-']).command).toEqual({ kind: 'shell', script: '-' });
  });

  test('option without its argument and unknown options are errors', () => {
    expect(rejection(['node', '-l'])).toContain('-l 缺少参数');
    expect(rejection(['-Z', 'node'])).toContain('未知选项：-Z');
    expect(rejection(['--entry', 'x', 'node'])).toContain('未知选项：--entry');
  });

  test('-V short-circuits to version output', () => {
    expect(parseRshArgs(['-V'], {})).toEqual({ kind: 'version' });
    expect(parseRshArgs(['-qV', 'node'], {})).toEqual({ kind: 'version' });
    expect(parseRshArgs(['node', '-V'], {})).toEqual({ kind: 'version' });
  });

  test('-v is repeatable, -q and -n are recorded', () => {
    expect(run(['-vvv', 'node']).verbose).toBe(3);
    expect(run(['-v', '-v', 'node']).verbose).toBe(2);
    expect(run(['-q', 'node']).quiet).toBe(true);
    expect(run(['-n', 'node']).stdin).toBe('none');
  });

  test('accepted-and-ignored options never change the invocation', () => {
    const baseline = run(['node', 'true']);
    const noisy = run([
      ...'-4 -6 -A -a -C -g -K -k -M -X -x -Y -y'.split(' '),
      ...['-p', '22', '-i', '/k', '-F', '/dev/null', '-c', 'aes', '-m', 'hmac'],
      ...['-b', '0.0.0.0', '-E', '/tmp/log', '-e', '^', '-S', '/tmp/ctl'],
      ...['-B', 'eth0', '-I', 'p11', '-P', 'tag', 'node', 'true'],
    ]);
    expect(noisy).toEqual(baseline);
  });
});

describe('rsh tty and stdin flags', () => {
  test('-t / -tt / -T and RequestTTY', () => {
    expect(run(['-t', 'node']).tty).toBe('force');
    expect(run(['-tt', 'node']).tty).toBe('always');
    expect(run(['-t', '-t', 'node']).tty).toBe('always');
    expect(run(['-T', 'node']).tty).toBe('no');
    expect(run(['-tT', 'node']).tty).toBe('no');
    expect(run(['-Tt', 'node']).tty).toBe('force');
    expect(run(['-oRequestTTY=yes', 'node']).tty).toBe('force');
    expect(run(['-o', 'RequestTTY=force', 'node']).tty).toBe('always');
    expect(run(['-o', 'RequestTTY no', 'node']).tty).toBe('no');
    expect(run(['-o', 'RequestTTY=auto', 'node']).tty).toBe('auto');
  });

  test('explicit -t/-T beat -o RequestTTY, the first -o wins among options', () => {
    expect(run(['-oRequestTTY=no', '-t', 'node']).tty).toBe('force');
    expect(run(['-oRequestTTY=no', '-oRequestTTY=yes', 'node']).tty).toBe('no');
  });

  test('a bad RequestTTY value is rejected', () => {
    expect(rejection(['-oRequestTTY=sometimes', 'node'])).toContain('RequestTTY');
  });
});

describe('rsh subsystem', () => {
  test('-s sftp, as scp and sftp invoke it', () => {
    const options = '-x -oPermitLocalCommand=no -oClearAllForwardings=yes -oRemoteCommand=none';
    const invocation = run([
      ...options.split(' '),
      ...['-oRequestTTY=no', '-oForwardAgent=no', '-s', '--', 'node', 'sftp'],
    ]);
    expect(invocation.command).toEqual({ kind: 'subsystem', name: 'sftp' });
    expect(invocation.tty).toBe('no');
  });

  test('-s after the destination works too', () => {
    expect(run(['node', '-s', 'sftp']).command).toEqual({ kind: 'subsystem', name: 'sftp' });
  });

  test('other subsystems and a missing name are errors', () => {
    expect(rejection(['-s', 'node', 'netconf'])).toContain('不支持子系统 netconf');
    expect(rejection(['-s', 'node'])).toContain('-s 需要子系统名');
  });
});

describe('rsh -o handling', () => {
  test('RemoteCommand is used only without command words and not when none', () => {
    expect(run(['-oRemoteCommand=uptime -p', 'node']).command).toEqual({
      kind: 'shell',
      script: 'uptime -p',
    });
    expect(run(['-oRemoteCommand=none', 'node']).command).toEqual({ kind: 'login' });
    expect(run(['-oRemoteCommand=uptime', 'node', 'whoami']).command).toEqual({
      kind: 'shell',
      script: 'whoami',
    });
    expect(run(['-oRemoteCommand=none', '-oRemoteCommand=uptime', 'node']).command).toEqual({
      kind: 'login',
    });
  });

  test('SetEnv: several variables, first occurrence of a name wins, equals signs kept', () => {
    expect(run(['-o', 'SetEnv=A=1 B=x=y', '-oSetEnv=A=2 C=3', 'node']).env).toEqual({
      A: '1',
      B: 'x=y',
      C: '3',
    });
    expect(run(['-o', 'SetEnv A=1', 'node']).env).toEqual({ A: '1' });
    expect(rejection(['-oSetEnv=1BAD=x', 'node'])).toContain('SetEnv');
    expect(rejection(['-oSetEnv=NOVALUE', 'node'])).toContain('SetEnv');
  });

  test('SendEnv forwards matching local variables, SetEnv overrides them', () => {
    const env = { GIT_PROTOCOL: 'version=2', LANG: 'C', GIT_X: '1', EMPTY: '' };
    expect(run(['-o', 'SendEnv=GIT_PROTOCOL', 'node', 'git-upload-pack /r'], env).env).toEqual({
      GIT_PROTOCOL: 'version=2',
    });
    expect(run(['-oSendEnv=GIT_* -GIT_X', 'node'], env).env).toEqual({ GIT_PROTOCOL: 'version=2' });
    expect(run(['-oSendEnv=EMPTY MISSING', 'node'], env).env).toEqual({ EMPTY: '' });
    expect(run(['-oSendEnv=LANG', '-oSetEnv=LANG=en', 'node'], env).env).toEqual({ LANG: 'en' });
  });

  test('resolveSendEnv skips invalid names and honors ? globs', () => {
    expect(resolveSendEnv(['A?'], { AB: '1', A: '2', 'A-B': '3' })).toEqual({ AB: '1' });
  });

  test('everything else is accepted and ignored', () => {
    const baseline = run(['node', 'true']);
    const options = [
      '-oBatchMode=yes -oStrictHostKeyChecking=no -oServerAliveInterval=15 -oControlMaster=auto',
      '-oControlPath=/tmp/x -oControlPersist=60 -oPermitLocalCommand=no -oBatchMode',
      '-oClearAllForwardings=yes -oForwardAgent=no -oConnectTimeout=5 -oLogLevel=ERROR',
      '-oUserKnownHostsFile=/dev/null',
    ].join(' ');
    const ignored = run([...options.split(' '), '-o', 'StrictHostKeyChecking no', 'node', 'true']);
    expect(ignored).toEqual(baseline);
  });
});

describe('rsh -G', () => {
  function config(args: string[], env: Record<string, string> = {}) {
    const parsed = parseRshArgs(args, env);
    if (parsed.kind !== 'config') throw new Error('expected a config dump');
    return parsed.config;
  }

  test('reports hostname, user and port without running anything', () => {
    expect(config(['-G', 'localhost'], { USER: 'me' })).toEqual({
      hostname: 'localhost',
      user: 'me',
      port: 22,
    });
  });

  test('user@host, -l, -p and node/device targets are reflected', () => {
    expect(config(['-G', 'bob@office/box']).user).toBe('bob');
    expect(config(['-G', '-l', 'alice', 'node']).user).toBe('alice');
    expect(config(['-p', '2222', '-G', 'node']).port).toBe(2222);
    expect(config(['-G', 'node']).hostname).toBe('node');
    expect(config(['-G', 'office/box']).hostname).toBe('office/box');
  });

  test('falls back to LOGNAME, then a fixed name', () => {
    expect(config(['-G', 'node'], { LOGNAME: 'ln' }).user).toBe('ln');
    expect(config(['-G', 'node']).user).toBe('vibeterm');
  });

  test('still needs a destination', () => {
    expect(rejection(['-G'])).toContain('缺少目标主机');
  });
});

describe('rsh rejections', () => {
  const CASES: Array<[string, string[], string]> = [
    ['-L', ['-L', '80:localhost:80', 'node'], 'vibeterm forward'],
    ['-R', ['-R', '80:localhost:80', 'node'], 'vibeterm forward'],
    ['-D', ['-D', '1080', 'node'], 'vibeterm forward'],
    ['-W', ['-W', 'host:22', 'node'], 'vibeterm forward'],
    ['-N', ['-N', 'node'], 'vibeterm forward'],
    ['-J', ['-J', 'jump', 'node'], '跳板机'],
    ['-O', ['-O', 'check', 'node'], '控制命令'],
    ['-f', ['-f', 'node', 'sleep', '1'], '后台'],
    ['-Q', ['-Q', 'cipher'], '算法'],
    ['-w', ['-w', '0:0', 'node'], 'tun'],
  ];

  for (const [flag, args, fragment] of CASES) {
    test(`${flag} is refused with a clear message`, () => {
      const message = rejection(args);
      expect(message).toContain(`不支持 ${flag}`);
      expect(message).toContain(fragment);
    });
  }

  test('forwarding flags are refused inside clusters and attached forms', () => {
    expect(rejection(['-xL80:h:80', 'node'])).toContain('不支持 -L');
    expect(rejection(['-fN', 'node'])).toContain('不支持 -f');
  });

  test('rejected flags after the destination are refused too, but not inside the command', () => {
    expect(rejection(['node', '-N'])).toContain('不支持 -N');
    expect(run(['node', 'ssh', '-N', 'x']).command).toEqual({ kind: 'shell', script: 'ssh -N x' });
  });
});
