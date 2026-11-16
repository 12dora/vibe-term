import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ExternalProcess = { pid: number; command: string };

export type ListProcessesDeps = {
  spawnPs?: (args: readonly string[]) => Promise<string>;
  platform?: NodeJS.Platform;
  procRoot?: string;
};

const PS_TIMEOUT_MS = 2_000;

export const PS_LIST_COMMANDS: readonly (readonly string[])[] = [
  ['ps', '-Ao', 'pid=,command='],
  ['ps', '-eo', 'pid=,command='],
  ['ps', 'ax', '-o', 'pid=,command='],
  ['ps', '-o', 'pid=,command='],
];

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

export function psTableLooksValid(text: string): boolean {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return false;
  if (/^PID\b/.test(first) && /\bUSER\b/.test(first)) return false;
  return parsePsOutput(text).some((row) => row.command.length > 0);
}

async function spawnPsText(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), PS_TIMEOUT_MS);
  try {
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function readProcCmdline(procRoot: string, name: string): Promise<string | null> {
  if (!/^\d+$/.test(name)) return null;
  try {
    const raw = await readFile(join(procRoot, name, 'cmdline'), 'utf8');
    const command = raw.replace(/\0/g, ' ').trim();
    return command || null;
  } catch {
    return null;
  }
}

async function listProcCmdlines(procRoot: string): Promise<ExternalProcess[]> {
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const out: ExternalProcess[] = [];
  for (const name of names) {
    const command = await readProcCmdline(procRoot, name);
    if (!command) continue;
    out.push({ pid: Number(name), command });
  }
  return out;
}

export async function defaultListProcesses(
  deps: ListProcessesDeps = {}
): Promise<ExternalProcess[]> {
  const spawn = deps.spawnPs ?? spawnPsText;
  for (const args of PS_LIST_COMMANDS) {
    const text = await spawn(args);
    if (psTableLooksValid(text)) return parsePsOutput(text);
  }
  if ((deps.platform ?? process.platform) === 'linux') {
    return listProcCmdlines(deps.procRoot ?? '/proc');
  }
  return [];
}
