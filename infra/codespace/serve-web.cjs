// Раздача собранной веб-части (админка или веб-версия заказчика) с прокси /api и /socket.io на API.
// Только для демо-стенда в Codespaces. Запуск: node serve-web.cjs <папка dist> <порт> [порт API]
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const [, , dir, port, apiPort = '3000'] = process.argv;
const root = path.resolve(dir);
const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const toApi = (url) => url.startsWith('/api/') || url.startsWith('/socket.io/');

const server = http.createServer((req, res) => {
  if (toApi(req.url)) {
    const p = http.request({ host: '127.0.0.1', port: Number(apiPort), path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('error', () => p.destroy());
    return req.pipe(p);
  }
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(apiPort), '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
process.on('uncaughtException', (e) => console.error('serve-web:', e.code ?? e.message));
server.listen(Number(port), () => console.log(`serve-web: ${root} на :${port} (API :${apiPort})`));
