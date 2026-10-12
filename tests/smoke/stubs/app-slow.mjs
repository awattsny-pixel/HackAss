// Test hook: becomes ready (answers /api/hacks) but never answers any other request.
import http from 'node:http';
import { spawn } from 'node:child_process';
const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(`GRANDCHILD:${gc.pid}`);
http.createServer((req, res) => {
  if (req.url === '/api/hacks') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"hacks":[]}'); }
  // intentionally never responds
}).listen(port, '127.0.0.1');
