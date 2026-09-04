import type { CommandSpec } from '@tmex/shared/messaging';

export interface CommandRegistry {
  register(spec: CommandSpec): void;
  find(nameOrAlias: string): CommandSpec | null;
  list(): CommandSpec[];
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export function createCommandRegistry(): CommandRegistry {
  const byName = new Map<string, CommandSpec>();
  const aliases = new Map<string, string>();

  return {
    register(spec) {
      const name = normalize(spec.name);
      byName.set(name, { ...spec, name });
      for (const alias of spec.aliases) {
        aliases.set(normalize(alias), name);
      }
    },
    find(nameOrAlias) {
      const key = normalize(nameOrAlias);
      const name = byName.has(key) ? key : (aliases.get(key) ?? null);
      if (!name) return null;
      return byName.get(name) ?? null;
    },
    list() {
      return [...byName.values()];
    },
  };
}
