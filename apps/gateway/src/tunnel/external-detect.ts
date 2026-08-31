import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TunnelExternalAccessProbe, TunnelExternalStatus } from '@tmex/shared';
import { normalizeTunnelHostname } from './hostname';

export type ExternalProcess = { pid: number; command: string };

export type DetectedTunnel = TunnelExternalStatus & {
  pid: number | null;
  tokenFile: string | null;
  logFile: string | null;
  accountId: string | null;
};

export type ExternalDetection = DetectedTunnel & { tokenAccountId: string | null };

export const EMPTY_EXTERNAL_ACCESS: TunnelExternalAccessProbe = {
  checked: false,
  hostnameMatch: false,
  appId: null,
  aud: null,
  teamDomain: null,
};

export const EMPTY_EXTERNAL: ExternalDetection = {
  detected: false,
  source: null,
  configPath: null,
  tunnelId: null,
  tunnelName: null,
  hostnames: [],
  hasOriginCert: false,
  running: false,
  pid: null,
  tokenFile: null,
  logFile: null,
  accountId: null,
  tokenAccountId: null,
  externalAccess: { ...EMPTY_EXTERNAL_ACCESS },
};

export type ExternalAccessApp = {
  id: string;
  aud: string;
  domain: string;
  name?: string;
};

export type ExternalAccessApi = {
  getTunnelIngress: (
    accountId: string,
    apiToken: string,
    tunnelId: string
  ) => Promise<Array<{ hostname: string | null; service: string | null }>>;
  getTunnel?: (
    accountId: string,
    apiToken: string,
    tunnelId: string
  ) => Promise<{ id: string; name: string | null }>;
  listApps?: (accountId: string, apiToken: string) => Promise<ExternalAccessApp[]>;
  getOrganization?: (accountId: string, apiToken: string) => Promise<{ teamDomain: string }>;
};

export type ExternalDetectDeps = {
  now?: () => number;
  originPort: number;
  homeDir?: string;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  listProcesses?: () => ExternalProcess[] | string | Promise<ExternalProcess[] | string>;
  readFile?: (path: string) => string | null | Promise<string | null>;
  listDir?: (path: string) => string[] | Promise<string[]>;
  accessApi?: ExternalAccessApi | null;
  accessClient?: ExternalAccessApi | null;
  getApiCredentials?: () => Promise<{ accountId: string; apiToken: string } | null>;
  getCredentials?: () => Promise<{ accountId: string; apiToken: string } | null>;
  configuredHostnames?: string[] | (() => string[]);
  warn?: (message: string) => void;
  firstWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const CACHE_MS = 30_000;
const FIRST_WAIT_MS = 1_500;
const MAX_LOG_SCAN_BYTES = 256 * 1024;

export function defaultListProcesses(): ExternalProcess[] {
  try {
    const proc = Bun.spawnSync(['ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'pipe' });
    const text = new TextDecoder().decode(proc.stdout);
    return parsePsOutput(text);
  } catch {
    return [];
  }
}

export function parsePsOutput(text: string): ExternalProcess[] {
  const out: ExternalProcess[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    out.push({ pid: Number(match[1]), command: match[2] ?? '' });
  }
  return out;
}

type Candidate = {
  source: 'process' | 'launchd' | 'systemd' | 'config';
  parsed: ParsedArgs;
  pid: number | null;
};

const SOURCE_RANK: Record<Candidate['source'], number> = {
  launchd: 4,
  systemd: 3,
  process: 2,
  config: 1,
};

async function detectUncached(deps: ExternalDetectDeps): Promise<DetectedTunnel> {
  const home = deps.homeDir ?? deps.homedir?.() ?? homedir();
  const readFile = async (path: string): Promise<string | null> =>
    (await (deps.readFile ?? defaultReadFile)(path)) ?? null;
  const listDir = async (path: string): Promise<string[]> =>
    (await (deps.listDir ?? defaultListDir)(path)) ?? [];
  const rawProcesses = await (deps.listProcesses ?? defaultListProcesses)();
  const processes = normalizeProcesses(rawProcesses);
  const cloudflaredHome = join(home, '.cloudflared');
  const hasOriginCert = Boolean(await readFile(join(cloudflaredHome, 'cert.pem')));
  const collected = await collectCandidates({
    home,
    cloudflaredHome,
    processes,
    readFile,
    listDir,
  });
  const accessApi = deps.accessApi ?? deps.accessClient ?? null;
  const getApiCredentials = deps.getApiCredentials ?? deps.getCredentials;
  const enriched: Array<DetectedTunnel & { score: number }> = [];
  for (const cand of mergeCandidates(collected)) {
    enriched.push(
      await enrichCandidate(cand, {
        originPort: deps.originPort,
        readFile,
        hasOriginCert,
        accessApi,
        getApiCredentials,
      })
    );
  }
  enriched.sort((a, b) => b.score - a.score);
  return attachAccessProbe(enriched[0], deps, hasOriginCert, accessApi, getApiCredentials);
}

async function collectCandidates(opts: {
  home: string;
  cloudflaredHome: string;
  processes: ExternalProcess[];
  readFile: (path: string) => Promise<string | null>;
  listDir: (path: string) => Promise<string[]>;
}): Promise<Candidate[]> {
  const collected: Candidate[] = [];
  for (const proc of opts.processes.filter((p) => isCloudflaredTunnelCommand(p.command))) {
    collected.push({ source: 'process', parsed: parseCommandLine(proc.command), pid: proc.pid });
  }
  for (const unit of await findLaunchdUnits(opts.home, opts.listDir, opts.readFile)) {
    collected.push({ source: 'launchd', parsed: unit, pid: null });
  }
  for (const unit of await findSystemdUnits(opts.home, opts.listDir, opts.readFile)) {
    collected.push({ source: 'systemd', parsed: unit, pid: null });
  }
  const defaultConfigPath = join(opts.cloudflaredHome, 'config.yml');
  const defaultYmlText = await opts.readFile(defaultConfigPath);
  if (!defaultYmlText) return collected;
  const parsedYml = parseCloudflaredYml(defaultYmlText);
  collected.push({
    source: 'config',
    parsed: {
      tokenFile: null,
      logFile: null,
      configPath: defaultConfigPath,
      tunnelId: parsedYml?.tunnelId ?? null,
      tunnelName: parsedYml?.tunnelName ?? null,
    },
    pid: null,
  });
  return collected;
}

async function attachAccessProbe(
  best: (DetectedTunnel & { score: number }) | undefined,
  deps: ExternalDetectDeps,
  hasOriginCert: boolean,
  accessApi: ExternalAccessApi | null,
  getApiCredentials?: () => Promise<{ accountId: string; apiToken: string } | null>
): Promise<DetectedTunnel> {
  const extraHosts = resolveConfiguredHostnames(deps.configuredHostnames);
  const probeHosts = uniqueHostnames([...(best?.hostnames ?? []), ...extraHosts]);
  const externalAccess = await probeExternalAccess({
    hostnames: probeHosts,
    accessApi,
    getApiCredentials,
    warn: deps.warn,
  });
  if (!best) return { ...EMPTY_EXTERNAL, hasOriginCert, externalAccess };
  return {
    detected: best.detected,
    source: best.source,
    configPath: best.configPath,
    tunnelId: best.tunnelId,
    tunnelName: best.tunnelName,
    hostnames: best.hostnames,
    hasOriginCert,
    running: best.running,
    pid: best.pid,
    tokenFile: best.tokenFile,
    logFile: best.logFile,
    accountId: best.accountId,
    externalAccess,
  };
}

function candidateKey(parsed: ParsedArgs): string {
  if (parsed.tunnelId) return `id:${parsed.tunnelId.toLowerCase()}`;
  if (parsed.tokenFile) return `token:${parsed.tokenFile}`;
  if (parsed.configPath) return `config:${parsed.configPath}`;
  if (parsed.tunnelName) return `name:${parsed.tunnelName.toLowerCase()}`;
  return `anon:${JSON.stringify(parsed)}`;
}

function mergeCandidates(collected: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const cand of collected) {
    const key = candidateKey(cand.parsed);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, cand);
      continue;
    }
    const source =
      SOURCE_RANK[cand.source] >= SOURCE_RANK[existing.source] ? cand.source : existing.source;
    byKey.set(key, {
      source,
      parsed: mergeParsed(existing.parsed, cand.parsed),
      pid: existing.pid ?? cand.pid,
    });
  }
  return [...byKey.values()];
}

async function enrichCandidate(
  cand: Candidate,
  opts: {
    originPort: number;
    readFile: (path: string) => Promise<string | null>;
    hasOriginCert: boolean;
    accessApi: ExternalAccessApi | null;
    getApiCredentials?: () => Promise<{ accountId: string; apiToken: string } | null>;
  }
): Promise<DetectedTunnel & { score: number }> {
  let tunnelId = cand.parsed.tunnelId;
  let tunnelName = cand.parsed.tunnelName;
  let accountId: string | null = null;
  const tokenFile = cand.parsed.tokenFile;
  const logFile = cand.parsed.logFile;
  const configPath = cand.parsed.configPath;
  let yml: ReturnType<typeof parseCloudflaredYml> = null;
  if (configPath) {
    const text = await opts.readFile(configPath);
    yml = text ? parseCloudflaredYml(text) : null;
    if (yml) {
      tunnelId = tunnelId ?? yml.tunnelId;
      tunnelName = tunnelName ?? yml.tunnelName;
    }
  }

  const fromToken = await readTokenSiblings(tokenFile, opts.readFile, tunnelId, accountId);
  tunnelId = fromToken.tunnelId;
  accountId = fromToken.accountId;

  if (!tunnelName && tunnelId) {
    const fromApi = await lookupTunnelName({
      tunnelId,
      accountId,
      accessApi: opts.accessApi,
      getApiCredentials: opts.getApiCredentials,
    });
    if (fromApi) tunnelName = fromApi;
  }

  const hostnames = await resolveHostnames({
    originPort: opts.originPort,
    yml,
    tokenFile,
    logFile,
    tunnelId,
    accountId,
    readFile: opts.readFile,
    accessApi: opts.accessApi,
    getApiCredentials: opts.getApiCredentials,
    siblingHostname: fromToken.siblingHostname,
  });

  const running = cand.pid != null;
  const detected = Boolean(
    cand.source || tunnelId || tokenFile || configPath || hostnames.length || running
  );
  let score = SOURCE_RANK[cand.source] ?? 0;
  if (running && hostnames.length) score += 200;
  else if (hostnames.length) score += 100;
  else if (running) score += 10;
  return {
    detected,
    source: cand.source,
    configPath: configPath,
    tunnelId,
    tunnelName,
    hostnames: uniqueHostnames(hostnames),
    hasOriginCert: opts.hasOriginCert,
    running,
    pid: cand.pid,
    tokenFile,
    logFile,
    accountId,
    score,
  };
}

export function isCloudflaredTunnelCommand(command: string): boolean {
  return /\bcloudflared\b/.test(command) && /\btunnel\b/.test(command);
}

export type ParsedArgs = {
  tokenFile: string | null;
  logFile: string | null;
  configPath: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
};

const FLAGS_WITH_VALUE = new Set([
  '--token-file',
  '--token',
  '--logfile',
  '--log-file',
  '--config',
  '--origincert',
  '--credentials-file',
]);

export function parseArgv(tokens: string[]): ParsedArgs {
  const tokenFile = flagValue(tokens, '--token-file');
  const logFile = flagValue(tokens, '--logfile') ?? flagValue(tokens, '--log-file');
  const configPath = flagValue(tokens, '--config');
  let tunnelId: string | null = null;
  let tunnelName: string | null = null;
  const runIdx = tokens.findIndex((t) => t === 'run');
  if (runIdx >= 0) {
    const rest = tokens.slice(runIdx + 1);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token) continue;
      if (FLAGS_WITH_VALUE.has(token)) {
        i += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
      if (looksLikeId(token)) tunnelId = token;
      else if (!token.includes('/') && !token.includes('\\')) tunnelName = token;
      break;
    }
  }
  return { tokenFile, logFile, configPath, tunnelId, tunnelName };
}

export function parseCommandLine(command: string): ParsedArgs {
  return parseArgv(tokenize(command));
}

export function parseCloudflaredYml(text: string): {
  tunnelId: string | null;
  tunnelName: string | null;
  credentialsFile: string | null;
  ingress: Array<{ hostname: string | null; service: string | null }>;
} | null {
  if (!text.trim()) return null;
  let tunnelRaw: string | null = null;
  let credentialsFile: string | null = null;
  const ingress: Array<{ hostname: string | null; service: string | null }> = [];
  let inIngress = false;
  let current: { hostname: string | null; service: string | null } | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('-')) inIngress = false;
    const tunnelMatch = trimmed.match(/^tunnel:\s*(.+)$/);
    if (tunnelMatch && !inIngress) {
      tunnelRaw = unquote(tunnelMatch[1] ?? '');
      continue;
    }
    const credMatch = trimmed.match(/^credentials-file:\s*(.+)$/);
    if (credMatch) {
      credentialsFile = unquote(credMatch[1] ?? '');
      continue;
    }
    if (/^ingress:\s*$/.test(trimmed)) {
      inIngress = true;
      continue;
    }
    if (inIngress) {
      if (/^-\s*/.test(trimmed)) {
        if (current) ingress.push(current);
        current = { hostname: null, service: null };
        const rest = trimmed.replace(/^-\s*/, '');
        applyIngressField(current, rest);
      } else if (current) {
        applyIngressField(current, trimmed);
      }
    }
  }
  if (current) ingress.push(current);
  const tunnelId = tunnelRaw && looksLikeId(tunnelRaw) ? tunnelRaw : null;
  const tunnelName = tunnelRaw && !looksLikeId(tunnelRaw) ? tunnelRaw : null;
  return { tunnelId, tunnelName, credentialsFile, ingress };
}

export function serviceHitsOrigin(service: string | null | undefined, originPort: number): boolean {
  if (!service) return false;
  return new RegExp(`:${originPort}(?:[/\\s?#]|$)`).test(service);
}

export function parseTokenFileMeta(
  raw: string | null | undefined
): { accountId: string; tunnelId: string } | null {
  if (!raw) return null;
  const text = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as { a?: unknown; t?: unknown };
  if (typeof rec.a !== 'string' || typeof rec.t !== 'string') return null;
  return { accountId: rec.a, tunnelId: rec.t };
}

async function readTokenSiblings(
  tokenFile: string | null,
  readFile: (path: string) => Promise<string | null>,
  tunnelId: string | null,
  accountId: string | null
): Promise<{ tunnelId: string | null; accountId: string | null; siblingHostname: string | null }> {
  if (!tokenFile) return { tunnelId, accountId, siblingHostname: null };
  let nextId = tunnelId;
  let nextAccount = accountId;
  const tokenMeta = parseTokenFileMeta(await readFile(tokenFile));
  if (tokenMeta) {
    nextId = nextId ?? tokenMeta.tunnelId;
    nextAccount = tokenMeta.accountId;
  }
  const dir = dirnameOf(tokenFile);
  if (!nextId) {
    const idSibling = (await readFile(join(dir, 'tunnel-id')))?.trim();
    if (idSibling && looksLikeId(idSibling)) nextId = idSibling;
  }
  const siblingHostname = normalizeTunnelHostname((await readFile(join(dir, 'hostname'))) ?? '');
  return { tunnelId: nextId, accountId: nextAccount, siblingHostname };
}

function hostnamesFromIngressItems(ingress: unknown, originPort: number): string[] {
  if (!Array.isArray(ingress)) return [];
  const hostnames: string[] = [];
  for (const item of ingress) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { hostname?: unknown; service?: unknown };
    if (
      typeof rec.hostname === 'string' &&
      serviceHitsOrigin(String(rec.service ?? ''), originPort)
    ) {
      hostnames.push(rec.hostname.toLowerCase());
    }
  }
  return uniqueHostnames(hostnames);
}

function ingressFromEscapedConfigLine(line: string, originPort: number): string[] {
  if (!line.includes('"config"')) return [];
  try {
    const rec = JSON.parse(line) as unknown;
    if (!rec || typeof rec !== 'object') return [];
    const config = (rec as { config?: unknown }).config;
    if (typeof config !== 'string') return [];
    const inner = JSON.parse(config) as unknown;
    if (!inner || typeof inner !== 'object') return [];
    return hostnamesFromIngressItems((inner as { ingress?: unknown }).ingress, originPort);
  } catch {
    return [];
  }
}

function ingressFromRawLine(line: string, originPort: number): string[] {
  const match = line.match(/"ingress"\s*:\s*(\[[^\]]*\])/);
  if (!match?.[1]) return [];
  try {
    return hostnamesFromIngressItems(JSON.parse(match[1]), originPort);
  } catch {
    return [];
  }
}

function resolveConfiguredHostnames(value: ExternalDetectDeps['configuredHostnames']): string[] {
  const raw = typeof value === 'function' ? value() : (value ?? []);
  return uniqueHostnames(raw);
}

function appMatchesHostname(domain: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  const d = domain.trim().toLowerCase();
  if (d === host) return true;
  const slash = d.indexOf('/');
  return slash > 0 && d.slice(0, slash) === host;
}

async function probeExternalAccess(opts: {
  hostnames: string[];
  accessApi: ExternalAccessApi | null;
  getApiCredentials?: () => Promise<{
    accountId: string;
    apiToken: string;
    source?: 'store' | 'cert';
  } | null>;
  warn?: (message: string) => void;
}): Promise<TunnelExternalAccessProbe> {
  if (!opts.accessApi?.listApps || !opts.getApiCredentials) return { ...EMPTY_EXTERNAL_ACCESS };
  const creds = await opts.getApiCredentials();
  if (!creds) return { ...EMPTY_EXTERNAL_ACCESS };
  try {
    const apps = await opts.accessApi.listApps(creds.accountId, creds.apiToken);
    const truncated = (apps as { truncated?: boolean }).truncated === true;
    // cert 回退令牌空列表无法证伪 dashboard 配置；分页截断同样不能当成「未覆盖」。
    if (apps.length === 0 && creds.source === 'cert') {
      return { ...EMPTY_EXTERNAL_ACCESS };
    }
    const match = apps.find((app) => opts.hostnames.some((h) => appMatchesHostname(app.domain, h)));
    if (!match && truncated) return { ...EMPTY_EXTERNAL_ACCESS };
    let teamDomain: string | null = null;
    if (opts.accessApi.getOrganization) {
      try {
        teamDomain = (await opts.accessApi.getOrganization(creds.accountId, creds.apiToken))
          .teamDomain;
      } catch {
        // teamDomain 为附加信息，失败不影响 checked
      }
    }
    return {
      checked: true,
      hostnameMatch: Boolean(match),
      appId: match?.id ?? null,
      aud: match?.aud ?? null,
      teamDomain,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opts.warn?.(`external Access probe failed: ${message}`);
    return { ...EMPTY_EXTERNAL_ACCESS };
  }
}

export function parseIngressFromLog(text: string, originPort: number): string[] {
  const slice = text.length > MAX_LOG_SCAN_BYTES ? text.slice(-MAX_LOG_SCAN_BYTES) : text;
  const lines = slice.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.includes('ingress')) continue;
    const fromEscaped = ingressFromEscapedConfigLine(line, originPort);
    if (fromEscaped.length) return fromEscaped;
    const fromRaw = ingressFromRawLine(line, originPort);
    if (fromRaw.length) return fromRaw;
  }
  return [];
}

async function resolveHostnames(opts: {
  originPort: number;
  yml: ReturnType<typeof parseCloudflaredYml>;
  tokenFile: string | null;
  logFile: string | null;
  tunnelId: string | null;
  accountId: string | null;
  readFile: (path: string) => Promise<string | null>;
  accessApi: ExternalAccessApi | null;
  getApiCredentials?: () => Promise<{ accountId: string; apiToken: string } | null>;
  siblingHostname?: string | null;
}): Promise<string[]> {
  const fromYml = opts.yml
    ? opts.yml.ingress
        .filter((r) => r.hostname && serviceHitsOrigin(r.service, opts.originPort))
        .map((r) => r.hostname as string)
    : [];
  if (fromYml.length) return fromYml;

  let fromApi: string[] = [];
  const creds = opts.getApiCredentials ? await opts.getApiCredentials() : null;
  if (creds && opts.accessApi && opts.tunnelId) {
    const accountId = opts.accountId ?? creds.accountId;
    try {
      const ingress = await opts.accessApi.getTunnelIngress(
        accountId,
        creds.apiToken,
        opts.tunnelId
      );
      fromApi = ingress
        .filter((r) => r.hostname && serviceHitsOrigin(r.service, opts.originPort))
        .map((r) => r.hostname as string);
    } catch {
      // 探测失败时继续看日志
    }
  }
  if (fromApi.length) return fromApi;

  if (opts.logFile) {
    const fromLog = parseIngressFromLog((await opts.readFile(opts.logFile)) ?? '', opts.originPort);
    if (fromLog.length) return fromLog;
  }
  if (opts.siblingHostname) return [opts.siblingHostname];
  return [];
}

async function lookupTunnelName(opts: {
  tunnelId: string;
  accountId: string | null;
  accessApi: ExternalAccessApi | null;
  getApiCredentials?: () => Promise<{ accountId: string; apiToken: string } | null>;
}): Promise<string | null> {
  if (!opts.accessApi?.getTunnel) return null;
  const creds = opts.getApiCredentials ? await opts.getApiCredentials() : null;
  if (!creds) return null;
  try {
    const tunnel = await opts.accessApi.getTunnel(
      opts.accountId ?? creds.accountId,
      creds.apiToken,
      opts.tunnelId
    );
    return tunnel.name;
  } catch {
    return null;
  }
}

async function findLaunchdUnits(
  home: string,
  listDir: (path: string) => Promise<string[]>,
  readFile: (path: string) => Promise<string | null>
): Promise<ParsedArgs[]> {
  const out: ParsedArgs[] = [];
  const dirs = [join(home, 'Library/LaunchAgents'), '/Library/LaunchDaemons'];
  for (const dir of dirs) {
    for (const name of await listDir(dir)) {
      if (!name.endsWith('.plist')) continue;
      const body = await readFile(join(dir, name));
      if (!body || !body.includes('cloudflared')) continue;
      const args = parsePlistProgramArguments(body);
      if (!args.some((a) => a.includes('cloudflared'))) continue;
      out.push(parseArgv(args));
    }
  }
  return out;
}

async function findSystemdUnits(
  home: string,
  listDir: (path: string) => Promise<string[]>,
  readFile: (path: string) => Promise<string | null>
): Promise<ParsedArgs[]> {
  const out: ParsedArgs[] = [];
  const dirs = ['/etc/systemd/system', '/lib/systemd/system', join(home, '.config/systemd/user')];
  for (const dir of dirs) {
    for (const name of await listDir(dir)) {
      if (!name.startsWith('cloudflared') || !name.endsWith('.service')) continue;
      const body = await readFile(join(dir, name));
      if (!body) continue;
      const exec = body.match(/^ExecStart=(.+)$/m)?.[1];
      if (!exec || !exec.includes('cloudflared')) continue;
      out.push(parseCommandLine(exec));
    }
  }
  return out;
}

export function parsePlistProgramArguments(plist: string): string[] {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
  if (!block?.[1]) {
    const prog = plist.match(/<key>Program<\/key>\s*<string>([^<]+)<\/string>/i);
    return prog?.[1] ? [unescapeXml(prog[1])] : [];
  }
  const args: string[] = [];
  for (const m of block[1].matchAll(/<string>([^<]*)<\/string>/gi)) {
    args.push(unescapeXml(m[1] ?? ''));
  }
  return args;
}

function mergeParsed(primary: ParsedArgs, extra: ParsedArgs | null): ParsedArgs {
  if (!extra) return primary;
  return {
    tokenFile: primary.tokenFile ?? extra.tokenFile,
    logFile: primary.logFile ?? extra.logFile,
    configPath: primary.configPath ?? extra.configPath,
    tunnelId: primary.tunnelId ?? extra.tunnelId,
    tunnelName: primary.tunnelName ?? extra.tunnelName,
  };
}

function flagValue(tokens: string[], name: string): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    if (t.startsWith(`${name}=`)) return stripQuotes(t.slice(name.length + 1));
    if (t !== name) continue;
    const parts: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const next = tokens[j] ?? '';
      if (!next || next.startsWith('-') || next === 'run') break;
      parts.push(stripQuotes(next));
    }
    if (parts.length) return parts.join(' ');
  }
  return null;
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function applyIngressField(
  current: { hostname: string | null; service: string | null },
  rest: string
): void {
  const host = rest.match(/^hostname:\s*(.+)$/);
  if (host) current.hostname = unquote(host[1] ?? '').toLowerCase();
  const svc = rest.match(/^service:\s*(.+)$/);
  if (svc) current.service = unquote(svc[1] ?? '');
}

function unquote(value: string): string {
  return stripQuotes(value.trim());
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function uniqueHostnames(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of values) {
    const n = h.trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(0, i) : '.';
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function toExternalStatus(detected: DetectedTunnel): TunnelExternalStatus {
  return {
    detected: detected.detected,
    source: detected.source,
    configPath: detected.configPath,
    tunnelId: detected.tunnelId,
    tunnelName: detected.tunnelName,
    hostnames: [...detected.hostnames],
    hasOriginCert: detected.hasOriginCert,
    running: detected.running,
    externalAccess: { ...(detected.externalAccess ?? EMPTY_EXTERNAL_ACCESS) },
    ...(detected.probing ? { probing: true } : {}),
  };
}

function normalizeProcesses(raw: ExternalProcess[] | string): ExternalProcess[] {
  return typeof raw === 'string' ? parsePsOutput(raw) : raw;
}

export class ExternalTunnelDetector {
  private localCache: { at: number; value: ExternalDetection } | null = null;
  private inFlight: Promise<ExternalDetection> | null = null;

  constructor(private readonly deps: ExternalDetectDeps) {}

  invalidate(): void {
    this.localCache = null;
  }

  async detect(opts?: { force?: boolean }): Promise<ExternalDetection> {
    const now = this.deps.now ?? Date.now;
    const cached = this.localCache;
    if (!opts?.force && cached && now() - cached.at < CACHE_MS) return this.withProbe(cached.value);
    const pending = this.refresh();
    if (opts?.force) return pending;
    if (cached) return this.withProbe(cached.value);
    const cap = this.deps.firstWaitMs ?? FIRST_WAIT_MS;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await Promise.race([pending, sleep(cap)]);
    return this.localCache?.value ?? { ...EMPTY_EXTERNAL, probing: true };
  }

  private withProbe(value: ExternalDetection): ExternalDetection {
    return this.inFlight ? { ...value, probing: true } : value;
  }

  private refresh(): Promise<ExternalDetection> {
    if (this.inFlight) return this.inFlight;
    const now = this.deps.now ?? Date.now;
    this.inFlight = detectUncached(this.deps)
      .then((detected) => {
        const value: ExternalDetection = { ...detected, tokenAccountId: detected.accountId };
        this.localCache = { at: now(), value };
        return value;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.warn?.(`external tunnel detection failed: ${message}`);
        const value = this.localCache?.value ?? { ...EMPTY_EXTERNAL };
        this.localCache = { at: now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
