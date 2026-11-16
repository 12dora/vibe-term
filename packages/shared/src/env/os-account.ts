import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

export interface OsAccount {
  username: string;
  homedir: string;
  shell: string | null;
  uid: number;
  gid: number;
}

export interface OsAccountDeps {
  userInfo?: () => {
    username: string;
    homedir: string;
    shell: string | null;
    uid: number;
    gid: number;
  };
  readPasswd?: () => string | null;
  env?: NodeJS.ProcessEnv;
}

function readEtcPasswd(): string | null {
  try {
    return readFileSync('/etc/passwd', 'utf8');
  } catch {
    return null;
  }
}

function usable(value: string | null | undefined): value is string {
  return !!value && value !== 'unknown';
}

type PasswdEntry = { username: string; homedir: string; shell: string };

function parsePasswdLine(raw: string): (PasswdEntry & { uid: number }) | null {
  const line = raw.replace(/\r$/, '');
  if (!line || line.startsWith('#')) return null;
  const fields = line.split(':');
  if (fields.length < 7 || !fields[0] || !/^\d+$/.test(fields[2] ?? '')) return null;
  return {
    username: fields[0],
    uid: Number(fields[2]),
    homedir: fields[5] ?? '',
    shell: fields[6] ?? '',
  };
}

export function passwdEntriesForUid(content: string | null, uid: number): PasswdEntry[] {
  if (!content || uid < 0) return [];
  const entries: PasswdEntry[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parsePasswdLine(raw);
    if (!parsed || parsed.uid !== uid) continue;
    entries.push({ username: parsed.username, homedir: parsed.homedir, shell: parsed.shell });
  }
  return entries;
}

export function passwdEntryForUid(content: string | null, uid: number): PasswdEntry | null {
  return passwdEntriesForUid(content, uid)[0] ?? null;
}

function safeUserInfo(deps: OsAccountDeps): OsAccount {
  try {
    const info = (deps.userInfo ?? userInfo)();
    return {
      username: info.username,
      homedir: info.homedir,
      shell: info.shell,
      uid: info.uid,
      gid: info.gid,
    };
  } catch {
    const env = deps.env ?? process.env;
    return {
      username: 'unknown',
      homedir: env.HOME ?? '',
      shell: env.SHELL ?? null,
      uid: process.getuid?.() ?? -1,
      gid: process.getgid?.() ?? -1,
    };
  }
}

/**
 * Bun 的 os.userInfo() 只读 $USER / $SHELL：缺失时是 "unknown"，`su`（不带 -）或 `sudo -E`
 * 后又是切换前的旧用户名。/etc/passwd 里有该 uid 的条目时以它为准（同 uid 别名保留原名）。
 */
function reconcileWithPasswd(account: OsAccount, readPasswd: () => string | null): OsAccount {
  const entries = passwdEntriesForUid(readPasswd(), account.uid);
  const primary = entries[0];
  if (!primary) return account;
  const nameMatches = entries.some((entry) => entry.username === account.username);
  return {
    ...account,
    username: nameMatches ? account.username : primary.username,
    shell: usable(account.shell) ? account.shell : primary.shell || null,
    homedir: account.homedir || primary.homedir,
  };
}

export function currentOsAccount(deps: OsAccountDeps = {}): OsAccount {
  const account = reconcileWithPasswd(safeUserInfo(deps), deps.readPasswd ?? readEtcPasswd);
  const env = deps.env ?? process.env;
  const username = usable(account.username)
    ? account.username
    : env.USER || env.LOGNAME || account.username;
  return { ...account, username, shell: usable(account.shell) ? account.shell : null };
}
