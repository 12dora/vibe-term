import dgram from 'node:dgram';
const host = process.argv[2] ?? '';
const port = Number(process.argv[3] ?? 3478);
if (!host) throw new Error('usage: udp-probe.ts <host> [port]');
const socket = dgram.createSocket('udp4');
const request = Buffer.alloc(20);
request.writeUInt16BE(0x0001, 0);
request.writeUInt32BE(0x2112a442, 4);
crypto.getRandomValues(request.subarray(8));
const timer = setTimeout(() => {
  process.stdout.write('timeout\n');
  socket.close();
  process.exit(1);
}, 4000);
socket.on('message', (_message, remote) => {
  clearTimeout(timer);
  process.stdout.write(`reply from ${remote.address}\n`);
  socket.close();
});
socket.send(request, port, host);
