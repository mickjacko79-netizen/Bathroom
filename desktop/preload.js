// The only thing the page is given.
//
// The window runs with context isolation on and Node off, which is how it should
// stay: bathroom.html is a drawing app that also has to run in a plain browser,
// and handing it require() would be both unnecessary and a way in. So the page
// gets four functions and no more — ask a question, watch the answer arrive,
// stop it, and find out whether any of this is available at all.
//
// `window.bathroomChat` being undefined is the signal the page uses to hide the
// chat panel when it is opened in a browser rather than the desktop app.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bathroomChat', {
  // Whether the desktop shell is on the other side of this at all.
  available: true,

  // Is the CLI installed, and is it logged in? The panel asks before it lets
  // someone type, so the answer is a sentence about what to do rather than a
  // request that fails a few seconds later for a reason nobody can see.
  status: () => ipcRenderer.invoke('chat:status'),

  // Ask a question. Resolves once the turn is finished; the running commentary
  // arrives through onEvent below.
  ask: (text) => ipcRenderer.invoke('chat:ask', String(text == null ? '' : text)),

  // Stop the turn that is running.
  stop: () => ipcRenderer.invoke('chat:stop'),

  // Signing in. The browser does the signing in; these only start the flow and
  // carry back the one-time code it shows at the end.
  loginStart:  () => ipcRenderer.invoke('chat:loginStart'),
  loginCode:   (code) => ipcRenderer.invoke('chat:loginCode', String(code == null ? '' : code)),
  loginCancel: () => ipcRenderer.invoke('chat:loginCancel'),

  // Speaking instead of typing. Windows does the recognising, on this machine.
  dictateStart: (lang, engine) => ipcRenderer.invoke('chat:dictateStart', lang || null, engine || null),

  // Opens the Windows page where the speech privacy policy is accepted.
  openSpeechSettings: () => ipcRenderer.invoke('chat:openSpeechSettings'),
});

// The openings library, authored in the Window, Door & Wall Composite Builder
// and published to a file both apps can reach. Read only: the schedule belongs
// to that app and nothing here should be able to write it.
contextBridge.exposeInMainWorld('bathroomOpenings', {
  available: true,
  read:   () => ipcRenderer.invoke('openings:read'),
  where:  () => ipcRenderer.invoke('openings:where'),
  reveal: () => ipcRenderer.invoke('openings:reveal'),
  // Fires when the other app publishes, so a drawing follows the schedule
  // without anybody having to remember to press anything.
  onChange: (fn) => {
    const h = (_e, payload) => { try { fn(payload); } catch (_) {} };
    ipcRenderer.on('openings:changed', h);
    return () => ipcRenderer.removeListener('openings:changed', h);
  },
  dictateStop:  () => ipcRenderer.invoke('chat:dictateStop'),

  // Hand a floor plan over for Claude to read.
  attachPlan: () => ipcRenderer.invoke('chat:attachPlan'),

  // Start a fresh conversation rather than continuing the last one.
  reset: () => ipcRenderer.invoke('chat:reset'),

  // Text as it is written, tools as they are called, and the end of the turn.
  // Returns the function that unsubscribes, so a re-render cannot stack
  // listeners up and print everything twice.
  onEvent: (handler) => {
    const wrapped = (_evt, payload) => { try { handler(payload); } catch (_) {} };
    ipcRenderer.on('chat:event', wrapped);
    return () => ipcRenderer.removeListener('chat:event', wrapped);
  },
});
