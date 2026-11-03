// Reverse proxy that adds `Authorization: Bearer <token>` to every request.
// The conformance CLI cannot send custom headers, and Hive requires a Bearer
// credential on every /mcp request. All other headers pass through verbatim
// (the dns-rebinding scenario depends on Host/Origin reaching the server).
//
// Usage: node auth-proxy.mjs <listen-port> <upstream-port> <token-file>
import http from 'node:http';
import { readFileSync } from 'node:fs';

const [listenPort, upstreamPort, tokenFile] = process.argv.slice(2);
if (!listenPort || !upstreamPort || !tokenFile) {
  console.error('usage: auth-proxy.mjs <listen-port> <upstream-port> <token-file>');
  process.exit(2);
}
const token = readFileSync(tokenFile, 'utf8').trim();

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, authorization: `Bearer ${token}` };
  const upstream = http.request(
    { host: '127.0.0.1', port: Number(upstreamPort), method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.listen(Number(listenPort), '127.0.0.1');
