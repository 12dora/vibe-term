import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Page, expect } from '@playwright/test';

export interface MeshState {
  baseUrl: string;
  hubPort: number;
  nodePort: number;
  username: string;
  password: string;
  uid: string;
  hubNodeId: string;
  remoteNodeId: string;
  remoteNodeName: string;
  hubTmuxSocket: string;
  nodeTmuxSocket: string;
  supervisorPid: number;
  tmpDir: string;
}

const BOOT_SCRIPT = join('apps', 'fe', 'tests', 'helpers', 'mesh-boot.ts');

export function meshStatePath(): string {
  return process.env.TMEX_MESH_E2E_STATE || '/tmp/tmex-mesh-e2e-state.json';
}

// Playwright 在 CJS / ESM 两种转译下 __dirname 与 import.meta 各只有一个可用，
// 这里改为从 cwd 上溯找 boot 脚本，两种模式都成立。
function repoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, BOOT_SCRIPT))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`repo root not found from ${process.cwd()}`);
    current = parent;
  }
}

function bunExecutable(): string {
  const explicit = process.env.TMEX_E2E_BUN;
  if (explicit) return explicit;
  const home = process.env.HOME;
  if (home) {
    const candidate = join(home, '.bun', 'bin', 'bun');
    if (existsSync(candidate)) return candidate;
  }
  return 'bun';
}

export function readMeshState(): MeshState {
  const path = meshStatePath();
  if (!existsSync(path)) {
    throw new Error(
      `mesh state not found at ${path}; run the mesh e2e via \`bun run scripts/run-e2e.ts --project mesh\``
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as MeshState;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** 拉起 hub + node 主管进程（detached），等 state 文件落盘。 */
export async function bootMesh(timeoutMs = 240_000): Promise<MeshState> {
  const statePath = meshStatePath();
  const logPath = `${statePath.replace(/\.json$/, '')}.log`;
  rmSync(statePath, { force: true });
  rmSync(logPath, { force: true });

  const root = repoRoot();
  const child = spawn(bunExecutable(), [resolve(root, BOOT_SCRIPT), '--state', statePath], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      child.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      return readMeshState();
    }
    if (exited) {
      throw new Error(`mesh-boot exited before writing state:\n${output}`);
    }
    await sleep(500);
  }
  child.kill('SIGTERM');
  throw new Error(`mesh-boot timed out after ${timeoutMs}ms:\n${output}`);
}

export async function stopMesh(): Promise<void> {
  const statePath = meshStatePath();
  if (!existsSync(statePath)) return;
  const state = readMeshState();
  try {
    process.kill(state.supervisorPid, 'SIGTERM');
  } catch {
    // already gone
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      process.kill(state.supervisorPid, 0);
    } catch {
      break;
    }
    await sleep(200);
  }
  try {
    process.kill(state.supervisorPid, 'SIGKILL');
  } catch {
    // already gone
  }
  rmSync(state.tmpDir, { recursive: true, force: true });
  rmSync(statePath, { force: true });
}

export function meshUrl(state: MeshState, path: string): string {
  return `${state.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 在 mesh e2e 专用 tmux socket 上执行命令；socket 名与生产/默认 socket 完全隔离。 */
export function meshTmux(socket: string, args: string): string {
  const result = spawnSync('sh', ['-c', `tmux -L ${socket} ${args}`], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`tmux -L ${socket} ${args} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function createRemoteTmuxSession(state: MeshState, sessionName: string): void {
  spawnSync('sh', ['-c', `tmux -L ${state.nodeTmuxSocket} kill-session -t ${sessionName}`], {
    stdio: 'ignore',
  });
  meshTmux(
    state.nodeTmuxSocket,
    `new-session -d -s ${sessionName} "sh -lc 'echo PANE0_READY; exec sh'"`
  );
}

export function killRemoteTmuxSession(state: MeshState, sessionName: string): void {
  spawnSync('sh', ['-c', `tmux -L ${state.nodeTmuxSocket} kill-session -t ${sessionName}`], {
    stdio: 'ignore',
  });
}

/** 走真实登录页做密码登录，等待 fan-out 完成、侧边栏渲染。 */
export async function loginWithPassword(page: Page, state: MeshState): Promise<void> {
  await page.goto(meshUrl(state, '/login'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('login-username').fill(state.username);
  await page.getByTestId('login-password').fill(state.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 90_000 });
}

export async function logout(page: Page): Promise<void> {
  await page
    .evaluate(() =>
      fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(() => undefined)
    )
    .catch(() => undefined);
  await page.context().clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/** CDP 虚拟认证器：让 WebAuthn 注册/断言在无头 Chromium 里可以自动完成。 */
export async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** 读整个 xterm buffer（不止视口），marker 被滚出屏幕时也能命中。 */
export async function readTerminalBuffer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as unknown as { __tmexE2eXterm?: XtermHandle }).__tmexE2eXterm;
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  });
}

interface XtermHandle {
  buffer: {
    active: {
      length: number;
      getLine: (y: number) => { translateToString: (trim: boolean) => string } | null;
    };
  };
}

export async function createDeviceOnNode(
  page: Page,
  state: MeshState,
  nodeId: string,
  input: { name: string; session: string }
): Promise<string> {
  const res = await page.request.post(meshUrl(state, `/n/${nodeId}/api/devices`), {
    data: { name: input.name, type: 'local', session: input.session, authMode: 'auto' },
  });
  expect(res.ok(), `create device on ${nodeId}: ${res.status()} ${await res.text()}`).toBeTruthy();
  const created = (await res.json()) as { device: { id: string } };
  return created.device.id;
}

export async function deleteDeviceOnNode(
  page: Page,
  state: MeshState,
  nodeId: string,
  deviceId: string
): Promise<void> {
  await page.request
    .delete(meshUrl(state, `/n/${nodeId}/api/devices/${deviceId}`))
    .catch(() => undefined);
}
