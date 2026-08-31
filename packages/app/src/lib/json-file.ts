import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir, writeTextAtomic } from './fs-utils';

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as T;
}

export async function writeJsonFile(path: string, value: unknown, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
