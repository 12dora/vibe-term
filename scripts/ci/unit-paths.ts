export function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isPathUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

export function stripTestSuffix(p: string): string {
  return p.replace(/\.test(\.tsx?)$/, '$1');
}
