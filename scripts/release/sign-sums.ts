// 发行包签名：给 SHA256SUMS 产出分离签名 `SHA256SUMS.sig`。
//
// 用法：
//   VIBETERM_RELEASE_SIGNING_KEY=<base64 32 字节种子> bun scripts/release/sign-sums.ts packages/app/SHA256SUMS
//
// 说明：
//   - 私钥只来自环境变量（CI 里是 secret），脚本不打印、不落盘任何私钥材料。
//   - 种子对应的公钥必须已经在 packages/shared/src/release/release-signing.ts 的
//     RELEASE_SIGNING_KEYS 里，否则签名会被所有节点判为 unknown_key，这里直接拒绝。
//   - 写盘前自验一遍，签坏了在流水线里就断掉，不会发出一个验不过的 release。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RELEASE_SIG_FILE_NAME,
  signReleaseSums,
  verifyReleaseSums,
} from '../../packages/shared/src/release/release-signing';

const SECRET_ENV = 'VIBETERM_RELEASE_SIGNING_KEY';

function die(message: string): never {
  console.error(`[sign-sums] ${message}`);
  process.exit(1);
}

const sumsPath = resolve(process.argv[2] ?? 'packages/app/SHA256SUMS');
const seed = (process.env[SECRET_ENV] ?? '').trim();
if (!seed) {
  die(`${SECRET_ENV} is not set; refusing to publish an unsigned release.`);
}

let sums: Buffer;
try {
  sums = readFileSync(sumsPath);
} catch (error) {
  die(`cannot read ${sumsPath}: ${error instanceof Error ? error.message : String(error)}`);
}
if (sums.byteLength === 0) die(`${sumsPath} is empty`);

let sigLine: string;
try {
  sigLine = signReleaseSums(seed, new Uint8Array(sums));
} catch (error) {
  die(`signing failed: ${error instanceof Error ? error.message : String(error)}`);
}

const verified = verifyReleaseSums(new Uint8Array(sums), sigLine);
if (!verified.ok) die(`self-verification failed (${verified.reason})`);

const sigPath = sumsPath.replace(/SHA256SUMS$/, RELEASE_SIG_FILE_NAME);
if (sigPath === sumsPath) die(`${sumsPath} does not end with SHA256SUMS`);
writeFileSync(sigPath, `${sigLine}\n`, { mode: 0o644 });
console.log(`[sign-sums] signed ${sumsPath} with key ${verified.keyId} -> ${sigPath}`);
