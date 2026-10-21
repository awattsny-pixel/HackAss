// Minimal Chrome DevTools driver (headless Chrome + node WebSocket). Local only.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function launch(port = 9333) {
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', detached: true });
  const killGroup = () => { try { process.kill(-proc.pid); } catch { /* already gone */ } };
  proc.kill = killGroup; // Chrome starts helper processes: end the whole group so none outlives the run
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {} await sleep(200); }
  return { proc, port };
}
export async function newPage(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const events = []; const history = []; // `events` is cleared at every navigation; `history` keeps console/log/exception events for the whole page lifetime
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.rej(new Error(d.error.message)); else p.res(d.result); } else if (d.method) { if (/^(Log\.|Runtime\.(exceptionThrown|consoleAPICalled))/.test(d.method)) history.push(d); events.push(d); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const api = {
    send, events, history,
    async viewport(w, h, mobile = false) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }); },
    async goto(url) { events.length = 0; await send('Page.navigate', { url }); for (let i = 0; i < 100; i++) { await sleep(100); if (events.some((e) => e.method === 'Page.loadEventFired')) break; } await sleep(400); },
    async ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error'); return r.result.value; },
    async shot(file, full = true) {
      let clip;
      if (full) { const m = await send('Page.getLayoutMetrics'); const w = m.cssContentSize.width, h = Math.min(m.cssContentSize.height, 6000); clip = { x: 0, y: 0, width: w, height: h, scale: 1 }; }
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    /** click the first element matching selector whose text includes `text` */
    async click(sel, text = '') { return api.ev(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!e) return false; e.click(); return true; })()`); },
    async type(sel, value) { return api.ev(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.focus(); const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value'); d.set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`); },
    async key(key, code = key) { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Escape: 27, Tab: 9, Enter: 13 }[key] || 0, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) }); },
    /** Types into the focused element like a keyboard would (real input events). */
    async insertText(text) { await send('Input.insertText', { text }); },
    close() { ws.close(); },
  };
  return api;
}
