// The plumbing under an MCP server, with no opinion about what it serves.
//
// This was the bottom half of mcp-server.js. It moved out here when the site
// measure got a bridge of its own: two servers, one copy of the transport, so
// there is one place where the security decisions live and one place to read
// them. Neither server knows anything about the other.
//
// No dependencies. The app has none beyond the copy of jsPDF sitting next to
// it, and one HTTP endpoint speaking JSON-RPC is not worth breaking that for.
//
// It listens on the loopback interface only, checks the Origin header so a web
// page cannot reach it through the browser, and puts a token in the path so
// another program on this machine cannot drive your drawing just by guessing
// the port. The token is kept in the app's own data directory, so the address
// stays the same between launches and you configure it once.
//
// What that does NOT protect against, and it is worth being plain about it:
// anything already running as you can read the token file.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- the token --
// Stable across launches so the address you give Claude Code keeps working.
function loadToken(dir, file) {
  const at = path.join(dir, file || 'mcp-token');
  try {
    const existing = fs.readFileSync(at, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch (_) {}
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(at, token, { mode: 0o600 });
  } catch (_) {}
  return token;
}

// ------------------------------------------------------------------ the page --
// Every tool in both servers reaches its window the same way the menu does: a
// snippet evaluated in the page, returning JSON.
//
// A snippet returns { ok, value } or { ok:false, error }, so a mistake inside
// the page comes back as a tool error the model can read and correct, rather
// than a rejected promise with no detail in it.
function pageEval(win, expression, windowName) {
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('The ' + (windowName || 'app') + ' window is not open.'));
  }
  // Async throughout, even for the snippets that answer straight away. Anything
  // touching the site measure has to wait on the drawing in the iframe, which
  // answers by message rather than by returning — and a promise handed to
  // JSON.stringify becomes "{}" rather than an error, so this is the kind of
  // thing that half works and reports success.
  const wrapped = `(async function(){
      try { const value = await (async function(){${expression}})();
            return JSON.stringify({ ok:true, value: value === undefined ? null : value }); }
      catch(e){ return JSON.stringify({ ok:false, error:String(e && e.message || e) }); } })()`;
  return win.webContents.executeJavaScript(wrapped, true).then(raw => {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { throw new Error('The page returned something that was not JSON.'); }
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
}

// ------------------------------------------------------------------ JSON-RPC --
function reply(id, result)      { return { jsonrpc: '2.0', id, result }; }
function fail(id, code, message){ return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg, tools, state, about) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    state.initialized = true;
    return reply(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: about.name, title: about.title, version: state.version },
      instructions: about.instructions
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
function startServer({ tools, name, title, instructions, tokenFile, defaultPort,
                       userDataDir, version, port, onListening, onError, onPortTaken }) {
  const token = loadToken(userDataDir, tokenFile);
  const about = { name, title, instructions };
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
          const r = await handleRpc(one, tools, st, about);
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

  // A taken port used to mean the bridge simply did not start, and nothing said
  // so — the tools it serves just were not there, and Claude quietly got on
  // with whatever was left. The ports these want are ordinary numbers that
  // another app on the same machine can perfectly reasonably be using, so a
  // clash takes any free one instead. The address is discovered rather than
  // typed, so which port it lands on does not matter to anything.
  let fellBack = false;
  server.on('error', err => {
    if (err && err.code === 'EADDRINUSE' && !fellBack && (port == null)) {
      fellBack = true;
      if (onPortTaken) onPortTaken(defaultPort);
      try { server.listen(0, '127.0.0.1'); return; } catch (_) {}
    }
    if (onError) onError(err);
  });
  // `== null`, not `||` — port 0 means "any free port the machine will give me",
  // and treating that as unset sends it back to the fixed port instead.
  server.listen(port == null ? defaultPort : port, '127.0.0.1', () => {
    const { port: actual } = server.address();
    if (onListening) onListening({ url: 'http://127.0.0.1:' + actual + routePath, port: actual, token,
                                   movedFrom: fellBack ? defaultPort : null });
  });

  return {
    server,
    stop: () => new Promise(resolve => server.close(resolve)),
    urlFor: p => 'http://127.0.0.1:' + p + routePath
  };
}

module.exports = { startServer, pageEval, PROTOCOL_VERSION, SUPPORTED_PROTOCOLS };
