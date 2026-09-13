import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, homedir, hostname, loadavg, release, totalmem, uptime } from 'node:os';
import type { MeshPortReach } from '@vibeterm/shared';
import { getMemoryProfile } from '../memory-profile';
import { getInstallInfo } from '../system/install-info';
import { json } from './http';
import { plannedPortReach } from './system-facts-ports';
import { getTmuxHealth } from './tmux-health';

const DOCKER_SOCK = '/var/run/docker.sock';

export type SystemFactsDisk = {
  path: string;
  totalBytes: number;
  freeBytes: number;
};

export type SystemFacts = {
  hostname: string;
  os: string;
  arch: string;
  kernel: string;
  uptimeSec: number;
  cpu: { count: number; load1: number; load5: number; load15: number };
  mem: { totalBytes: number; freeBytes: number; availableBytes?: number };
  disk: {
    root: SystemFactsDisk | null;
    home: SystemFactsDisk | null;
  };
  tmux: { healthy: boolean; serverVersion?: string; clientVersion?: string; reason?: string };
  docker: { present: boolean; socket: boolean };
  install: {
    deployment: string;
    installDir: string | null;
    cliVersion: string | null;
  };
  memoryProfile: 'standard' | 'small';
  ports?: MeshPortReach[];
};

export async function handleSystemFacts(): Promise<Response> {
  return json(await collectSystemFacts());
}

export async function collectSystemFacts(): Promise<SystemFacts> {
  const load = loadavg();
  const docker = collectDocker();
  const install = getInstallInfo();
  const tmux = await getTmuxHealth();
  const facts: SystemFacts = {
    hostname: hostname(),
    os: process.platform,
    arch: process.arch,
    kernel: release(),
    uptimeSec: Math.floor(uptime()),
    cpu: { count: cpus().length, load1: load[0] ?? 0, load5: load[1] ?? 0, load15: load[2] ?? 0 },
    mem: collectMem(),
    disk: collectDisk(),
    tmux: {
      healthy: tmux.healthy,
      ...(tmux.serverVersion ? { serverVersion: tmux.serverVersion } : {}),
      ...(tmux.clientVersion ? { clientVersion: tmux.clientVersion } : {}),
      reason: tmux.reason,
    },
    docker,
    install: {
      deployment: install.deployment,
      installDir: install.installDir,
      cliVersion: install.cliVersion,
    },
    memoryProfile: getMemoryProfile(),
  };
  const ports = collectPorts();
  if (ports) facts.ports = ports;
  return facts;
}

function collectMem(): SystemFacts['mem'] {
  const mem: SystemFacts['mem'] = { totalBytes: totalmem(), freeBytes: freemem() };
  const available = readMemAvailable();
  if (available !== undefined) mem.availableBytes = available;
  return mem;
}

function collectDisk(): SystemFacts['disk'] {
  const home = safeHomedir();
  return {
    root: diskOf('/'),
    home: home ? diskOf(home) : null,
  };
}

function diskOf(path: string): SystemFactsDisk | null {
  try {
    const stats = statfsSync(path);
    const bsize = Number(stats.bsize);
    const total = bsize * Number(stats.blocks);
    const free = bsize * Number(stats.bavail);
    if (!Number.isFinite(total) || !Number.isFinite(free) || total < 0) return null;
    return { path, totalBytes: total, freeBytes: free };
  } catch {
    return null;
  }
}

function collectDocker(): { present: boolean; socket: boolean } {
  const socket = existsSync(DOCKER_SOCK);
  return { present: Boolean(Bun.which('docker')) || socket, socket };
}

function collectPorts(): MeshPortReach[] | undefined {
  try {
    return plannedPortReach();
  } catch {
    return undefined;
  }
}

function readMemAvailable(): number | undefined {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (!match?.[1]) return undefined;
    return Number(match[1]) * 1024;
  } catch {
    return undefined;
  }
}

function safeHomedir(): string | null {
  try {
    const dir = homedir();
    return dir || null;
  } catch {
    return null;
  }
}
