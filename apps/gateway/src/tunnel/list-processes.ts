import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ExternalProcess = { pid: number; command: string };

export type SpawnPsResult = { text: string; exitCode: number };

export type ListProcessesDeps = {
  spawnPs?: (args: readonly string[]) => Promise<SpawnPsResult>;
  platform?: NodeJS.Platform;
  procRoot?: string;
};

const PS_TIMEOUT_MS = 2_000;

export const PS_LIST_COMMANDS: readonly (readonly string[])[] = [
  ['ps', '-Ao', 'pid=,args='],
  ['ps', '-eo', 'pid=,args='],
  ['ps', 'ax', '-o', 'pid=,args='],
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

function tableText(result: SpawnPsResult): string {
  return result.exitCode === 0 ? result.text : '';
}

async function spawnPsText(args: readonly string[]): Promise<SpawnPsResult> {
  const proc = Bun.spawn([...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), PS_TIMEOUT_MS);
  try {
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { text: '', exitCode };
    return { text, exitCode };
  } catch {
    return { text: '', exitCode: 1 };
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

async function listLinuxProc(deps: ListProcessesDeps): Promise<ExternalProcess[] | null> {
  if ((deps.platform ?? process.platform) !== 'linux') return null;
  const procs = await listProcCmdlines(deps.procRoot ?? '/proc');
  return procs.length > 0 ? procs : null;
}

export async function defaultListProcesses(
  deps: ListProcessesDeps = {}
): Promise<ExternalProcess[]> {
  const fromProc = await listLinuxProc(deps);
  if (fromProc) return fromProc;
  const spawn = deps.spawnPs ?? spawnPsText;
  for (const args of PS_LIST_COMMANDS) {
    const text = tableText(await spawn(args));
    if (psTableLooksValid(text)) return parsePsOutput(text);
  }
  return [];
}
