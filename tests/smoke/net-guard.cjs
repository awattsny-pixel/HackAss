'use strict';
// Preloaded (NODE_OPTIONS=--require) into every process the smoke harness starts. Refuses any outbound
// connection or DNS lookup whose destination is not loopback, and records each attempt to the file named by
// SMOKE_NETGUARD_LOG so the harness can fail the run. It is a guard for the test environment, not a sandbox.
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');

const LOG = process.env.SMOKE_NETGUARD_LOG;
const isLoopback = (h) => {
  if (typeof h !== 'string') return false;
  const host = h.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(host);
};
const record = (kind, target) => {
  try { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ kind, target: String(target), pid: process.pid }) + '\n'); } catch {}
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let host = 'localhost';
  const a0 = args[0];
  if (a0 && typeof a0 === 'object' && !Array.isArray(a0)) {
    if (a0.path) return origConnect.apply(this, args); // unix domain socket / IPC
    host = a0.host || 'localhost';
  } else if (typeof a0 === 'string' && Number.isNaN(Number(a0))) {
    return origConnect.apply(this, args); // path form
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (!isLoopback(host)) {
    record('connect', host);
    const err = new Error(`smoke net-guard: blocked connection to ${host}`);
    err.code = 'ESMOKEGUARD';
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};

const origLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (hostname && !isLoopback(hostname) && !net.isIP(hostname)) {
    record('dns', hostname);
    const cb = rest[rest.length - 1];
    const err = Object.assign(new Error(`smoke net-guard: blocked DNS lookup for ${hostname}`), { code: 'ESMOKEGUARD' });
    if (typeof cb === 'function') return process.nextTick(() => cb(err));
  }
  return origLookup.call(this, hostname, ...rest);
};
const origPLookup = dns.promises.lookup;
dns.promises.lookup = function guardedPromisesLookup(hostname, ...rest) {
  if (hostname && !isLoopback(hostname) && !net.isIP(hostname)) {
    record('dns', hostname);
    return Promise.reject(Object.assign(new Error(`smoke net-guard: blocked DNS lookup for ${hostname}`), { code: 'ESMOKEGUARD' }));
  }
  return origPLookup.call(this, hostname, ...rest);
};
