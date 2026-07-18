'use strict';
/**
 * LAWBOR desktop — main.cjs  (the floating messaging terminal)
 * =============================================================
 * A frameless, transparent, always-on-top pod that lives on the desktop. Collapsed it is a small
 * floating object — an "organic folder" you keep around; click it and you are back inside the
 * messaging app that your MCP bot runs. Same binary, two states.
 *
 * The window config is Toshi's, which is battle-tested on this exact machine. The two non-obvious
 * choices there, kept deliberately:
 *   - alwaysOnTop but NOT the 'screen-saver' level. On Windows the screen-saver level makes the
 *     window refuse keyboard focus — you could see the composer but not type into it.
 *   - transparent:true needs a GPU guard. On flaky Windows drivers a transparent frameless window
 *     can take the GPU process down and leave a blank ghost. We disable the problem accelerations
 *     and reload once if the renderer dies, so the companion recovers instead of looking crashed.
 *
 * Safety posture is inherited from the node and NOT relaxed here: the panel only calls the node's
 * HTTP surface. It never holds a key and never signs — /say returns a descriptor for a human.
 */
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { resolveConfig, resolveSize } = require('./lib/config.cjs');
const { collapsed, expanded, firstPosition, fitOnScreen } = require('./lib/win.cjs');

const ROOT = path.join(__dirname, '..');
const CFG = resolveConfig(process.env);
const MINI = 108;
let node = null;

// --- GPU guard (see header) -------------------------------------------------------------------
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-compositing');

/** Start our own bot node unless the user pointed us at one they already run. */
function startNode() {
  if (!CFG.spawn) return;
  try {
    node = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(CFG.port) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    node.on('error', (e) => console.error('[lawbor] node failed:', e.message));
  } catch (e) { console.error('[lawbor] could not start the node:', e.message); }
}

function createWindow() {
  const [W, H] = resolveSize(process.env);
  const wa = screen.getPrimaryDisplay().workArea;
  const start = firstPosition(W, H, wa);

  const win = new BrowserWindow({
    ...start,
    frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true,            // floats over the terminal — but stays focusable so you can TYPE
    focusable: true, skipTaskbar: true, hasShadow: false, fullscreenable: false,
    show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      // sandbox:false is REQUIRED because our preload requires local modules (lib/config, lib/view).
      // Electron sandboxes preloads by default since v20, and a sandboxed preload can only require
      // 'electron' + a couple of builtins — ours threw, window.lawbor never got defined, and the
      // panel sat on "loading…". contextIsolation stays ON: that is the boundary that matters, and
      // the renderer still has no require() and no fs.
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,   // a collapsed pod must keep polling, or unread counts freeze
    },
  });

  const workArea = () => screen.getDisplayMatching(win.getBounds()).workArea;

  ipcMain.on('lawbor:win', (_e, act) => {
    try {
      const b = win.getBounds();
      if (act === 'collapse') win.setBounds(collapsed(b, MINI, workArea()));
      else if (act === 'expand') { win.setBounds(expanded(b, W, H, workArea())); win.focus(); }
      else if (act === 'hide') win.hide();
      else if (act === 'show') { win.show(); win.focus(); }
      else if (act === 'quit') app.quit();
    } catch {}
  });
  // keep the pod on-screen if the display layout changes under it (undock, resolution change)
  screen.on('display-metrics-changed', () => { try { win.setBounds(fitOnScreen(win.getBounds(), workArea())); } catch {} });

  // Descriptors and basescan links open in the real browser — never inside the pod, which has no
  // navigation UI and no way back.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    // LAWBOR_COLLAPSED=1 → boot straight to the desktop object. The intended everyday shape: the
    // pod lives collapsed near the corner, the badge shows what is waiting, one click opens it.
    if (process.env.LAWBOR_COLLAPSED === '1') win.setBounds(collapsed(win.getBounds(), MINI, workArea()));
    win.show(); win.focus();
  });
  // Surface renderer errors on stderr. A frameless pod has no devtools button, so without this a
  // broken panel is indistinguishable from a slow one — which is exactly how the preload failure
  // above stayed invisible until the window was photographed.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error('[lawbor:panel] ' + message + ' (' + source + ':' + line + ')');
  });
  win.webContents.on('preload-error', (_e, p, err) => console.error('[lawbor] preload failed:', p, err && err.message));
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[lawbor] renderer gone:', d && d.reason, '— reloading the panel');
    if (!win.isDestroyed()) { try { win.reload(); } catch {} }
  });
  // LAWBOR_SHOT=/path/out.png → self-portrait mode: let the panel load its REAL data, capture the
  // actual window, write the PNG, quit. Screenshots of this pod are therefore always the honest
  // render — there is no path here that produces a mockup.
  if (process.env.LAWBOR_SHOT) {
    win.once('ready-to-show', () => setTimeout(async () => {
      try {
        const img = await win.capturePage();
        require('fs').writeFileSync(process.env.LAWBOR_SHOT, img.toPNG());
        console.log('[lawbor] wrote ' + process.env.LAWBOR_SHOT);
      } catch (e) { console.error('[lawbor] shot failed:', e.message); }
      app.quit();
    }, Number(process.env.LAWBOR_SHOT_DELAY) || 2500));
  }
  return win;
}

app.whenReady().then(() => { startNode(); createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { try { node && node.kill(); } catch {} });
