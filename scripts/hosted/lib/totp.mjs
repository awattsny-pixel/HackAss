import { createHmac } from 'node:crypto';
/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret. */
export function totp(secretBase32, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) { const i = alphabet.indexOf(c); if (i < 0) throw new Error('invalid base32 secret'); bits += i.toString(2).padStart(5, '0'); }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
