import { joinShellArgs, quoteShellArg } from '../tmux-client/command-builder';
import type { ExecRequest } from './types';

export function buildSshRemoteCommand(req: ExecRequest): string {
  const payload = req.shell
    ? `/bin/sh -c ${quoteShellArg(req.argv[0] ?? '')}`
    : joinShellArgs(req.argv);
  const envAssigns = envAssignments(req.env);
  const run = envAssigns ? `env ${envAssigns} ${payload}` : `exec ${payload}`;
  return req.cwd ? `cd ${quoteShellArg(req.cwd)} && ${run}` : run;
}

function envAssignments(env: Record<string, string> | undefined): string | null {
  if (!env) return null;
  const keys = Object.keys(env);
  if (keys.length === 0) return null;
  return keys.map((key) => `${key}=${quoteShellArg(env[key] ?? '')}`).join(' ');
}
