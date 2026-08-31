export function yamlQuote(value: string): string {
  if (/[:#\n]|^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export function writeNamedConfigYml(opts: {
  tunnelId: string;
  credentialsPath: string;
  certPath: string;
  hostname: string;
  originUrl: string;
}): string {
  return [
    `tunnel: ${opts.tunnelId}`,
    `credentials-file: ${yamlQuote(opts.credentialsPath)}`,
    `origincert: ${yamlQuote(opts.certPath)}`,
    'ingress:',
    `  - hostname: ${opts.hostname}`,
    `    service: ${opts.originUrl}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}
