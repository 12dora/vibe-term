// `bun test` 预载：把本进程的 HOME 与 os.homedir() 钉到本次运行独占的临时目录。
// packages/app 的代码里有多处按主目录推导路径（shim、launchd plist、systemd unit、bun 探测），
// 单元测试一旦漏注入目录就会写穿用户真实的 ~/.local/bin、~/.bun/bin、~/Library/LaunchAgents。
// 这里是最后一道防线：即便某个调用点回落到默认值，落点也只会在临时目录里。
import { mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { join } from 'node:path';

const sandboxHome = mkdtempSync(join(nodeOs.tmpdir(), 'vibeterm-test-home-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

// bun 在进程启动时就把 HOME 快照进了 os.homedir()，改 process.env 追不上，只能整体替换模块。
const homedir = (): string => sandboxHome;
mock.module('node:os', () => ({ ...nodeOs, homedir, default: { ...nodeOs, homedir } }));

process.on('exit', () => {
  rmSync(sandboxHome, { recursive: true, force: true });
});
