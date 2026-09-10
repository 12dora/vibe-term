// `vibeterm api`：REST 逃生通道。任何还没被包成命令组的端点都能从这里打。

import { readFile } from 'node:fs/promises';
import { flagBool, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { CliError, UsageError } from '../core/errors';
import { loginRequiredError } from '../core/http';
import type { Command } from './types';

const FLAGS = { body: 'string', raw: 'boolean' } as const;

const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export function parseMethod(raw: string | undefined): string {
  const method = (raw ?? '').toUpperCase();
  if (!METHODS.has(method)) {
    throw new UsageError(
      `unsupported method: ${raw ?? '(missing)'}`,
      `use one of ${[...METHODS].join(', ')}`
    );
  }
  return method;
}

export function parsePath(raw: string | undefined): string {
  if (!raw) throw new UsageError('missing path, e.g. /api/system/info');
  if (!raw.startsWith('/')) throw new UsageError(`path must start with "/": ${raw}`);
  return raw;
}

/** `@file` 读文件，其余按字面 JSON；两条路径都要求是合法 JSON。 */
export async function resolveBody(spec: string | undefined): Promise<string | undefined> {
  if (spec === undefined) return undefined;
  const text = spec.startsWith('@') ? await readFile(spec.slice(1), 'utf8') : spec;
  try {
    JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `--body is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
  return text;
}

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('json');
}

async function run(ctx: CliContext, argv: string[]): Promise<undefined> {
  const { flags, positionals } = parseArgv(argv, FLAGS);
  const method = parseMethod(positionals[0]);
  const path = parsePath(positionals[1]);
  if (positionals.length > 2) {
    throw new UsageError(`unexpected argument: ${positionals[2]}`);
  }
  const body = await resolveBody(flagString(flags, 'body'));
  const nodeId = await ctx.targetNodeId();

  const response = await ctx.http.fetch(nodeId, path, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  });

  const raw = flagBool(flags, 'raw');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const body = new TextDecoder().decode(bytes).trim();
    // 401/403 是「去登录」，其余非 2xx 都是普通失败：原样把响应体交给调用方。
    if (response.status === 401 || response.status === 403) {
      throw loginRequiredError(nodeId, body);
    }
    throw new CliError(`${method} ${path} → HTTP ${response.status}${body ? `\n${body}` : ''}`);
  }
  if (raw) {
    ctx.out.raw(bytes);
    return;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    ctx.out.info(`${method} ${path} → HTTP ${response.status} (empty body)`);
    return;
  }
  if (!isJson(response)) {
    ctx.out.line(text.replace(/\n$/, ''));
    return;
  }
  ctx.out.data(JSON.parse(text));
}

export const command: Command = {
  name: 'api',
  summary: 'call any gateway REST endpoint on the entry or a node',
  usage: [
    'Usage: vibeterm api <METHOD> <path> [options]',
    '',
    'Options:',
    '  --node <id|name>   send through the entry to this node (/n/<id><path>)',
    '  --body <json|@file>  request body (must be valid JSON)',
    '  --raw              write the response bytes to stdout untouched',
    '',
    'Examples:',
    '  vibeterm api GET /api/system/info',
    '  vibeterm api POST /api/devices --body @device.json',
    '',
    'Exit codes: 3 when the node needs a login, 1 for any other non-2xx status.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
