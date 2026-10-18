// Test hook: attempts an outbound request to a non-loopback destination (the .invalid TLD never resolves),
// then serves minimal responses so the run proceeds. The network guard must block and record the attempt.
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
try { await fetch('http://smoke-egress-attempt.invalid/', { signal: AbortSignal.timeout(2000) }); console.log('EGRESS:unexpected-success'); }
catch (e) { console.log('EGRESS:blocked:' + (e?.cause?.code || e?.code || e?.name)); }
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"hacks":[]}'); }).listen(port, '127.0.0.1');
