// term / tmux 两组单测用的假件：一条不走网络的 Gateway transport，以及一份挂着它的 ctx。
// 仅供 *.test.ts 使用；main.ts 不 import 它，也就不会进 bundle。

import type { StateSnapshotPayload, TmuxSession } from '@vibeterm/shared';
import type {
  GatewayTransport,
  GatewayTransportCommand,
  GatewayTransportEvent,
} from '@vibeterm/ws-client';

type EventHandler = (event: GatewayTransportEvent) => void;
import { Writable } from 'node:stream';
import { type BuildContextOptions, type CliContext, buildContext } from './context';
import type { FetchLike } from './http';

export const FAKE_ENTRY = 'http://entry.test:9883';
export const FAKE_DEVICE_ID = 'device-1';
export const FAKE_DEVICE_NAME = 'laptop';

export interface Collector {
  stream: Writable;
  text(): string;
}

export function collector(): Collector {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function snapshotOf(session: TmuxSession | null): StateSnapshotPayload {
  return { deviceId: FAKE_DEVICE_ID, session };
}

/** 手工驱动的 transport：命令进 `commands`，事件由测试用 `emit*` 推。 */
export class FakeTransport implements Pick<GatewayTransport, 'send' | 'onEvent'> {
  readonly commands: GatewayTransportCommand[] = [];
  private readonly handlers = new Set<EventHandler>();
  /** 每条命令发出后的钩子：测试用它模拟服务端的回应。 */
  onCommand: ((command: GatewayTransportCommand) => void) | null = null;
  private sentSnapshot = false;

  constructor(private session: TmuxSession | null) {}

  send(command: GatewayTransportCommand): boolean {
    this.commands.push(command);
    if (command.type === 'connect-device') {
      queueMicrotask(() => {
        this.emit({ type: 'device-connected', deviceId: command.deviceId });
        this.emitTree(this.session);
      });
    }
    this.onCommand?.(command);
    return true;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: GatewayTransportEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  /** 推一份新的会话树（首份走 snapshot，之后走 patch，与真网关一致）。 */
  emitTree(session: TmuxSession | null): void {
    this.session = session;
    if (this.sentSnapshot) {
      this.emit({
        type: 'metadata-patch',
        deviceId: FAKE_DEVICE_ID,
        snapshot: snapshotOf(session),
      });
      return;
    }
    this.sentSnapshot = true;
    this.emit({ type: 'metadata-snapshot', snapshot: snapshotOf(session) });
  }

  commandsOfType<T extends GatewayTransportCommand['type']>(
    type: T
  ): Array<Extract<GatewayTransportCommand, { type: T }>> {
    return this.commands.filter((command) => command.type === type) as Array<
      Extract<GatewayTransportCommand, { type: T }>
    >;
  }
}

const REST: FetchLike = async (input) => {
  const url = new URL(input);
  if (url.pathname === '/api/devices') {
    return Response.json({
      devices: [{ id: FAKE_DEVICE_ID, name: FAKE_DEVICE_NAME, type: 'local', session: 'main' }],
    });
  }
  if (url.pathname === '/api/mesh/nodes') return Response.json({ nodes: [] });
  return new Response('not found', { status: 404 });
};

export interface FakeTermContext {
  ctx: CliContext;
  transport: FakeTransport;
  stdout: Collector;
  stderr: Collector;
  closed(): number;
}

/** 一份指向假 transport 的 ctx；`configDir` 必须由调用方给一个临时目录。 */
export function createFakeTermContext(options: {
  session: TmuxSession | null;
  configDir: string;
  json?: boolean;
  timeoutMs?: number;
  overrides?: Partial<BuildContextOptions>;
}): FakeTermContext {
  const stdout = collector();
  const stderr = collector();
  const transport = new FakeTransport(options.session);
  let closes = 0;
  const base = buildContext({
    entryFlag: FAKE_ENTRY,
    node: null,
    json: options.json ?? false,
    quiet: false,
    noColor: true,
    configDir: options.configDir,
    installEntry: null,
    env: {},
    fetchImpl: REST,
    timeoutMs: options.timeoutMs ?? 2_000,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...options.overrides,
  });
  const ctx: CliContext = {
    ...base,
    async openSocket(nodeId) {
      return {
        connection: { transport } as never,
        nodeId,
        cid: () => 'cid',
        close: () => {
          closes += 1;
        },
      };
    },
  };
  return { ctx, transport, stdout, stderr, closed: () => closes };
}

export function fakeSession(overrides: Partial<TmuxSession> = {}): TmuxSession {
  return {
    id: '$0',
    name: 'main',
    windows: [
      {
        id: '@0',
        name: 'shell',
        index: 0,
        active: true,
        panes: [
          {
            id: '%0',
            windowId: '@0',
            index: 0,
            active: true,
            width: 80,
            height: 24,
            currentCommand: 'zsh',
            currentPath: '/home/u',
          },
        ],
      },
      {
        id: '@1',
        name: 'build',
        index: 1,
        active: false,
        panes: [
          {
            id: '%1',
            windowId: '@1',
            index: 0,
            active: true,
            width: 80,
            height: 24,
            currentCommand: 'vim',
            currentPath: '/srv',
          },
          {
            id: '%2',
            windowId: '@1',
            index: 1,
            active: false,
            width: 40,
            height: 24,
            currentCommand: 'tail',
            currentPath: '/var/log',
          },
        ],
      },
    ],
    ...overrides,
  };
}
