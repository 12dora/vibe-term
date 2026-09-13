// `vibeterm nodes hub-role promote|demote|standby <node>`

import { flagBool } from '../core/args';
import { type SubHandler, confirmOrYes, emit, rejectExtra, requireArg } from '../core/cmd';
import { CliError, UsageError } from '../core/errors';
import { fetchHubs, findMeshNode } from '../core/nodes-hub';
import { type HubRoleVerb, planHubRole, runHubRoleSwitch } from '../core/nodes-hub-role';

const VERBS: ReadonlySet<string> = new Set(['promote', 'demote', 'standby']);

function confirmText(verb: HubRoleVerb, name: string, id: string, leavesNoWriter: boolean): string {
  if (leavesNoWriter) return `${verb} ${name} (${id}); no writer hub will remain`;
  return `${verb} hub ${name} (${id})`;
}

export const hubRole: SubHandler = async (ctx, flags, positionals) => {
  const verbRaw = requireArg(positionals, 0, 'action (promote|demote|standby)');
  if (!VERBS.has(verbRaw)) {
    throw new UsageError(`unknown hub-role action: ${verbRaw}`, 'use promote|demote|standby');
  }
  const verb = verbRaw as HubRoleVerb;
  const ref = requireArg(positionals, 1, 'node');
  rejectExtra(positionals, 2);
  const node = await findMeshNode(ctx, ref);
  const hubs = await fetchHubs(ctx);
  const plan = planHubRole({
    verb,
    node,
    hubs,
    nameOf: (id) => (id === node.id ? node.name : id.slice(0, 8)),
  });
  await confirmOrYes(flags, confirmText(verb, node.name, node.id, plan.leavesNoWriter));
  const result = await runHubRoleSwitch(ctx, plan, {
    wait: flagBool(flags, 'wait'),
    force: flagBool(flags, 'force'),
  });
  emit(ctx, result, () => {
    const extra = result.error ? ` (${result.error})` : '';
    ctx.out.line(`hub-role ${verb} ${node.name} ${result.kind}${extra}`);
  });
  if (result.kind === 'failed') {
    const hint =
      result.unsupported != null ? 'retry with --force after reviewing old nodes' : undefined;
    throw new CliError(`hub-role ${verb} failed: ${result.error ?? result.kind}`, 1, hint);
  }
  return result.kind === 'done' ? 0 : 1;
};
