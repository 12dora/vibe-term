import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;

function encodeOctal(value: number, length: number): Buffer {
  const encoded = value.toString(8).padStart(length - 1, '0');
  const buf = Buffer.alloc(length, 0);
  buf.write(encoded, 0, length - 1, 'ascii');
  return buf;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, Math.min(name.length, 99), 'utf8');
  encodeOctal(0o644, 8).copy(header, 100);
  encodeOctal(0, 8).copy(header, 108);
  encodeOctal(0, 8).copy(header, 116);
  encodeOctal(size, 12).copy(header, 124);
  encodeOctal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar', 257, 5, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += header[i];
  }
  const checksum = Buffer.concat([encodeOctal(sum, 7), Buffer.from(' ')]);
  checksum.copy(header, 148, 0, 8);
  return header;
}

function padBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

function asBytes(value: Uint8Array | Buffer | string): Buffer {
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.from(value);
}

export function packNpmTarball(files: Record<string, Uint8Array | Buffer | string>): Uint8Array {
  const chunks: Buffer[] = [];
  const names = Object.keys(files).sort();
  for (const name of names) {
    const content = asBytes(files[name]);
    chunks.push(tarHeader(name, content.length));
    chunks.push(content);
    const pad = padBlock(content.length);
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks));
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const raw = buf
    .toString('ascii', start, start + length)
    .replace(/\0.*$/, '')
    .trim();
  if (!raw) return 0;
  return Number.parseInt(raw, 8);
}

function readCString(buf: Buffer, start: number, length: number): string {
  const end = buf.indexOf(0, start);
  const stop = end >= start && end < start + length ? end : start + length;
  return buf.toString('utf8', start, stop);
}

export function extractTarGzipFile(tarball: Uint8Array, pathInTar: string): Uint8Array | null {
  const tar = gunzipSync(tarball);
  const wanted = pathInTar.replace(/^\.\//, '');
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0);
    offset += BLOCK;
    const content = tar.subarray(offset, offset + size);
    offset += size + padBlock(size);
    if ((typeflag === '0' || typeflag === '\0') && fullName === wanted) {
      return Uint8Array.from(content);
    }
  }
  return null;
}

export function integrityOf(data: Uint8Array): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}
