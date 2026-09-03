import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
/**
 * Regenerate packages/app/src/vendor/node-datachannel from the pinned
 * node-datachannel version (devDependency). The native loader is rewritten so
 * Bun can inline the JS layer and require `<TMEX_NATIVE_DIR>/node_datachannel.node`,
 * and the copied upstream files are patched so they type-check under `strict`.
 *
 *   bun packages/app/scripts/vendor-node-datachannel.ts
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const PINNED_VERSION = '0.33.1';
const pkgRoot = resolve(import.meta.dir, '..');
const vendorRoot = join(pkgRoot, 'src/vendor/node-datachannel');
const detectLibcVendor = join(pkgRoot, 'src/vendor/detect-libc');
const appRequire = createRequire(join(pkgRoot, 'package.json'));

const ndcPkgJsonPath = appRequire.resolve('node-datachannel/package.json');
const ndcRoot = dirname(ndcPkgJsonPath);
const ndcPkg = JSON.parse(readFileSync(ndcPkgJsonPath, 'utf8')) as { version?: string };
if (ndcPkg.version !== PINNED_VERSION) {
  throw new Error(`expected node-datachannel@${PINNED_VERSION}, found ${ndcPkg.version}`);
}

const rewrittenLoader = `import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  AV1RtpPacketizer,
  Audio,
  H264RtpPacketizer,
  H265RtpPacketizer,
  IceUdpMuxListener,
  PacingHandler,
  PeerConnection,
  RtcpNackResponder,
  RtcpReceivingSession,
  RtcpSrReporter,
  RtpPacketizationConfig,
  RtpPacketizer,
  Track,
  Video,
} from './index';
import type {
  Direction,
  LogLevel,
  NalUnitSeparator,
  ObuPacketization,
  RtcConfig,
  SctpSettings,
  WebSocketServerConfiguration,
} from './types';
import type { WebSocket } from './websocket';

const require = createRequire(import.meta.url);

export interface NativeWebSocketServer {
  port(): number;
  stop(): void;
  onClient(cb: (client: WebSocket) => void): void;
}

export interface NativeBinding {
  preload(): void;
  initLogger(level: LogLevel, cb?: (level: LogLevel, message: string) => void): void;
  cleanup(): void;
  setSctpSettings(settings: SctpSettings): void;
  getLibraryVersion(): string;
  Audio: new (mid: string, dir: Direction) => Audio;
  Video: new (mid: string, dir: Direction) => Video;
  Track: new () => Track;
  DataChannel: object;
  PeerConnection: new (peerName: string, config: RtcConfig) => PeerConnection;
  IceUdpMuxListener: new (port: number, address?: string) => IceUdpMuxListener;
  RtpPacketizationConfig: new (
    ssrc: number,
    cname: string,
    payloadType: number,
    clockRate: number,
    videoOrientationId?: number
  ) => RtpPacketizationConfig;
  PacingHandler: new (bitsPerSecond: number, sendInterval: number) => PacingHandler;
  RtcpReceivingSession: new () => RtcpReceivingSession;
  RtcpNackResponder: new (maxSize?: number) => RtcpNackResponder;
  RtcpSrReporter: new (rtpConfig: RtpPacketizationConfig) => RtcpSrReporter;
  RtpPacketizer: new (rtpConfig: RtpPacketizationConfig) => RtpPacketizer;
  H264RtpPacketizer: new (
    separator: NalUnitSeparator,
    rtpConfig: RtpPacketizationConfig,
    maxFragmentSize?: number
  ) => H264RtpPacketizer;
  H265RtpPacketizer: new (
    separator: NalUnitSeparator,
    rtpConfig: RtpPacketizationConfig,
    maxFragmentSize?: number
  ) => H265RtpPacketizer;
  AV1RtpPacketizer: new (
    packetization: ObuPacketization,
    rtpConfig: RtpPacketizationConfig,
    maxFragmentSize?: number
  ) => AV1RtpPacketizer;
  WebSocket: new (config?: WebSocketServerConfiguration) => WebSocket;
  WebSocketServer: new (options: WebSocketServerConfiguration) => NativeWebSocketServer;
}

let binding: NativeBinding | null = null;

export function loadBindingFromPath(nativePath: string): NativeBinding {
  if (binding) {
    return binding;
  }
  if (!existsSync(nativePath)) {
    throw new Error(\`node-datachannel native addon not found: \${nativePath}\`);
  }
  binding = require(nativePath) as NativeBinding;
  return binding;
}

export function loadBinding(): NativeBinding {
  if (binding) {
    return binding;
  }
  const nativeDir = process.env.TMEX_NATIVE_DIR;
  if (!nativeDir) {
    throw new Error('TMEX_NATIVE_DIR is not set');
  }
  return loadBindingFromPath(join(nativeDir, 'node_datachannel.node'));
}

const nodeDataChannel = new Proxy({} as NativeBinding, {
  get(_target, prop) {
    return Reflect.get(loadBinding(), prop);
  },
});

export default nodeDataChannel;
`;

/**
 * 上游这两个文件在 tmex 的 `strict` 配置下有隐式 any，逐段替换而不是整体重写，
 * 这样升级 node-datachannel 时上游其余改动仍会被带进来；模式对不上就直接报错。
 */
const strictPatches: Record<string, Array<[from: string, to: string]>> = {
  'datachannel-stream.ts': [
    [
      "/* eslint-disable @typescript-eslint/no-explicit-any */\nimport * as stream from 'stream';",
      "import * as stream from 'stream';\nimport type { DataChannel } from './index';",
    ],
    ['  private _rawChannel: any;', '  private _rawChannel: DataChannel;'],
    [
      'constructor(rawChannel: any, streamOptions',
      'constructor(rawChannel: DataChannel, streamOptions',
    ],
    [
      'rawChannel.onMessage((msg: any) => {',
      'rawChannel.onMessage((msg: string | Buffer | ArrayBuffer) => {',
    ],
    [
      '  _write(chunk, _encoding, callback): void {\n    let sentOk;',
      '  _write(chunk: unknown, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {\n    let sentOk: boolean;',
    ],
    [
      '        const typeName = chunk.constructor.name || typeof chunk;',
      '        const typeName = chunk == null ? typeof chunk : chunk.constructor.name || typeof chunk;',
    ],
    [
      '    } catch (err) {\n      return callback(err);\n    }',
      '    } catch (err) {\n      callback(err instanceof Error ? err : new Error(String(err)));\n      return;\n    }',
    ],
    ['  _final(callback): void {', '  _final(callback: (err?: Error | null) => void): void {'],
    [
      '  _destroy(maybeErr, callback): void {',
      '  _destroy(maybeErr: Error | null, callback: (err?: Error | null) => void): void {',
    ],
  ],
  'websocket-server.ts': [
    [
      "import nodeDataChannel from './node-datachannel';",
      "import nodeDataChannel, { type NativeWebSocketServer } from './node-datachannel';",
    ],
    [
      '  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  #server: any;',
      '  #server: NativeWebSocketServer | null;',
    ],
  ],
};

rmSync(vendorRoot, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });

const libSrc = join(ndcRoot, 'src/lib');
for (const file of [
  'types.ts',
  'index.ts',
  'datachannel-stream.ts',
  'websocket.ts',
  'websocket-server.ts',
]) {
  cpSync(join(libSrc, file), join(vendorRoot, file));
  const patches = strictPatches[file];
  if (!patches) continue;
  const target = join(vendorRoot, file);
  let source = readFileSync(target, 'utf8');
  for (const [from, to] of patches) {
    if (!source.includes(from)) {
      throw new Error(`[vendor-node-datachannel] patch target missing in ${file}: ${from}`);
    }
    source = source.replaceAll(from, to);
  }
  writeFileSync(target, source);
}
writeFileSync(join(vendorRoot, 'node-datachannel.ts'), rewrittenLoader);
cpSync(join(ndcRoot, 'LICENSE'), join(vendorRoot, 'LICENSE'));
writeFileSync(
  join(vendorRoot, 'NOTICE.md'),
  `# node-datachannel ${PINNED_VERSION} (vendored)

License: Mozilla Public License 2.0 (see LICENSE).

Upstream: https://github.com/murat-dogan/node-datachannel

Modifications by tmex:

- Replaced optionalDependency / local-build loader with an absolute-path
  \`require\` of \`<TMEX_NATIVE_DIR>/node_datachannel.node\` (or
  \`loadBindingFromPath\`), typed through \`NativeBinding\`.
- Annotated the implicit \`any\` in \`datachannel-stream.ts\` /
  \`websocket-server.ts\` so the vendored copy passes \`tsc --strict\`.
- Dropped \`detect-libc\` from this JS layer; libc detection lives in
  \`packages/app/src/lib/native-manifest.ts\` and is used by \`tmex direct enable\`.
`
);

const ndcRequire = createRequire(join(ndcRoot, 'package.json'));
const detectLibcRoot = dirname(ndcRequire.resolve('detect-libc/package.json'));
rmSync(detectLibcVendor, { recursive: true, force: true });
mkdirSync(detectLibcVendor, { recursive: true });
cpSync(join(detectLibcRoot, 'LICENSE'), join(detectLibcVendor, 'LICENSE'));
writeFileSync(
  join(detectLibcVendor, 'NOTICE.md'),
  `# detect-libc (vendored license)

Apache License 2.0. Upstream: https://github.com/lovell/detect-libc

tmex vendors the family-detection logic (glibc vs musl) in
\`packages/app/src/lib/native-manifest.ts\`. musl is unsupported in v1.
`
);

console.log(`[vendor-node-datachannel] wrote ${vendorRoot} from ${ndcRoot}@${PINNED_VERSION}`);
