'use strict';
// Test probe for net-guard.cjs. Run only by tests/net-guard.test.ts, in a child process (the guard patches the
// process-wide net module, so it must never be loaded into the test runner itself).
//
// A RECORDING DOUBLE replaces the real Socket#connect before the guard is loaded. The guard therefore wraps the
// double: a destination the guard allows is "forwarded" to the recorder (which opens nothing), and a destination
// it refuses never reaches the recorder. No case here ever contacts a real network address.
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const forwarded = [];
net.Socket.prototype.connect = function recorder(...args) { forwarded.push(args); return this; };
// `noguard` is the control run: it proves each case really reaches Socket#connect when nothing is protecting it.
if (process.argv[2] !== 'noguard') require('./net-guard.cjs');

const results = [];
const tick = () => new Promise((r) => setTimeout(r, 30));

async function attempt(name, fn) {
  const before = forwarded.length;
  let errorCode = null;
  try {
    const sock = fn();
    if (sock && typeof sock.once === 'function') sock.once('error', (e) => { errorCode = e.code; });
    else if (sock && typeof sock.then === 'function') sock.catch((e) => { errorCode = e?.cause?.code || e?.code || 'rejected'; }); // never awaited: with no guard the double never answers
  } catch (e) { errorCode = e?.code || 'threw'; }
  await tick();
  results.push({ name, forwarded: forwarded.length > before, errorCode });
}

const sock = () => new net.Socket();
const cases = {
  // --- permitted: loopback in every call shape (must reach the recorder)
  'allow:obj-127.0.0.1': () => net.connect({ host: '127.0.0.1', port: 9 }),
  'allow:obj-127.255.255.254': () => net.connect({ host: '127.255.255.254', port: 9 }),
  'allow:port-host-::1': () => net.connect(9, '::1'),
  'allow:bracketed-[::1]': () => net.connect({ host: '[::1]', port: 9 }),
  'allow:long-form-::1': () => net.connect({ host: '0:0:0:0:0:0:0:1', port: 9 }),
  'allow:mapped-dotted': () => net.connect({ host: '::ffff:127.0.0.1', port: 9 }),
  'allow:mapped-hex': () => net.connect({ host: '::ffff:7f00:1', port: 9 }),
  'allow:localhost': () => net.connect({ host: 'localhost', port: 9 }),
  'allow:no-host': () => net.connect({ port: 9 }),
  'allow:port-only': () => net.connect(9),
  'allow:unix-path-object': () => net.connect({ path: '/tmp/hackass-guard-probe.sock' }),
  'allow:unix-path-string': () => net.connect('/tmp/hackass-guard-probe.sock'),
  'allow:normalized-array-loopback': () => sock().connect([{ host: '127.0.0.1', port: 9 }, null]),
  'allow:custom-lookup-with-ip-literal': () => net.connect({ host: '127.0.0.1', port: 9, lookup: () => {} }),
  // --- refused: external numeric IPv4 (the reported bypass goes through the normalized array)
  'deny:ipv4-object': () => net.connect({ host: '198.51.100.1', port: 9 }),
  'deny:ipv4-port-host': () => net.connect(9, '198.51.100.1'),
  'deny:ipv4-normalized-array': () => sock().connect([{ host: '198.51.100.1', port: 9 }, null]),
  'deny:ipv4-normalized-array-callback': () => sock().connect([{ port: 9, host: '8.8.8.8' }, () => {}]),
  'deny:ipv4-object-direct': () => sock().connect({ host: '198.51.100.1', port: 9 }),
  'deny:ipv4-private-10': () => net.connect({ host: '10.0.0.1', port: 9 }),
  'deny:ipv4-private-192.168': () => net.connect({ host: '192.168.1.1', port: 9 }),
  'deny:ipv4-link-local-metadata': () => net.connect({ host: '169.254.169.254', port: 80 }),
  'deny:ipv4-unspecified': () => net.connect({ host: '0.0.0.0', port: 9 }),
  // --- refused: IPv6
  'deny:ipv6-object': () => net.connect({ host: '2001:db8::1', port: 9 }),
  'deny:ipv6-port-host': () => net.connect(9, '2001:db8::1'),
  'deny:ipv6-normalized-array': () => sock().connect([{ host: '2001:db8::1', port: 9 }, null]),
  'deny:ipv6-mapped-external': () => net.connect({ host: '::ffff:198.51.100.1', port: 9 }),
  'deny:ipv6-mapped-external-hex': () => net.connect({ host: '::ffff:c633:6401', port: 9 }), // 198.51.100.1 in hex-mapped form
  'deny:ipv6-link-local': () => net.connect({ host: 'fe80::1', port: 9 }),
  // --- refused: hostnames, including look-alikes and numeric shorthand
  'deny:hostname': () => net.connect({ host: 'example.invalid', port: 9 }),
  'deny:hostname-normalized-array': () => sock().connect([{ host: 'example.invalid', port: 9 }, null]),
  'deny:hostname-loopback-lookalike-suffix': () => net.connect({ host: '127.0.0.1.evil.invalid', port: 9 }),
  'deny:hostname-localhost-lookalike': () => net.connect({ host: 'localhost.evil.invalid', port: 9 }),
  'deny:numeric-shorthand-127.1': () => net.connect({ host: '127.1', port: 9 }),
  'deny:numeric-decimal-2130706433': () => net.connect({ host: '2130706433', port: 9 }),
  'deny:localhost-with-custom-lookup': () => net.connect({ host: 'localhost', port: 9, lookup: () => {} }),
  // --- refused: higher-level clients that end in Socket#connect
  'deny:tls-connect-ip': () => tls.connect({ host: '198.51.100.1', port: 443 }),
  'deny:http-request-ip': () => { const r = http.get({ host: '198.51.100.1', port: 80, agent: new http.Agent({ keepAlive: false }) }); r.on('error', () => {}); return r; },
  // port 8081, not 9: undici refuses "bad ports" (such as 9) before connecting, which would make these cases vacuous
  'deny:fetch-ipv4': () => fetch('http://198.51.100.1:8081/'),
  'deny:fetch-ipv6': () => fetch('http://[2001:db8::1]:8081/'),
};

(async () => {
  for (const [name, fn] of Object.entries(cases)) await attempt(name, fn);
  const fs = require('node:fs');
  const log = process.env.SMOKE_NETGUARD_LOG ? fs.readFileSync(process.env.SMOKE_NETGUARD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log('PROBE:' + JSON.stringify({ results, log }));
  process.exit(0);
})();
