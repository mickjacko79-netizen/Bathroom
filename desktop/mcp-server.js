// An MCP server that hands the running drawing to Claude Code.
//
// The desktop shell already talks to the page through executeJavaScript — the
// menu drives it that way. This puts the same bridge behind an MCP endpoint, so
// Claude Code on this machine can read the job and change it while you watch,
// instead of you describing the drawing to it and copying the answer back.
//
// No dependencies. The app has none beyond the copy of jsPDF sitting next to it,
// and one HTTP endpoint speaking JSON-RPC is not worth breaking that for.
//
// It listens on the loopback interface only, checks the Origin header so a web
// page cannot reach it through the browser, and puts a token in the path so
// another program on this machine cannot drive your drawing just by guessing the
// port. The token is kept in the app's own data directory, so the address stays
// the same between launches and you configure it once.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PORT = Number(process.env.BATHROOM_MCP_PORT) || 8791;

// ---------------------------------------------------------------- the token --
// Stable across launches so the address you give Claude Code keeps working.
function loadToken(dir) {
  const file = path.join(dir, 'mcp-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch (_) {}
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch (_) {}
  return token;
}

// ------------------------------------------------------------------ the page --
// Everything below reaches the drawing the same way the menu does: a snippet
// evaluated in the page, returning JSON. The page's functions are top-level in a
// classic inline script, so they are simply in scope.
//
// A snippet returns { ok, value } or { ok:false, error }, so a mistake inside the
// page comes back as a tool error the model can read and correct, rather than a
// rejected promise with no detail in it.
function pageEval(win, expression) {
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('The Bathroom window is not open.'));
  }
  const wrapped = `(function(){ try { return JSON.stringify({ ok:true, value:(function(){${expression}})() }); }
                                catch(e){ return JSON.stringify({ ok:false, error:String(e && e.message || e) }); } })()`;
  return win.webContents.executeJavaScript(wrapped, true).then(raw => {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { throw new Error('The page returned something that was not JSON.'); }
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
}

// Shared preamble: the handful of lookups every tool needs, written once.
const PRELUDE = `
  const wallOf = id => { const w = state.walls.find(x => x.id === id);
    if(!w) throw new Error('There is no wall ' + id + '. Walls are ' + state.walls.map(x=>x.id).join(', ') + '.');
    return w; };
  const rowKey = r => (r === 'wall' || r === 'wallRow') ? 'wallRow' : 'baseRow';
  const rowInfo = (w, r) => ({ arr: w[rowKey(r)],
    startOff: runStartOffset(w, rowKey(r) === 'wallRow' ? 'wall' : 'base'),
    endOff: wallLength(w.id), isWallRow: rowKey(r) === 'wallRow' });
  const findCab = id => {
    const hit = (typeof allRows === 'function' ? allRows() : []).map(r => ({ r, c: r.arr.find(x => x.id === id) }))
                 .find(x => x.c);
    if(!hit) throw new Error('There is no fitting with id ' + id + '. Call describe_job for the current ids.');
    return hit;
  };
  const setOutOf = (row, cab) => Math.round(rowPositions(row.arr, row.startOff)[row.arr.indexOf(cab)]);
  const touched = () => { try { renderCabinetList(); } catch(_){}
                          try { renderEditPanel(); } catch(_){}
                          try { renderActive(); } catch(_){}
                          try { scheduleAutosave(); } catch(_){} };
`;

// ------------------------------------------------------------------- tools ----
// Kept deliberately small. Each one is a thing you would ask for out loud, and
// each mutating one takes its own undo step, so anything Claude does here you can
// take back with Ctrl+Z exactly as if you had done it by hand.
function buildTools(win) {
  const call = expr => pageEval(win, PRELUDE + expr);

  return [
    {
      name: 'describe_job',
      description:
        'Read the drawing as it stands: room size, and every wall with the fittings on it — ' +
        'their id, type, width, set-out along the wall, and the band of height they occupy. ' +
        'Call this before changing anything, and again afterwards to confirm what happened. ' +
        'Ids from this are what the other tools take.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => call(`
        const rows = ['baseRow','wallRow'];
        return {
          room: { width: state.room.W, length: state.room.L, height: state.room.H },
          benchHeight: state.bench && state.bench.height,
          walls: state.walls.map(w => {
            const out = { wall: w.id, lengthAlongWall: wallLength(w.id) };
            if(w.lowWall && w.lowWall.on) out.lowWall =
              { height: w.lowWall.height, thickness: w.lowWall.thickness,
                from: Math.round(w.lowWall.from||0), to: w.lowWall.to == null ? 'to the corner' : Math.round(w.lowWall.to) };
            rows.forEach(rk => {
              const info = rowInfo(w, rk), pos = rowPositions(info.arr, info.startOff);
              out[rk === 'wallRow' ? 'wallFittings' : 'floorFittings'] = info.arr.map((c,i) => {
                const lo = rk === 'wallRow' ? wallCabBottomY(c) : 0;
                return { id: c.id, type: c.type, width: c.W,
                         setOut: Math.round(pos[i]), heightBand: [lo, lo + (c.H||0)],
                         label: (c.config && c.config.labelText) || undefined };
              });
            });
            return out;
          }),
          selected: state.ui.selectedCabId || null,
          sheetOnScreen: state.ui.view
        };
      `)
    },

    {
      name: 'list_fitting_types',
      description:
        'The fittings this app can draw, with the row each one belongs on and its default size. ' +
        'Use it to pick a valid type before calling add_fitting — a type that is not on this list ' +
        'will be refused.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => call(`
        return Object.keys(CATALOG).map(k => ({
          type: k, label: CATALOG[k].label,
          row: CATALOG[k].row === 'wall' ? 'wall (hung at a height)' : 'floor (stands on the floor)',
          defaultWidth: CATALOG[k].defaultW, height: CATALOG[k].H, depth: CATALOG[k].D
        }));
      `)
    },

    {
      name: 'add_fitting',
      description:
        'Put a new fitting on a wall. `setOut` is millimetres from the start of that wall to the ' +
        "fitting's near edge; leave it out to place it after whatever is already there. Returns the " +
        'new fitting and where it actually landed, which can differ from what you asked for when ' +
        'something is already standing in that spot.',
      inputSchema: {
        type: 'object',
        properties: {
          wall:   { type: 'string', description: 'Wall id, e.g. "A" or "D". See describe_job.' },
          type:   { type: 'string', description: 'A type from list_fitting_types.' },
          setOut: { type: 'number', description: 'Millimetres from the start of the wall to its near edge.' },
          width:  { type: 'number', description: "Width in millimetres. Defaults to the type's own." }
        },
        required: ['wall', 'type'],
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        if(!CATALOG[a.type]) throw new Error('There is no fitting type "' + a.type + '". Call list_fitting_types.');
        const w = wallOf(a.wall);
        pushHistory();
        const cab = makeCab(a.type, a.width ? { W: a.width } : {});
        const row = rowInfo(w, CATALOG[a.type].row);
        row.arr.push(cab);
        if(a.setOut != null)
          moveCabToU(cab, row.arr, row.startOff, row.endOff, a.setOut, false, null, row.isWallRow);
        touched();
        const after = rowInfo(w, CATALOG[a.type].row);
        return { id: cab.id, type: cab.type, wall: w.id, width: cab.W,
                 askedFor: a.setOut == null ? 'after what was there' : a.setOut,
                 setOut: setOutOf(after, cab) };
      `)
    },

    {
      name: 'move_fitting',
      description:
        'Slide a fitting along its wall to a set-out. Moving one moves that one: everything else ' +
        'stays where it is, and a fitting that clears another in height simply passes it. Returns ' +
        'where it landed — which differs from what you asked for only when there was no room.',
      inputSchema: {
        type: 'object',
        properties: {
          id:     { type: 'string', description: 'Fitting id from describe_job.' },
          setOut: { type: 'number', description: 'Millimetres from the start of the wall to its near edge.' }
        },
        required: ['id', 'setOut'],
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        const hit = findCab(a.id);
        pushHistory();
        moveCabToU(hit.c, hit.r.arr, hit.r.startOff, hit.r.endOff, a.setOut, false, null, hit.r.isWallRow);
        touched();
        const now = rowOfCab(hit.c);
        return { id: hit.c.id, type: hit.c.type, askedFor: a.setOut, setOut: setOutOf(now, hit.c) };
      `)
    },

    {
      name: 'update_fitting',
      description:
        'Change a fitting itself rather than where it stands — its width, its height off the floor, ' +
        'or the label that appears on the drawing. Only the fields you pass are touched.',
      inputSchema: {
        type: 'object',
        properties: {
          id:       { type: 'string', description: 'Fitting id from describe_job.' },
          width:    { type: 'number', description: 'Width along the wall, in millimetres.' },
          bottomY:  { type: 'number', description: 'Height of its underside off the floor. Wall fittings only.' },
          label:    { type: 'string', description: 'Label drawn against it.' }
        },
        required: ['id'],
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        const hit = findCab(a.id);
        pushHistory();
        if(a.width != null)   hit.c.W = a.width;
        if(a.bottomY != null){ hit.c.config = hit.c.config || {}; hit.c.config.cabBottomY = a.bottomY; }
        if(a.label != null){   hit.c.config = hit.c.config || {}; hit.c.config.labelText = a.label; }
        touched();
        const now = rowOfCab(hit.c);
        const lo = now.isWallRow ? wallCabBottomY(hit.c) : 0;
        return { id: hit.c.id, type: hit.c.type, width: hit.c.W,
                 setOut: setOutOf(now, hit.c), heightBand: [lo, lo + (hit.c.H||0)] };
      `)
    },

    {
      name: 'remove_fitting',
      description: 'Take a fitting off the wall. One undo step, so it can be taken back.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Fitting id from describe_job.' } },
        required: ['id'],
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        const hit = findCab(a.id);
        const gone = { id: hit.c.id, type: hit.c.type };
        pushHistory();
        hit.r.arr.splice(hit.r.arr.indexOf(hit.c), 1);
        if(state.ui.selectedCabId === gone.id) state.ui.selectedCabId = null;
        touched();
        return { removed: gone };
      `)
    },

    {
      name: 'set_room',
      description:
        'Change the size of the room. Width and length are the plan dimensions; height is floor to ' +
        'ceiling. Only the fields you pass are touched.',
      inputSchema: {
        type: 'object',
        properties: {
          width:  { type: 'number', description: 'Room width in millimetres.' },
          length: { type: 'number', description: 'Room length in millimetres.' },
          height: { type: 'number', description: 'Floor to ceiling, in millimetres.' }
        },
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        pushHistory();
        if(a.width  != null) state.room.W = a.width;
        if(a.length != null) state.room.L = a.length;
        if(a.height != null) state.room.H = a.height;
        touched();
        return { room: { width: state.room.W, length: state.room.L, height: state.room.H } };
      `)
    },

    {
      name: 'show_sheet',
      description:
        'Put a sheet on screen so the person can see what you changed. Call it with no argument to ' +
        'get the list of sheets in the set.',
      inputSchema: {
        type: 'object',
        properties: { view: { type: 'string', description: 'A sheet view id, e.g. "plan" or "elev-D".' } },
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        const sheets = activeSheets().map(s => ({ view: s.view, title: s.title }));
        if(!a.view) return { sheets: sheets, onScreen: state.ui.view };
        if(!sheets.some(s => s.view === a.view))
          throw new Error('There is no sheet "' + a.view + '". They are: ' + sheets.map(s=>s.view).join(', ') + '.');
        showView(a.view); renderActive();
        return { onScreen: a.view };
      `)
    }
  ];
}

// ------------------------------------------------------------------ JSON-RPC --
function reply(id, result)      { return { jsonrpc: '2.0', id, result }; }
function fail(id, code, message){ return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg, tools, state) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    state.initialized = true;
    return reply(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'bathroom', title: 'Bathroom — the drawing on screen', version: state.version },
      instructions:
        'These tools read and change the bathroom drawing open on this machine, live. Call ' +
        'describe_job first — it carries the room, the walls, and the id of every fitting, and the ' +
        'other tools take those ids. Set-outs are millimetres from the start of a wall to a ' +
        "fitting's near edge. Every change is one undo step in the app."
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return reply(id, {});

  if (method === 'tools/list') {
    return reply(id, {
      tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    });
  }

  if (method === 'tools/call') {
    const tool = tools.find(t => t.name === (params && params.name));
    if (!tool) return fail(id, -32602, 'There is no tool called "' + (params && params.name) + '".');
    try {
      const value = await tool.run((params && params.arguments) || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
    } catch (err) {
      // A tool that fails reports back as a result, not a protocol error, so the
      // model reads what went wrong and has another go instead of the call
      // vanishing into the transport.
      return reply(id, { content: [{ type: 'text', text: String(err && err.message || err) }], isError: true });
    }
  }

  if (id === undefined) return null;                 // any other notification
  return fail(id, -32601, 'This server does not implement ' + method + '.');
}

// --------------------------------------------------------------------- HTTP --
// Loopback only, Origin checked, token in the path. A browser page cannot reach
// it (no CORS headers are ever sent, and a cross-site Origin is refused), and
// another program on this machine needs the token.
function startServer({ window, userDataDir, version, port, onListening, onError }) {
  const token = loadToken(userDataDir);
  const tools = buildTools(window);
  const sessions = new Map();
  const routePath = '/mcp/' + token;

  const originIsLocal = origin => {
    if (!origin) return true;                        // non-browser clients send none
    try {
      const u = new URL(origin);
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    } catch (_) { return false; }
  };

  const server = http.createServer((req, res) => {
    const send = (code, body, headers) => {
      const payload = body == null ? '' : JSON.stringify(body);
      res.writeHead(code, Object.assign(
        { 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' },
        payload ? { 'content-type': 'application/json' } : {},
        headers || {}));
      res.end(payload);
    };

    if (!originIsLocal(req.headers.origin)) return send(403, { error: 'Cross-site origin refused.' });

    const url = (req.url || '').split('?')[0];
    if (url !== routePath) return send(404, { error: 'Not found.' });

    // We never push to the client, so there is nothing to open a stream for.
    if (req.method === 'GET' || req.method === 'DELETE') return send(405, { error: 'Use POST.' });
    if (req.method !== 'POST') return send(405, { error: 'Use POST.' });

    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { req.destroy(); }      // nothing legitimate is this big
    });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); }
      catch (_) { return send(400, fail(null, -32700, 'That was not JSON.')); }

      let sid = req.headers['mcp-session-id'];
      const isInit = !Array.isArray(msg) && msg && msg.method === 'initialize';
      if (isInit && !sid) { sid = crypto.randomBytes(16).toString('hex'); sessions.set(sid, { version }); }
      const st = sessions.get(sid) || { version };

      try {
        const batch = Array.isArray(msg) ? msg : [msg];
        const out = [];
        for (const one of batch) {
          const r = await handleRpc(one, tools, st);
          if (r) out.push(r);
        }
        const headers = isInit && sid ? { 'mcp-session-id': sid } : undefined;
        // Nothing to say back — a batch of pure notifications.
        if (!out.length) return send(202, null, headers);
        return send(200, Array.isArray(msg) ? out : out[0], headers);
      } catch (err) {
        return send(500, fail(null, -32603, String(err && err.message || err)));
      }
    });
  });

  server.on('error', err => { if (onError) onError(err); });
  // `== null`, not `||` — port 0 means "any free port the machine will give me",
  // and treating that as unset sends it back to the fixed port instead.
  server.listen(port == null ? DEFAULT_PORT : port, '127.0.0.1', () => {
    const { port: actual } = server.address();
    if (onListening) onListening({ url: 'http://127.0.0.1:' + actual + routePath, port: actual, token });
  });

  return {
    server,
    stop: () => new Promise(resolve => server.close(resolve)),
    urlFor: p => 'http://127.0.0.1:' + p + routePath
  };
}

module.exports = { startServer, DEFAULT_PORT };
