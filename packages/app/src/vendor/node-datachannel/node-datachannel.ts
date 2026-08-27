import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

let binding: any | null = null;

export function loadBindingFromPath(nativePath: string): any {
  if (binding) {
    return binding;
  }
  if (!existsSync(nativePath)) {
    throw new Error(`node-datachannel native addon not found: ${nativePath}`);
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
