export interface ManagedGatewayArgs {
  version: boolean;
  tmuxNamespace?: string;
}

const TMUX_NAMESPACE_ENV = 'TMEX_TMUX_SOCKET';
const TMUX_NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateTmuxNamespace(value: string): string {
  if (!TMUX_NAMESPACE_RE.test(value) || value.toLowerCase() === 'default') {
    throw new Error('--tmux-namespace must be a safe, non-default name of at most 64 characters');
  }
  return value;
}

export function parseManagedGatewayArgs(argv: readonly string[]): ManagedGatewayArgs {
  let version = false;
  let tmuxNamespace: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--version') {
      if (version) {
        throw new Error('--version may only be specified once');
      }
      version = true;
      continue;
    }
    if (argument === '--tmux-namespace') {
      if (tmuxNamespace !== undefined) {
        throw new Error('--tmux-namespace may only be specified once');
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--tmux-namespace requires a value');
      }
      tmuxNamespace = validateTmuxNamespace(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown managed Gateway argument: ${argument}`);
  }

  if (version && tmuxNamespace !== undefined) {
    throw new Error('--version cannot be combined with --tmux-namespace');
  }
  return { version, tmuxNamespace };
}

export function applyManagedTmuxNamespace(
  env: Record<string, string | undefined>,
  tmuxNamespace: string | undefined
): void {
  if (tmuxNamespace === undefined) {
    Reflect.deleteProperty(env, TMUX_NAMESPACE_ENV);
    return;
  }
  env[TMUX_NAMESPACE_ENV] = validateTmuxNamespace(tmuxNamespace);
}
