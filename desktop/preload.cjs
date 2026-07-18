'use strict';
/**
 * LAWBOR desktop — preload.cjs  (the ONLY bridge between the panel and the machine)
 * =================================================================================
 * contextIsolation is on and nodeIntegration is off, so the renderer has no require() and no fs.
 * It gets exactly three things and nothing more:
 *   win(act)   — collapse / expand / hide / quit
 *   api(...)   — fetch against OUR node's base url only (the renderer never picks a host)
 *   view       — the pure row/bubble mappers from lib/view.cjs, so the panel and the tests agree
 *
 * Pinning the base url here (not in the renderer) is the security point: even if a message body
 * ever managed to inject script into the panel, it still cannot aim a request at another host.
 */
const { contextBridge, ipcRenderer } = require('electron');
const { resolveConfig } = require('./lib/config.cjs');
const view = require('./lib/view.cjs');

const CFG = resolveConfig(process.env);

async function api(pathname, init) {
  const r = await fetch(CFG.base + pathname, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init && init.headers) },
  });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error((body && body.error) || 'HTTP ' + r.status);
  return body;
}

contextBridge.exposeInMainWorld('lawbor', {
  win: (act) => ipcRenderer.send('lawbor:win', act),
  base: CFG.base,
  startView: CFG.startView,
  health: () => api('/health'),
  inbox: () => api('/inbox'),
  requests: () => api('/requests'),
  botActivity: () => api('/bot-activity'),
  jobs: () => api('/jobs'),
  block: (addr) => api('/block', { method: 'POST', body: JSON.stringify({ addr }) }),
  unblock: (addr) => api('/unblock', { method: 'POST', body: JSON.stringify({ addr }) }),
  accept: (addr) => api('/accept', { method: 'POST', body: JSON.stringify({ addr }) }),
  thread: (id) => api('/thread?id=' + encodeURIComponent(id)),
  say: (to, body, thread) => api('/say', { method: 'POST', body: JSON.stringify({ to, body, thread }) }),
  view,
});
