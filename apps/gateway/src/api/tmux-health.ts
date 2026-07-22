import { config } from '../config';
import {
  isControlModeSupported,
  normalizeTmuxVersionOutput,
  parseTmuxVersion,
  tmuxClientMatchesServer,
} from '../tmux-client/tmux-version';
import { buildLocalTmuxEnv, getLocalShellPath } from '../tmux/local-shell-path';

export type TmuxHealthReason =
  | 'ok'
  | 'no_server'
  | 'client_unavailable'
  | 'unsupported_version'
  | 'server_probe_failed'
  | 'version_mismatch';

export interface TmuxHealth {
  healthy: boolean;
  clientVersion: string | null;
  clientProvenance: string | null;
  serverVersion: string | null;
  reason: TmuxHealthReason;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TmuxHealthRunner = (argv: string[]) => Promise<CommandResult>;

const CACHE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 1_500;
const NO_SERVER_PATTERN =
  /no server running|failed to connect to server|error connecting to|no such file or directory|session .* not found|no sessions/i;

let cached: { expiresAt: number; value: TmuxHealth } | null = null;
let inFlight: Promise<TmuxHealth> | null = null;

async function defaultRunner(argv: string[]): Promise<CommandResult> {
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn(argv, {
      env: buildLocalTmuxEnv(getLocalShellPath(), processEnv()),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill();
    } catch {}
  }, COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout as ReadableStream<Uint8Array>).text(),
      new Response(process.stderr as ReadableStream<Uint8Array>).text(),
      process.exited,
    ]);
    return {
      exitCode: timedOut ? 124 : exitCode,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

export async function probeTmuxHealth(run: TmuxHealthRunner): Promise<TmuxHealth> {
  const socketArgs = config.tmuxSocket ? ['-L', config.tmuxSocket] : [];
  const client = await run([config.tmuxBin, ...socketArgs, '-V']);
  const normalizedClient = normalizeTmuxVersionOutput(client.stdout);
  const clientVersion = normalizedClient.versionLine;
  const clientProvenance = normalizedClient.provenance;
  if (client.exitCode !== 0 || clientVersion === null) {
    return {
      healthy: false,
      clientVersion,
      clientProvenance,
      serverVersion: null,
      reason: 'client_unavailable',
    };
  }
  if (!isControlModeSupported(parseTmuxVersion(clientVersion))) {
    return {
      healthy: false,
      clientVersion,
      clientProvenance,
      serverVersion: null,
      reason: 'unsupported_version',
    };
  }

  const server = await run([config.tmuxBin, ...socketArgs, 'display-message', '-p', '#{version}']);
  const serverVersion = normalizeTmuxVersionOutput(server.stdout).versionLine;
  if (server.exitCode !== 0) {
    const detail = `${server.stdout}\n${server.stderr}`;
    return {
      healthy: NO_SERVER_PATTERN.test(detail),
      clientVersion,
      clientProvenance,
      serverVersion: null,
      reason: NO_SERVER_PATTERN.test(detail) ? 'no_server' : 'server_probe_failed',
    };
  }
  if (serverVersion === null || !tmuxClientMatchesServer(clientVersion, serverVersion)) {
    return {
      healthy: false,
      clientVersion,
      clientProvenance,
      serverVersion,
      reason: 'version_mismatch',
    };
  }
  return {
    healthy: true,
    clientVersion,
    clientProvenance,
    serverVersion,
    reason: 'ok',
  };
}

export function getTmuxHealth(): Promise<TmuxHealth> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value);
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = probeTmuxHealth(defaultRunner)
    .then((value) => {
      cached = { expiresAt: Date.now() + CACHE_MS, value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
