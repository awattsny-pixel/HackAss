'use strict';
// Preloaded (NODE_OPTIONS=--require) into every process the smoke harness starts. Refuses any outbound
// connection or DNS lookup whose destination is not loopback, and records each attempt to the file named by
// SMOKE_NETGUARD_LOG so the harness can fail the run. It is a guard for the test environment, not a sandbox.
//
// Node calls Socket#connect in several shapes: connect(options[, cb]), connect(port[, host][, cb]),
// connect(path), and -- from net.connect()/net.createConnection()/tls.connect() -- a single *normalized array*
// [options, cb]. The destination is extracted from whichever shape is used and validated before the call is
// forwarded. Anything that cannot be shown to be loopback is refused (fail closed).
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');

const LOG = process.env.SMOKE_NETGUARD_LOG;
const record = (kind, target) => {
  try { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ kind, target: String(target), pid: process.pid }) + '\n'); } catch {}
};

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** True only for the name `localhost` or an IP literal in 127.0.0.0/8, ::1, or an IPv4-mapped form of those. */
function isLoopbackHost(h) {
  if (typeof h !== 'string' || h === '') return false;
  let host = h.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  if (host === 'localhost') return true;
  const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) host = dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    host = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const family = net.isIP(host);
  if (family === 4) return loopback.check(host, 'ipv4');
  if (family === 6) return loopback.check(host, 'ipv6');
  return false; // any other name (including numeric shorthands like 127.1 or 2130706433) is not trusted
}

/** Work out where a Socket#connect call is headed. Returns { path: true } for local sockets, else { host, lookup }. */
function destination(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // Node's normalized form: [options, cb]
  if (first && typeof first === 'object') {
    if (first.path || first.fd !== undefined) return { path: true };
    return { host: first.host || 'localhost', lookup: typeof first.lookup === 'function' };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: true }; // connect('/tmp/sock')
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', lookup: false };      // connect(port[, host])
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const dest = destination(args);
  if (!dest.path) {
    const ipLiteral = net.isIP(String(dest.host).replace(/^\[|\]$/g, '')) !== 0;
    // A custom `lookup` could resolve even the name `localhost` to an external address; only IP literals ignore it.
    const blocked = !isLoopbackHost(dest.host) || (dest.lookup && !ipLiteral);
    if (blocked) {
      record(dest.lookup ? 'connect-custom-lookup' : 'connect', dest.host);
      const err = new Error(`smoke net-guard: blocked connection to ${dest.host}`);
      err.code = 'ESMOKEGUARD';
      process.nextTick(() => this.destroy(err));
      return this;
    }
  }
  return origConnect.apply(this, args);
};

const blockedName = (hostname) => hostname && !isLoopbackHost(hostname) && !net.isIP(hostname);

const origLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (blockedName(hostname)) {
    record('dns', hostname);
    const cb = rest[rest.length - 1];
    const err = Object.assign(new Error(`smoke net-guard: blocked DNS lookup for ${hostname}`), { code: 'ESMOKEGUARD' });
    if (typeof cb === 'function') return process.nextTick(() => cb(err));
  }
  return origLookup.call(this, hostname, ...rest);
};
const origPLookup = dns.promises.lookup;
dns.promises.lookup = function guardedPromisesLookup(hostname, ...rest) {
  if (blockedName(hostname)) {
    record('dns', hostname);
    return Promise.reject(Object.assign(new Error(`smoke net-guard: blocked DNS lookup for ${hostname}`), { code: 'ESMOKEGUARD' }));
  }
  return origPLookup.call(this, hostname, ...rest);
};
