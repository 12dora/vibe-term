export function posixNormalize(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined;
}

export function posixJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function posixBasename(p: string): string {
  const i = p.lastIndexOf('/');
  const base = i >= 0 ? p.slice(i + 1) : p;
  return base || p;
}
