// `vibeterm auth`：登录历史与登录限制。扇出方式与 `vibeterm login` 相同。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  type LoginRecord,
  type LoginRecordsQuery,
  MIN_LOGIN_RECORDS_VERSION,
} from '@vibeterm/shared';
import type { FlagValues } from '../core/args';
import { flagBool, flagNumber } from '../core/args';
import { callAuthNodes } from '../core/auth-fanout';
import {
  type HistoryView,
  formatRetention,
  historyColumns,
  parseHistoryLimit,
  parseRetentionToken,
} from '../core/auth-format';
import {
  type AuthCallFailure,
  type AuthSkip,
  type AuthTarget,
  type ExplicitAuthNode,
  authFanoutExit,
  describeSkip,
  planAuthTargets,
} from '../core/auth-nodes';
import {
  buildPolicyFromFlags,
  formatPolicyLines,
  parsePolicySnapshot,
  policyBlockedMessage,
  signLoginPolicy,
} from '../core/auth-policy';
import {
  clearLoginRecords,
  getLoginPolicy,
  getLoginRetention,
  listLoginRecords,
  putLoginRetention,
} from '../core/auth-remote';
import { type SubHandler, confirmOrYes, emit, rejectExtra, runSubs } from '../core/cmd';
import type { CliContext } from '../core/context';
import { CliError, NotFoundError, UsageError } from '../core/errors';
import { readAccountPassword } from '../core/nodes-keylog';
import { readAllStdin } from '../core/prompt';
import type { Command } from './types';

const FLAGS = {
  failed: 'boolean',
  all: 'boolean',
  limit: 'number',
  yes: 'boolean',
  preset: 'string',
  custom: 'boolean',
  'ip-threshold': 'number',
  'ip-lock': 'string',
  'ip-lock-max': 'string',
  'account-per-hour': 'number',
  'account-lock': 'string',
  'no-exempt-local': 'boolean',
  'password-stdin': 'boolean',
} as const;

const USAGE = [
  'Usage: vibeterm auth <history|policy> …',
  '',
  '  history [--failed] [--all] [--limit N]',
  '      Login records on every reachable node (2.10.0+).',
  '      Default: successful interactive logins. --failed lists failures (with CODE).',
  '      --all includes background fan-out rows. --node limits to one node.',
  '  history clear [--yes]',
  '      Delete records on every reachable node.',
  '  history retention [7|30|90|180|forever]',
  '      Show or set how long each reachable node keeps records.',
  '  policy',
  '      Show the effective login rate-limit policy, its source, and blockers.',
  '  policy set --preset relaxed|standard|strict',
  '  policy set --custom --ip-threshold N --ip-lock 15m --ip-lock-max 24h',
  '              --account-per-hour N --account-lock 15m [--no-exempt-local]',
  '      Sign a login-policy record. Password: TTY, --password-stdin, or VIBETERM_PASSWORD.',
  '      Log in first (vibeterm login asks for TOTP when it is enabled).',
  '',
  'Offline nodes and nodes older than 2.10.0 are skipped.',
  '--node is the global flag (id or name). --json prints the payload on stdout.',
].join('\n');

interface AuthPlan {
  targets: AuthTarget[];
  skipped: AuthSkip[];
  names: Map<string, string>;
}

async function loadPlan(ctx: CliContext): Promise<AuthPlan> {
  const roster = await ctx.resolver.listNodes();
  const entryId = await ctx.resolver.entryNodeId();
  const explicit = await explicitNode(ctx);
  const names = new Map<string, string>();
  for (const node of roster) names.set(node.id, node.name);
  if (entryId) names.set(SELF_NODE_ID, names.get(entryId) ?? 'self');
  return {
    ...planAuthTargets({
      roster,
      entryId,
      explicit,
      minVersion: MIN_LOGIN_RECORDS_VERSION,
    }),
    names,
  };
}

async function explicitNode(ctx: CliContext): Promise<ExplicitAuthNode | null> {
  if (!ctx.globals.node) return null;
  const resolved = await ctx.resolver.resolveNode(ctx.globals.node);
  return { nodeId: resolved.id, name: resolved.name, row: resolved.row };
}

function reportPlan(
  ctx: CliContext,
  skipped: readonly AuthSkip[],
  failures: readonly AuthCallFailure[],
  successes: number
): number {
  for (const skip of skipped) ctx.out.warn(describeSkip(skip));
  for (const failure of failures) {
    ctx.out.warn(`${failure.name}: ${failure.message}`);
    if (failure.hint) ctx.out.warn(`  ${failure.hint}`);
  }
  return authFanoutExit({
    explicit: ctx.globals.node !== null,
    skipped,
    failures,
    successes,
  });
}

function historyQuery(flags: FlagValues): LoginRecordsQuery {
  const failed = flagBool(flags, 'failed');
  return {
    outcome: failed ? 'failed' : 'success',
    kind: failed || flagBool(flags, 'all') ? 'all' : 'interactive',
    limit: parseHistoryLimit(flagNumber(flags, 'limit')),
  };
}

function toView(target: AuthTarget, row: LoginRecord): HistoryView {
  return {
    at: row.at,
    nodeId: target.nodeId,
    nodeName: target.name,
    client: row.client,
    method: row.method,
    second: row.second,
    ip: row.ip,
    userAgent: row.userAgent,
    kind: row.kind,
    viaNodeId: row.viaNodeId,
    code: row.code,
  };
}

const history: SubHandler = async (ctx, flags, positionals) => {
  const action = positionals[0];
  if (!action) return listHistory(ctx, flags, positionals);
  if (action === 'clear') return clearHistory(ctx, flags, positionals);
  if (action === 'retention') return retentionHistory(ctx, flags, positionals);
  throw new UsageError(
    `unknown history action: ${action}`,
    'use history, history clear, or history retention'
  );
};

async function listHistory(
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[]
): Promise<number> {
  rejectExtra(positionals, 0);
  const query = historyQuery(flags);
  const plan = await loadPlan(ctx);
  const outcome = await callAuthNodes({
    targets: plan.targets,
    call: (target) => listLoginRecords(ctx.http, target.nodeId, query),
  });
  const records = outcome.values
    .flatMap(({ target, value }) => value.map((row) => toView(target, row)))
    .sort((left, right) => right.at - left.at);
  const skipped = [...plan.skipped, ...outcome.skipped];
  const code = reportPlan(ctx, skipped, outcome.failures, outcome.values.length);
  emit(ctx, { records, skipped, failures: outcome.failures }, () => {
    ctx.out.table(records, historyColumns(query.outcome === 'failed', plan.names));
  });
  return code;
}

async function clearHistory(
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[]
): Promise<number> {
  rejectExtra(positionals, 1);
  const plan = await loadPlan(ctx);
  if (plan.targets.length === 0) return reportPlan(ctx, plan.skipped, [], 0);
  await confirmOrYes(flags, 'clear login history on every selected node');
  const outcome = await callAuthNodes({
    targets: plan.targets,
    call: (target) => clearLoginRecords(ctx.http, target.nodeId),
  });
  const code = reportPlan(
    ctx,
    [...plan.skipped, ...outcome.skipped],
    outcome.failures,
    outcome.values.length
  );
  emit(
    ctx,
    {
      cleared: outcome.values.map(({ target, value }) => ({
        nodeId: target.nodeId,
        name: target.name,
        deleted: value,
      })),
      skipped: [...plan.skipped, ...outcome.skipped],
    },
    () => {
      for (const row of outcome.values) ctx.out.line(`cleared ${row.target.name}: ${row.value}`);
    }
  );
  return code;
}

async function retentionHistory(
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[]
): Promise<number> {
  const token = positionals[1];
  rejectExtra(positionals, token ? 2 : 1);
  const days = token ? parseRetentionToken(token) : null;
  const plan = await loadPlan(ctx);
  const outcome = await callAuthNodes({
    targets: plan.targets,
    call: (target) =>
      days === null
        ? getLoginRetention(ctx.http, target.nodeId)
        : putLoginRetention(ctx.http, target.nodeId, days),
  });
  const code = reportPlan(
    ctx,
    [...plan.skipped, ...outcome.skipped],
    outcome.failures,
    outcome.values.length
  );
  const rows = outcome.values.map(({ target, value }) => ({
    nodeId: target.nodeId,
    name: target.name,
    retentionDays: value,
    retention: formatRetention(value),
  }));
  emit(ctx, { nodes: rows, skipped: [...plan.skipped, ...outcome.skipped] }, () => {
    ctx.out.table(rows, [
      { header: 'NODE', value: (row) => row.name },
      { header: 'RETENTION', value: (row) => row.retention },
    ]);
  });
  return code;
}

async function readPolicyPassword(flags: FlagValues): Promise<string> {
  if (flagBool(flags, 'password-stdin')) {
    const value = await readAllStdin();
    if (!value) throw new UsageError('--password-stdin got an empty password');
    return value;
  }
  return readAccountPassword();
}

async function showPolicy(ctx: CliContext): Promise<number> {
  const nodeId = ctx.globals.node
    ? (await ctx.resolver.resolveNode(ctx.globals.node)).id
    : SELF_NODE_ID;
  let snapshot: ReturnType<typeof parsePolicySnapshot>;
  try {
    snapshot = parsePolicySnapshot(await getLoginPolicy(ctx.http, nodeId));
  } catch (error) {
    if (error instanceof NotFoundError) {
      ctx.out.warn(`login policy needs upgrade to ${MIN_LOGIN_RECORDS_VERSION}`);
      return 0;
    }
    throw error;
  }
  emit(ctx, snapshot, () => {
    for (const line of formatPolicyLines(snapshot)) ctx.out.line(line);
  });
  return 0;
}

async function setPolicy(
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[]
): Promise<number> {
  rejectExtra(positionals, 1);
  const policy = buildPolicyFromFlags(flags);
  const snapshot = parsePolicySnapshot(await getLoginPolicy(ctx.http, SELF_NODE_ID));
  if (!snapshot.writable) throw new CliError(policyBlockedMessage(snapshot));
  const password = await readPolicyPassword(flags);
  const result = await signLoginPolicy(ctx, policy, password);
  emit(ctx, { policy, result }, () => {
    ctx.out.line(`login policy set to ${policy.preset}`);
  });
  return 0;
}

const policy: SubHandler = async (ctx, flags, positionals) => {
  const action = positionals[0];
  if (!action) {
    rejectExtra(positionals, 0);
    return showPolicy(ctx);
  }
  if (action === 'set') return setPolicy(ctx, flags, positionals);
  throw new UsageError(`unknown policy action: ${action}`, 'use policy or policy set');
};

const HANDLERS: Record<string, SubHandler> = { history, policy };

export const command: Command = {
  name: 'auth',
  summary: 'login history and rate-limit policy',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm auth --help'),
};
