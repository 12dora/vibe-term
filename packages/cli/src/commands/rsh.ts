// `vibeterm rsh`：OpenSSH 兼容的客户端入口，供 rsync / git / scp 等把 `ssh` 换成它。

import { GLOBAL_FLAGS } from '../core/args';
import type { CliContext } from '../core/context';
import { InterruptError } from '../core/errors';
import { exitCodeOf } from '../core/exec-channel-result';
import { reportPrefixedFailure } from '../core/failure-report';
import { Output } from '../core/output';
import { type RemoteRunOptions, runRemote } from '../core/remote-run';
import { type RshInvocation, parseRshArgs } from '../core/rsh-args';
import { cliVersion } from '../version';
import type { Command } from './types';

/** ssh 约定：本地侧（用法、认证、网络、找不到）的失败一律 255，与远端退出码区分。 */
export const RSH_FAILURE_EXIT = 255;
const RSH_ERROR_PREFIX = 'vibeterm rsh';

/** 测试替换点：单测不依赖 runRemote 的内部实现。 */
export const rshDeps = { runRemote };

const USAGE = `用法：
  vibeterm rsh [选项] [用户@]<目标> [命令 [参数…]]
  vibeterm-rsh [选项] [用户@]<目标> [命令 [参数…]]     # 同一个程序，给只能填「程序路径」的工具用

OpenSSH 兼容的客户端入口：把 rsync、git、scp、docker 等依赖 ssh 的工具里的 ssh 换成
vibeterm rsh，即可经 vibeterm 在节点上执行命令。参数语法与 ssh 相同（旗标可成簇，选项可出现在
目标之后，-- 结束选项）。<目标> 为 <节点>、<节点>/<设备> 或入口上的设备名，也可写成
ssh://[用户@]节点[:端口][/设备]。命令词以单个空格拼接后交给节点用户的 shell 执行；不带命令则
打开登录 shell。stdin / stdout / stderr 原样透传（二进制安全、无大小上限），退出码与远端一致，
被信号终止时为 128+信号号；vibeterm 一侧的失败一律以 255 退出并在 stderr 打印
「vibeterm rsh: 原因」。

示例：
  rsync -a -e 'vibeterm rsh' --rsync-path='sudo rsync' node:/data/dir/ ./dir/
  GIT_SSH_COMMAND='vibeterm rsh' git clone node:/srv/repo.git
  scp -S vibeterm-rsh node:/etc/hosts ./hosts
  vibeterm rsh node 'pg_dump -Fc db' > db.dump
  vibeterm rsh node 'bash -s' <<'EOF'
  set -e; echo "$HOSTNAME"
  EOF

选项：
  -t / -tt / -T      分配 PTY / 强制分配 / 不分配（也可 -o RequestTTY=yes|force|no|auto）
  -n                 不转发 stdin（等价 < /dev/null）
  -s                 子系统模式，命令词为子系统名；目前只支持 sftp（scp、sftp 使用）
  -q / -v / -V       静默 vibeterm 自己的提示 / 打印详情（可重复）/ 打印版本
  -G                 打印最小的 OpenSSH 风格配置（user / hostname / port）后退出，供 git 识别
  -o SetEnv=K=V      给远端进程设置环境变量；-o SendEnv=PATTERN 转发本机同名变量
  -o RemoteCommand=C 未给命令词时执行 C
  其余 -o 选项，以及 -4 -6 -A -a -C -g -K -k -M -X -x -Y -y、-p -l -i -F -c -m -b -E -e -S -B -I -P，
  接受并忽略。-L -R -D -W -J -O -f -N -Q -w 不支持（端口转发请使用 vibeterm forward）。

配置：命令名之后的词一律按 ssh 参数解析，--entry、--node 等 vibeterm 全局旗标只能写在 rsh 之前
（vibeterm --entry <url> rsh …），或改用环境变量：
  VIBETERM_ENTRY          网关入口地址
  VIBETERM_SESSION_FILE   会话文件路径
  VIBETERM_TOKENS_FILE    访问令牌文件路径（无人值守场景，见 vibeterm token）`;

/**
 * 命令名之前的全局旗标（`vibeterm --entry X rsh …`）会和命令名之后的词一起交到这里，
 * 无法区分；ssh 没有长选项，所以开头那段 `--<全局旗标>` 照常交给派发层，其余整体作为不透明载荷。
 */
export function preprocessRshArgv(argv: readonly string[]): string[] {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '-h') {
      index += 1;
      continue;
    }
    if (!token.startsWith('--') || token === '--') break;
    const kind = GLOBAL_FLAGS[token.slice(2).split('=')[0]];
    if (!kind) break;
    index += kind !== 'boolean' && !token.includes('=') ? 2 : 1;
  }
  const split = Math.min(index, argv.length);
  return [...argv.slice(0, split), '--', ...argv.slice(split)];
}

function quietContext(ctx: CliContext): CliContext {
  return {
    ...ctx,
    globals: { ...ctx.globals, quiet: true },
    out: new Output({ json: ctx.out.json, quiet: true, color: false }),
  };
}

export function remoteRunOptions(invocation: RshInvocation): RemoteRunOptions {
  return {
    target: invocation.target,
    command: invocation.command,
    tty: invocation.tty,
    stdin: invocation.stdin,
    verbose: invocation.verbose > 0,
    legacyFallback: true,
    ...(Object.keys(invocation.env).length > 0 ? { env: invocation.env } : {}),
  };
}

async function runRsh(ctx: CliContext, argv: string[]): Promise<number> {
  // preprocessRshArgv 在载荷前放了一个 `--`；经派发层之后它是第一个词。
  const parsed = parseRshArgs(argv[0] === '--' ? argv.slice(1) : argv);
  if (parsed.kind === 'version') {
    ctx.out.rawErr(Buffer.from(`vibeterm rsh ${cliVersion()}\n`));
    return 0;
  }
  if (parsed.kind === 'config') {
    const { user, hostname, port } = parsed.config;
    for (const line of [`user ${user}`, `hostname ${hostname}`, `port ${port}`]) ctx.out.line(line);
    return 0;
  }
  const { invocation } = parsed;
  if (invocation.verbose > 0 && invocation.user) {
    ctx.out.info(
      `vibeterm rsh: ignoring user ${invocation.user}; the command runs as the node service user`
    );
  }
  const runCtx = invocation.quiet && invocation.verbose === 0 ? quietContext(ctx) : ctx;
  const result = await rshDeps.runRemote(runCtx, remoteRunOptions(invocation));
  return exitCodeOf(result);
}

function reportFailure(ctx: CliContext, error: unknown): number {
  if (error instanceof InterruptError) return error.exitCode;
  reportPrefixedFailure(ctx.out, RSH_ERROR_PREFIX, error);
  return RSH_FAILURE_EXIT;
}

export const command: Command = {
  name: 'rsh',
  summary: 'OpenSSH 兼容入口：rsync / git / scp 把 ssh 换成它即可经 vibeterm 执行',
  usage: USAGE,
  preprocessArgv: preprocessRshArgv,
  failureExitCode: RSH_FAILURE_EXIT,
  errorPrefix: RSH_ERROR_PREFIX,
  async run(ctx, argv) {
    try {
      return await runRsh(ctx, argv);
    } catch (error) {
      return reportFailure(ctx, error);
    }
  },
};
