import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TunnelEdgeResolution } from '@tmex/shared';
import { describeEdge } from './edge-resolver';
import { TunnelError } from './errors';
import {
  type PickPort,
  type SpawnHandle,
  type Spawner,
  collectOutput,
  pickFreePort,
} from './spawn';

export const VERSION_RE = /cloudflared version (\S+)/i;
export const LOGIN_URL_RE = /https:\/\/[^\s]+/g;
export const CREATE_ID_RE = /created tunnel .+ with id ([0-9a-f-]{36})/i;
export const CREDENTIALS_PATH_RE = /credentials written to ([^\s]+\.json)/i;
export const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
export const REGISTERED_RE = /Registered tunnel connection/i;

export function parseVersion(output: string): string | null {
  const match = VERSION_RE.exec(output);
  return match?.[1] ?? null;
}

export function parseLoginUrl(output: string): string | null {
  const matches = output.match(LOGIN_URL_RE);
  if (!matches || matches.length === 0) return null;
  const preferred = matches.find((url) => /cloudflare/i.test(url));
  return preferred ?? matches[0] ?? null;
}

export function parseCreateOutput(output: string): {
  tunnelId: string | null;
  credentialsPath: string | null;
} {
  const id = CREATE_ID_RE.exec(output)?.[1] ?? null;
  const credentialsPath = CREDENTIALS_PATH_RE.exec(output)?.[1]?.trim() ?? null;
  return { tunnelId: id, credentialsPath };
}

export function parseQuickUrl(output: string): string | null {
  return QUICK_URL_RE.exec(output)?.[0] ?? null;
}

export function isRegisteredLine(line: string): boolean {
  return REGISTERED_RE.test(line) && !/Unregistered tunnel connection/i.test(line);
}

export type TunnelListEntry = { id: string; name: string };

export function parseTunnelList(output: string): TunnelListEntry[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: TunnelListEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { id?: unknown; name?: unknown };
      if (typeof rec.id === 'string' && typeof rec.name === 'string') {
        out.push({ id: rec.id, name: rec.name });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function originCertPath(tunnelDir: string): string {
  return join(tunnelDir, 'cert.pem');
}

export function managedBinaryPath(tunnelDir: string): string {
  return join(tunnelDir, 'cloudflared');
}

export function configYmlPath(tunnelDir: string): string {
  return join(tunnelDir, 'config.yml');
}

export function credentialsPathFor(tunnelDir: string, tunnelIdOrName: string): string {
  const dir = resolve(tunnelDir);
  const candidate = resolve(dir, `${tunnelIdOrName}.json`);
  const rel = relative(dir, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || dirname(candidate) !== dir) {
    throw new TunnelError('invalid_request', 'tunnel name is not a valid identifier');
  }
  return candidate;
}

function tunnelEnv(originCert: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TUNNEL_ORIGIN_CERT = originCert;
  env.NO_AUTOUPDATE = 'true';
  if (extra) Object.assign(env, extra);
  return env;
}

function tunnelBaseArgs(originCert: string): string[] {
  return ['tunnel', '--origincert', originCert, '--no-autoupdate'];
}

export type EdgeResolver = () => Promise<TunnelEdgeResolution | null>;

export type CloudflaredProviderOptions = {
  resolveEdge?: EdgeResolver;
  log?: (message: string) => void;
};

/**
 * 静态边缘只在本机代理劫持 DNS 时启用，这类环境下 UDP 7844（QUIC）几乎必然被代理吞掉，
 * 而 cloudflared 的 `auto` 协议要多次 QUIC 失败才回落，实测数分钟仍 0 连接；直接钉 http2。
 */
export function edgeArgs(edge: TunnelEdgeResolution | null): string[] {
  if (!edge || edge.mode !== 'static') return [];
  const args: string[] = [];
  for (const addr of edge.edgeAddrs) {
    args.push('--edge', addr);
  }
  args.push('--protocol', 'http2');
  return args;
}

export class CloudflaredProvider {
  private readonly resolveEdgeFn: EdgeResolver;
  private readonly log: (message: string) => void;

  constructor(
    private readonly spawner: Spawner,
    private readonly tunnelDir: string,
    private readonly pickPort: PickPort = pickFreePort,
    opts: CloudflaredProviderOptions = {}
  ) {
    this.resolveEdgeFn = opts.resolveEdge ?? (async () => null);
    this.log = opts.log ?? ((message) => console.log(message));
  }

  /** `override` 来自自愈流程刚解析出的结果：直接用于本次 spawn，不再重新解析。 */
  private async resolveEdgeForSpawn(
    override?: TunnelEdgeResolution | null
  ): Promise<TunnelEdgeResolution | null> {
    if (override) {
      this.log(describeEdge(override));
      return override;
    }
    try {
      const edge = await this.resolveEdgeFn();
      if (edge) this.log(describeEdge(edge));
      return edge;
    } catch {
      return null;
    }
  }

  spawn(command: string, args: string[], env?: Record<string, string>): SpawnHandle {
    return this.spawner({ command, args, env, cwd: this.tunnelDir });
  }

  async version(bin: string): Promise<string | null> {
    const handle = this.spawn(bin, ['--version']);
    const { stdout, stderr } = await collectOutput(handle);
    return parseVersion(`${stdout}\n${stderr}`);
  }

  spawnLogin(bin: string): SpawnHandle {
    const cert = originCertPath(this.tunnelDir);
    return this.spawn(bin, [...tunnelBaseArgs(cert), 'login'], tunnelEnv(cert));
  }

  async createTunnel(
    bin: string,
    name: string,
    credFile: string
  ): Promise<{ tunnelId: string; credentialsPath: string }> {
    const cert = originCertPath(this.tunnelDir);
    const handle = this.spawn(
      bin,
      [...tunnelBaseArgs(cert), 'create', '--credentials-file', credFile, name],
      tunnelEnv(cert)
    );
    const { stdout, stderr, exitCode } = await collectOutput(handle);
    const combined = `${stdout}\n${stderr}`;
    if (exitCode === 0) {
      const parsed = parseCreateOutput(combined);
      const tunnelId = parsed.tunnelId;
      if (!tunnelId) {
        throw new TunnelError('process_failed', combined.trim() || 'tunnel create produced no id');
      }
      return { tunnelId, credentialsPath: parsed.credentialsPath ?? credFile };
    }
    if (/already exists/i.test(combined)) {
      const existing = await this.findTunnel(bin, name);
      if (existing) {
        return { tunnelId: existing.id, credentialsPath: credFile };
      }
    }
    throw new TunnelError('process_failed', combined.trim() || `tunnel create exited ${exitCode}`);
  }

  async findTunnel(bin: string, name: string): Promise<TunnelListEntry | null> {
    const cert = originCertPath(this.tunnelDir);
    const handle = this.spawn(
      bin,
      [...tunnelBaseArgs(cert), 'list', '-o', 'json', '--name', name],
      tunnelEnv(cert)
    );
    const { stdout, stderr, exitCode } = await collectOutput(handle);
    const entries = parseTunnelList(stdout || stderr);
    const exact = entries.find((entry) => entry.name === name);
    if (exact) return exact;
    if (exitCode !== 0 && entries.length === 0) return null;
    return entries[0] ?? null;
  }

  async routeDns(bin: string, name: string, hostname: string): Promise<void> {
    const cert = originCertPath(this.tunnelDir);
    const handle = this.spawn(
      bin,
      [...tunnelBaseArgs(cert), 'route', 'dns', name, hostname],
      tunnelEnv(cert)
    );
    const { stdout, stderr, exitCode } = await collectOutput(handle);
    if (exitCode !== 0) {
      const message = `${stderr}\n${stdout}`.trim() || `dns route exited ${exitCode}`;
      throw new TunnelError('dns_route_failed', message);
    }
  }

  async deleteTunnel(bin: string, name: string): Promise<void> {
    const cert = originCertPath(this.tunnelDir);
    const handle = this.spawn(
      bin,
      [...tunnelBaseArgs(cert), 'delete', '-f', name],
      tunnelEnv(cert)
    );
    await collectOutput(handle);
  }

  async spawnNamedRun(
    bin: string,
    configPath: string,
    edgeOverride?: TunnelEdgeResolution | null
  ): Promise<SpawnHandle> {
    const cert = originCertPath(this.tunnelDir);
    const metrics = await this.metricsArgs();
    const edge = await this.resolveEdgeForSpawn(edgeOverride);
    const handle = this.spawn(
      bin,
      [...tunnelBaseArgs(cert), ...metrics.args, ...edgeArgs(edge), '--config', configPath, 'run'],
      tunnelEnv(cert)
    );
    handle.metricsAddr = metrics.addr;
    handle.edge = edge;
    return handle;
  }

  async spawnQuickRun(
    bin: string,
    originUrl: string,
    edgeOverride?: TunnelEdgeResolution | null
  ): Promise<SpawnHandle> {
    const metrics = await this.metricsArgs();
    const edge = await this.resolveEdgeForSpawn(edgeOverride);
    const handle = this.spawn(bin, [
      'tunnel',
      '--no-autoupdate',
      ...metrics.args,
      ...edgeArgs(edge),
      '--url',
      originUrl,
    ]);
    handle.metricsAddr = metrics.addr;
    handle.edge = edge;
    return handle;
  }

  private async metricsArgs(): Promise<{ args: string[]; addr: string | null }> {
    try {
      const port = await this.pickPort();
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { args: [], addr: null };
      }
      const addr = `127.0.0.1:${port}`;
      return { args: ['--metrics', addr], addr };
    } catch {
      return { args: [], addr: null };
    }
  }
}
