import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
/**
 * Regenerate packages/app/src/vendor/node-datachannel from the pinned
 * node-datachannel version (devDependency). The native loader is rewritten so
 * Bun can inline the JS layer and require `<TMEX_NATIVE_DIR>/node_datachannel.node`.
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

const require = createRequire(import.meta.url);

let binding: any | null = null;

export function loadBindingFromPath(nativePath: string): any {
  if (binding) {
    return binding;
  }
  if (!existsSync(nativePath)) {
    throw new Error(\`node-datachannel native addon not found: \${nativePath}\`);
  }
  binding = require(nativePath);
  return binding;
}

export function loadBinding(): any {
  if (binding) {
    return binding;
  }
  const nativeDir = process.env.TMEX_NATIVE_DIR;
  if (!nativeDir) {
    throw new Error('TMEX_NATIVE_DIR is not set');
  }
  return loadBindingFromPath(join(nativeDir, 'node_datachannel.node'));
}

const nodeDataChannel = new Proxy(
  {},
  {
    get(_target, prop) {
      return Reflect.get(loadBinding(), prop);
    },
  }
);

export default nodeDataChannel;
`;

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
  \`loadBindingFromPath\`).
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
