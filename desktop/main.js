'use strict';
// Bathroom — desktop shell.
//
// The drawing app itself stays a single self-contained HTML file at the root of
// this repo, so it can still be opened in a plain browser with nothing
// installed. This process only provides the window, the native menu and the
// save/print plumbing around it.

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'com.joinerystudio.bathroom';
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

// Where bathroom.html lives in a checkout: the root of the repo this shell sits
// in. Two ways to get there, because __dirname points inside app.asar once the
// app is packaged and `..` from there is not the repo:
//
//   run from source   <repo>/desktop/main.js              -> ../
//   run from the exe  <repo>/desktop/dist/win-unpacked/   -> ../../../
//
// The portable exe unpacks itself to %TEMP%, so neither resolves and it falls
// through to the bundled copy — which is what a portable copy should use.
const CHECKOUT_CANDIDATES = [
  path.resolve(__dirname, '..', 'bathroom.html'),
  path.resolve(path.dirname(app.getPath('exe')), '..', '..', '..', 'bathroom.html'),
];
function checkoutHtml() {
  return CHECKOUT_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}
// A copy packaged inside the exe, so the app is genuinely standalone on a
// machine that has never cloned the repo.
const BUNDLED_HTML = path.join(__dirname, 'bundled', 'bathroom.html');

let mainWindow = null;

// ---------------------------------------------------------------- config ---
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { console.warn('[Bathroom] could not write', file, e.message); }
}

// Resolution order, most specific first. An external file wins over the bundled
// copy so edits to the live bathroom.html are picked up without rebuilding; the
// bundled copy is the safety net on any other machine.
function htmlPath() {
  const cfg = readJson(CONFIG_FILE, {});
  if (cfg.htmlPath && fs.existsSync(cfg.htmlPath)) return cfg.htmlPath;
  if (!cfg.forceBundled) {
    const live = checkoutHtml();
    if (live) return live;
  }
  if (fs.existsSync(BUNDLED_HTML)) return BUNDLED_HTML;
  return null;
}
function isBundled() { return htmlPath() === BUNDLED_HTML; }

async function promptForHtml() {
  const res = await dialog.showOpenDialog({
    title: 'Locate bathroom.html',
    message: 'Select the bathroom.html drawing app file.',
    properties: ['openFile'],
    filters: [{ name: 'Bathroom app', extensions: ['html'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const cfg = readJson(CONFIG_FILE, {});
  cfg.htmlPath = res.filePaths[0];
  writeJson(CONFIG_FILE, cfg);
  return cfg.htmlPath;
}

// ------------------------------------------------------------ page bridge ---
// The page's own top-level functions (showView, undo, makePDF, …) are reachable
// from executeJavaScript because they are declared in a classic inline script.
function run(code) {
  if (!mainWindow) return Promise.resolve();
  return mainWindow.webContents
    .executeJavaScript(`(function(){ try { ${code} } catch(e){ console.error(e); } })()`, true)
    .catch(err => console.warn('[Bathroom] bridge:', err.message));
}
const clickId = id => run(`var b=document.getElementById(${JSON.stringify(id)}); if(b) b.click();`);

// ------------------------------------------------------------------ menu ---
// Fallback only. The real list comes from the page — a job traced from a site
// measure has one elevation per wall, which runs well past D, and rooms add more
// again, so a hard-coded list would quietly hide half the drawing set.
const SHEETS = [
  ['Cover',                        'cover'],
  ['Floor plan — fixtures',        'plan'],
  ['Floor plan — with wall units', 'plan-base'],
  ['Fixture schedule',             'schedule'],
  ['Sanitaryware schedule',        'appliances'],
];
let sheetItems = SHEETS;

// Ask the page for the sheets it is actually showing.
async function readSheets() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const raw = await mainWindow.webContents.executeJavaScript(
      `(function(){ try { return JSON.stringify(printableSheets().map(function(s){
         return [ (s.no ? s.no + ' · ' : '') + s.title, s.view ]; })); }
       catch(e){ return null; } })()`, true);
    const list = raw ? JSON.parse(raw) : null;
    return (Array.isArray(list) && list.length) ? list : null;
  } catch (_) { return null; }
}
async function refreshSheetMenu() {
  const live = await readSheets();
  if (!live) return;
  const same = JSON.stringify(live) === JSON.stringify(sheetItems);
  if (same) return;
  sheetItems = live;
  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Save job', accelerator: 'CmdOrCtrl+S', click: () => clickId('btnSave') },
        { label: 'Library…',  accelerator: 'CmdOrCtrl+L', click: () => clickId('btnLibrary') },
        { type: 'separator' },
        { label: 'Export drawing set (PDF)…', accelerator: 'CmdOrCtrl+E', click: () => clickId('dlPdf') },
        { label: 'Export job as JSON…',       click: () => clickId('btnExport') },
        { type: 'separator' },
        { label: 'Print current sheet…', accelerator: 'CmdOrCtrl+P', click: printSheet },
        { type: 'separator' },
        {
          label: 'Open drawings folder',
          click: () => {
            const p = htmlPath();
            // The bundled copy lives inside the asar archive — there is no real
            // folder to reveal, so say so rather than doing nothing.
            if (isBundled() || !p) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                message: 'Running the bundled drawing app',
                detail: 'This copy is packaged inside the application, so it has no folder on disk.\n\n'
                      + 'Use File → Change bathroom.html location… to point at an external copy you can edit.',
                buttons: ['OK'],
              });
              return;
            }
            shell.showItemInFolder(p);
          },
        },
        {
          label: 'Change bathroom.html location…',
          click: async () => { if (await promptForHtml()) loadApp(); },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      // registerAccelerator:false shows the shortcut in the menu but leaves the
      // key to the page. Registering these would swallow them app-wide — Delete
      // would stop working inside the sidebar's text fields, and Ctrl+Z would
      // undo the whole design instead of the text being typed.
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z',       registerAccelerator: false, click: () => run('undo();') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: () => run('redo();') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Delete selected fixture', accelerator: 'Delete', registerAccelerator: false, click: () => run('deleteSelectedCab();') },
      ],
    },
    {
      label: '&Sheets',
      submenu: [
        ...sheetItems.map(([label, view], i) => ({
          label,
          accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
          click: () => run(`showView(${JSON.stringify(view)});`),
        })),
        { type: 'separator' },
        { label: 'Previous sheet', accelerator: 'CmdOrCtrl+[', click: () => step(-1) },
        { label: 'Next sheet',     accelerator: 'CmdOrCtrl+]', click: () => step(1) },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom in',      accelerator: 'CmdOrCtrl+Plus',  click: () => clickId('vZoomIn') },
        { label: 'Zoom out',     accelerator: 'CmdOrCtrl+-',     click: () => clickId('vZoomOut') },
        { label: 'Fit to window', accelerator: 'CmdOrCtrl+0',    click: () => clickId('vZoomFit') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Reload app', accelerator: 'CmdOrCtrl+R', click: () => loadApp() },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard shortcuts', click: showShortcuts },
        { label: 'About Bathroom', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function step(dir) {
  // Walk the page's own sheet order, so extra elevations are not skipped.
  await run(`
    var order = printableSheets().map(function(s){ return s.view; });
    var i = order.indexOf(state.ui.view);
    if(i >= 0){
      var n = Math.max(0, Math.min(order.length - 1, i + (${dir})));
      if(n !== i) showView(order[n]);
    }
  `);
}

function printSheet() {
  if (!mainWindow) return;
  mainWindow.webContents.print({ landscape: true, printBackground: true }, (ok, reason) => {
    if (!ok && reason && reason !== 'cancelled') {
      dialog.showMessageBox(mainWindow, { type: 'warning', message: 'Could not print', detail: reason });
    }
  });
}

function showShortcuts() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Keyboard shortcuts',
    message: 'Bathroom — keyboard shortcuts',
    detail: [
      'Ctrl+S           Save job',
      'Ctrl+E           Export drawing set as PDF',
      'Ctrl+P           Print the current sheet',
      'Ctrl+L           Open the library',
      '',
      'Ctrl+Z           Undo',
      'Ctrl+Shift+Z     Redo',
      'Delete           Delete the selected fixture',
      'Esc              Deselect / close dialog',
      '',
      'Ctrl+1 … Ctrl+9  Jump to a sheet',
      'Ctrl+[  Ctrl+]   Previous / next sheet',
      '[  ]             Previous / next sheet (in the drawing)',
      '',
      'Ctrl+= / Ctrl+-  Zoom the sheet',
      'Ctrl+0           Fit the sheet to the window',
      'Scroll           Zoom at the cursor',
      'Shift+drag       Pan the sheet',
    ].join('\n'),
    buttons: ['Close'],
  });
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Bathroom',
    message: 'Bathroom',
    detail: [
      'Architectural drawing set for bathrooms, ensuites and wet areas.',
      '',
      `Drawings file:  ${htmlPath() || 'not found'}`,
      `Source:         ${isBundled() ? 'bundled inside the app' : 'external file (edits are picked up on reload)'}`,
      `App version:    ${app.getVersion()}`,
      `Electron:       ${process.versions.electron}`,
    ].join('\n'),
    buttons: ['Close'],
  });
}

// ---------------------------------------------------------------- window ---
function loadApp() {
  const p = htmlPath();
  if (!p) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'bathroom.html not found',
      message: 'Could not find the drawing app file.',
      detail: `Looked for:\n${CHECKOUT_CANDIDATES.join('\n')}\n\nUse File → Change bathroom.html location… to point at it.`,
      buttons: ['OK'],
    });
    return;
  }
  mainWindow.loadFile(p);
}

function createWindow() {
  const saved = readJson(STATE_FILE, {});
  mainWindow = new BrowserWindow({
    width: saved.width || 1600,
    height: saved.height || 1000,
    x: saved.x, y: saved.y,
    minWidth: 1100, minHeight: 720,
    show: false,
    backgroundColor: '#EEF1F4',
    title: 'Bathroom',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (saved.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  // The page sets its own <title>; don't let it blank the window title.
  mainWindow.on('page-title-updated', e => e.preventDefault());

  // The sheet list is the job's, not ours. Read it once the page is up, and
  // again on a slow tick — adding a room or re-tracing the plan changes it.
  mainWindow.webContents.on('did-finish-load', () => {
    refreshSheetMenu();
    setTimeout(refreshSheetMenu, 1500);
  });
  const sheetPoll = setInterval(refreshSheetMenu, 5000);
  mainWindow.on('closed', () => clearInterval(sheetPoll));

  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getNormalBounds();
    writeJson(STATE_FILE, { ...b, maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('close', persist);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Keep the shell pinned to the app; send anything external to the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });

  // PDF/JSON exports arrive as downloads — offer a proper Save As dialog.
  mainWindow.webContents.session.on('will-download', (e, item) => {
    const name = item.getFilename();
    const isPdf = /\.pdf$/i.test(name);
    item.setSaveDialogOptions({
      title: isPdf ? 'Save drawing set' : 'Save job file',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: isPdf
        ? [{ name: 'PDF drawing set', extensions: ['pdf'] }]
        : [{ name: 'Bathroom job', extensions: ['json'] }],
    });
    item.once('done', (_evt, state) => {
      if (state === 'completed' && isPdf) {
        const saved = item.getSavePath();
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          message: 'Drawing set exported',
          detail: saved,
          buttons: ['Open', 'Show in folder', 'Close'],
          defaultId: 0, cancelId: 2,
        }).then(({ response }) => {
          if (response === 0) shell.openPath(saved);
          else if (response === 1) shell.showItemInFolder(saved);
        });
      }
    });
  });

  loadApp();
}

// Correct taskbar identity + icon grouping on Windows.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
