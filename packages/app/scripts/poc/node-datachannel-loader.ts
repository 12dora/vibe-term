import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
/**
 * PoC: prove node-datachannel's JS layer can be bundled by Bun.build with the
 * native `require` rewritten to an absolute path from TMEX_NATIVE_DIR, and that
 * a loopback PeerConnection pair works from the bundle.
 *
 * Not shipped. Run:
 *   bun packages/app/scripts/poc/node-datachannel-loader.ts
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const pkgRoot = resolve(import.meta.dir, '../..');
const appRequire = createRequire(join(pkgRoot, 'package.json'));
const ndcRoot = dirname(appRequire.resolve('node-datachannel/package.json'));
const ndcRequire = createRequire(join(ndcRoot, 'package.json'));

function currentPlatformPackage(): string {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return '@node-datachannel/darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return '@node-datachannel/darwin-x64';
  if (platform === 'linux' && arch === 'x64') return '@node-datachannel/linux-x64-gnu';
  if (platform === 'linux' && arch === 'arm64') return '@node-datachannel/linux-arm64-gnu';
  throw new Error(`unsupported poc platform ${platform}/${arch}`);
}

function resolveNativeAddon(pkgName: string): string {
  const resolved = ndcRequire.resolve(pkgName);
  if (resolved.endsWith('.node')) return resolved;
  return join(dirname(resolved), 'node_datachannel.node');
}

const nativeAddon = resolveNativeAddon(currentPlatformPackage());

function rewriteLoader(source: string): string {
  const rewritten = `import * as path from 'path';
import cjsModule from 'node:module';
const require = cjsModule.createRequire(import.meta.url);
function loadBinding() {
  const nativeDir = process.env.TMEX_NATIVE_DIR;
  if (!nativeDir) {
    throw new Error('TMEX_NATIVE_DIR is not set');
  }
  const nativePath = path.join(nativeDir, 'node_datachannel.node');
  return require(nativePath);
}
const nodeDataChannel = loadBinding();
export { nodeDataChannel as default };
`;
  if (!source.includes('function loadBinding()')) {
    throw new Error('unexpected node-datachannel.mjs shape: loadBinding() missing');
  }
  return rewritten;
}

const workDir = mkdtempSync(join(tmpdir(), 'ndc-poc-'));
const patchedDir = join(workDir, 'patched');
const outDir = join(workDir, 'bundle');
mkdirSync(patchedDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const esmLib = join(ndcRoot, 'dist/esm/lib');
for (const file of [
  'index.mjs',
  'datachannel-stream.mjs',
  'websocket.mjs',
  'websocket-server.mjs',
]) {
  writeFileSync(join(patchedDir, file), readFileSync(join(esmLib, file)));
}
writeFileSync(
  join(patchedDir, 'node-datachannel.mjs'),
  rewriteLoader(readFileSync(join(esmLib, 'node-datachannel.mjs'), 'utf8'))
);

const entry = join(patchedDir, 'poc-entry.mjs');
writeFileSync(
  entry,
  `import nodeDataChannel from './index.mjs';

function parseFingerprint(sdp) {
  const match = sdp.match(/(?:^|\\r?\\n)a=fingerprint:([^\\s]+)\\s+([0-9a-f:]+)\\s*$/im);
  if (!match) throw new Error('Missing DTLS fingerprint');
  return { algorithm: match[1].toLowerCase(), value: match[2].replaceAll(':', '').toUpperCase() };
}

const cfg = { iceServers: ['stun:stun.l.google.com:19302'] };
const p1 = new nodeDataChannel.PeerConnection('poc-a', cfg);
const p2 = new nodeDataChannel.PeerConnection('poc-b', cfg);

p1.onLocalDescription((sdp, type) => p2.setRemoteDescription(sdp, type));
p1.onLocalCandidate((c, mid) => { if (c) p2.addRemoteCandidate(c, mid); });
p2.onLocalDescription((sdp, type) => p1.setRemoteDescription(sdp, type));
p2.onLocalCandidate((c, mid) => { if (c) p1.addRemoteCandidate(c, mid); });

const deadline = Date.now() + 15000;
const payload = Buffer.from('tmex-ndc-poc');

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('loopback timeout')), 15000);
  p2.onDataChannel((dc) => {
    dc.setBufferedAmountLowThreshold(1024);
    dc.onBufferedAmountLow(() => {});
    dc.onMessage((msg) => {
      try {
        const bytes = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        if (bytes.toString() !== 'tmex-ndc-poc') {
          throw new Error('payload mismatch');
        }
        const remote = p2.remoteFingerprint();
        const localDesc = p1.localDescription();
        if (!localDesc) throw new Error('missing localDescription');
        const localFp = parseFingerprint(localDesc.sdp);
        const result = {
          ok: true,
          remoteFingerprint: remote,
          localFingerprint: localFp,
          bufferedAmount: dc.bufferedAmount(),
          maxMessageSize: dc.maxMessageSize(),
          peerMaxMessageSize: p1.maxMessageSize(),
          libraryVersion: nodeDataChannel.getLibraryVersion(),
          elapsedMs: Date.now() - (deadline - 15000),
        };
        dc.close();
        p1.close();
        p2.close();
        clearTimeout(timer);
        console.log(JSON.stringify(result, null, 2));
        resolve(null);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
  const dc1 = p1.createDataChannel('tmex-poc');
  dc1.onOpen(() => {
    const accepted = dc1.sendMessageBinary(payload);
    if (!accepted) {
      clearTimeout(timer);
      reject(new Error('sendMessageBinary returned false'));
    }
  });
  dc1.onError((err) => {
    clearTimeout(timer);
    reject(new Error(String(err)));
  });
});

nodeDataChannel.cleanup();
process.exit(0);
`
);

const build = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  target: 'bun',
  format: 'esm',
  naming: 'poc.js',
});

if (!build.success) {
  console.error(build.logs);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const bundlePath = join(outDir, 'poc.js');
const bundleText = readFileSync(bundlePath, 'utf8');
if (bundleText.includes('@node-datachannel/')) {
  console.error('FAIL: bundle still contains platform package require');
  process.exit(1);
}
if (!bundleText.includes('TMEX_NATIVE_DIR')) {
  console.error('FAIL: bundle does not reference TMEX_NATIVE_DIR');
  process.exit(1);
}

const nativeDir = dirname(nativeAddon);
const proc = Bun.spawn(['bun', bundlePath], {
  cwd: pkgRoot,
  env: {
    ...process.env,
    TMEX_NATIVE_DIR: nativeDir,
  },
  stdout: 'pipe',
  stderr: 'pipe',
});
const exitCode = await proc.exited;
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();

console.log('--- PoC build ---');
console.log(`ndcRoot=${ndcRoot}`);
console.log(`nativeAddon=${nativeAddon}`);
console.log(`bundleBytes=${readFileSync(bundlePath).byteLength}`);
console.log(`bundleHasDetectLibc=${bundleText.includes('detect-libc')}`);
console.log(`bundleHasPlatformRequire=${bundleText.includes('@node-datachannel/')}`);
console.log('--- PoC run ---');
console.log(stdout);
if (stderr.trim()) console.error(stderr);

rmSync(workDir, { recursive: true, force: true });

if (exitCode !== 0) {
  console.error(`PoC exited ${exitCode}`);
  process.exit(exitCode ?? 1);
}

const parsed = JSON.parse(stdout);
if (!parsed.ok) {
  process.exit(1);
}
console.log('POC_OK');
