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

export function passwdEntryForUid(
  content: string | null,
  uid: number
): { username: string; homedir: string; shell: string } | null {
  if (!content || uid < 0) return null;
  for (const line of content.split('\n')) {
    const fields = line.split(':');
    if (fields.length < 7 || Number(fields[2]) !== uid || !fields[0]) continue;
    return { username: fields[0], homedir: fields[5] ?? '', shell: fields[6] ?? '' };
  }
  return null;
}

/**
 * Bun 的 os.userInfo() 只从 $USER / $SHELL 取用户名与 shell，缺失时返回 "unknown"
 *（docker exec、cron、部分 sudo 场景）；此时按 uid 查 /etc/passwd 兜底。
 */
function fillFromPasswd(account: OsAccount, readPasswd: () => string | null): OsAccount {
  if (usable(account.username) && usable(account.shell)) return account;
  const entry = passwdEntryForUid(readPasswd(), account.uid);
  if (!entry) return account;
  return {
    ...account,
    username: usable(account.username) ? account.username : entry.username,
    shell: usable(account.shell) ? account.shell : entry.shell || null,
    homedir: account.homedir || entry.homedir,
  };
}

export function currentOsAccount(deps: OsAccountDeps = {}): OsAccount {
  const info = (deps.userInfo ?? userInfo)();
  const account = fillFromPasswd(
    {
      username: info.username,
      homedir: info.homedir,
      shell: info.shell,
      uid: info.uid,
      gid: info.gid,
    },
    deps.readPasswd ?? readEtcPasswd
  );
  const env = deps.env ?? process.env;
  const username = usable(account.username)
    ? account.username
    : env.USER || env.LOGNAME || account.username;
  return { ...account, username, shell: usable(account.shell) ? account.shell : null };
}
