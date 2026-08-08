// Runs Claude Code for the chat panel.
//
// The panel in the page asks a question; this spawns `claude` headless, hands it
// the drawing through the MCP bridge that is already running, and streams what
// comes back to the page a line at a time.
//
// Claude Code is spawned rather than the API being called directly because it
// already knows who you are. The alternative was an API key living in the app's
// local storage and a second bill for something you are already paying for.
//
// It is given exactly one thing to work with: the bathroom tools. No filesystem
// to speak of, no other MCP server from your global config, and a working
// directory of its own under the app's data folder — so a question about a towel
// rail cannot turn into an edit somewhere in your repo.

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Finding Claude Code, without ever going through a shell.
//
// What is on PATH is npm's shims — an extensionless shell script and a .cmd —
// and Node will not spawn either: since the 2024 argument-injection fix it
// refuses .cmd outright (EINVAL) unless you pass shell:true. Turning the shell
// on is the wrong answer here, because the thing being passed along is whatever
// the person typed into the panel, and that is not text to hand to cmd.exe.
//
// So the shims are only used to find the package, and what actually gets spawned
// is the real binary they point at.
//
// Two things this used to get wrong, both of which read as "Claude Code is not
// installed" on a machine where it plainly is:
//
//   • A failed lookup was cached for the life of the app. One bad probe — a
//     slow `where`, a cwd that had been cleaned up under it, anything — and the
//     panel insisted it was not installed until you restarted. Only a hit is
//     worth remembering, so only a hit is kept.
//   • It asked PATH and nothing else. A window opened from Explorer inherits
//     whatever PATH Explorer started with, which on Windows can be older than
//     the install. So the usual places are checked too, by looking.
let resolvedCli = null;

// Where an install actually puts it, in the order worth trying.
function knownCliPaths() {
  const home = os.homedir();
  const out = [];
  const push = (...parts) => { try { out.push(path.join(...parts.filter(Boolean))); } catch (_) {} };
  if (process.env.BATHROOM_CLAUDE_CLI) out.push(process.env.BATHROOM_CLAUDE_CLI);
  const pkgBin = ['node_modules', '@anthropic-ai', 'claude-code', 'bin'];
  if (process.platform === 'win32') {
    push(process.env.APPDATA, 'npm', ...pkgBin, 'claude.exe');
    push(process.env.LOCALAPPDATA, 'npm', ...pkgBin, 'claude.exe');
    push(process.env.ProgramFiles, 'nodejs', ...pkgBin, 'claude.exe');
    push(home, '.claude', 'local', 'claude.exe');
    push(home, 'AppData', 'Roaming', 'npm', ...pkgBin, 'claude.exe');
  } else {
    push('/usr/local/lib', ...pkgBin, 'claude');
    push('/opt/homebrew/lib', ...pkgBin, 'claude');
    push(home, '.npm-global/lib', ...pkgBin, 'claude');
    push(home, '.claude', 'local', 'claude');
    push('/usr/local/bin/claude');
    push('/opt/homebrew/bin/claude');
  }
  return out;
}

function realBinaryNear(shimPath) {
  // npm lays its shims beside node_modules, and the package's own bin is a
  // proper executable — spawnable directly, no shell, no quoting to get wrong.
  const dir = path.dirname(shimPath);
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  const roots = [
    path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'),
    path.join(dir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'),
  ];
  for (const root of roots) {
    for (const name of names) {
      const p = path.join(root, name);
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
  }
  return null;
}

function findCli() {
  // A hit is worth keeping — it cannot go stale within a run. A miss is not:
  // it may just have been a bad moment, and the cost of asking again is one
  // process that exits in milliseconds.
  if (resolvedCli && fs.existsSync(resolvedCli)) return Promise.resolve(resolvedCli);
  resolvedCli = null;

  const probe = process.platform === 'win32'
    ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/c', 'where', 'claude'] }
    : { cmd: '/bin/sh', args: ['-lc', 'command -v claude'] };
  return new Promise(resolve => {
    // An explicit cwd, because the one inherited from a portable exe can be a
    // temp folder that is no longer there, and spawning into a missing
    // directory fails in a way that looks exactly like a missing program.
    execFile(probe.cmd, probe.args, { windowsHide: true, cwd: os.tmpdir() }, (_err, stdout) => {
      const found = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      let pick = null;
      // A real executable on PATH is best — some installs put one there.
      pick = found.find(p => /\.exe$/i.test(p)) || null;
      // Otherwise follow a shim to the binary it wraps.
      if (!pick) { for (const s of found) { const real = realBinaryNear(s); if (real) { pick = real; break; } } }
      // On anything but Windows the shim is usually executable itself.
      if (!pick && process.platform !== 'win32') pick = found[0] || null;
      // PATH knew nothing. Look where it would be anyway.
      if (!pick) {
        for (const p of knownCliPaths()) {
          try { if (fs.existsSync(p)) { pick = p; break; } } catch (_) {}
        }
      }
      resolvedCli = pick || null;
      resolve(resolvedCli);
    });
  });
}

// A working directory of its own. Claude Code wants somewhere to stand; this
// gives it somewhere that is not your work.
function workDir(userDataDir) {
  const dir = path.join(userDataDir, 'chat-workspace');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// The bridges, described the way the CLI wants to read them. Written next to the
// workspace rather than passed inline, because the addresses carry tokens and a
// command line is the one place on this machine that is easy to read off.
//
// The site measure's bridge is listed only when it is actually up, so a copy of
// the app running without it does not hand Claude an address that answers
// nothing.
function writeMcpConfig(userDataDir, bridgeUrl, siteMeasureUrl) {
  const file = path.join(workDir(userDataDir), 'mcp.json');
  const mcpServers = {};
  if (bridgeUrl) mcpServers.bathroom = { type: 'http', url: bridgeUrl };
  if (siteMeasureUrl) mcpServers.sitemeasure = { type: 'http', url: siteMeasureUrl };
  fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  return file;
}

const SYSTEM_NOTE = [
  'You are answering inside the Bathroom drawing app, in a narrow side panel, for',
  'someone who is looking at the drawing while you talk.',
  '',
  'The bathroom tools act on the drawing open in front of them, live. Call',
  'describe_job before you change anything — it carries the room, the walls, and',
  'the id of every fitting, and the other tools take those ids. Set-outs are',
  'millimetres from the start of a wall to a fitting\'s near edge.',
  '',
  'Keep replies short. A sentence or two saying what you did or what you found,',
  'in plain words, is the whole job — they can see the drawing, so do not describe',
  'it back to them. No headings, no bullet lists, no tables unless they ask.',
  '',
  'The sitemeasure tools are a separate thing, and they are the ones to reach for',
  'when the work is the as-built plan rather than the joinery: walls and the wall',
  'types they are built in, doors and windows, rooms and their finishes. Call',
  'describe_site first. Everything there is millimetres on wall centrelines, x',
  'right and y down, 0 degrees east and 90 north on screen.',
  '',
  'Junctions there follow one rule and the tools apply it for you, but know it so',
  'you can say what you did: external walls mitre where they meet at an external',
  'corner; an internal wall butts, stopping on the face of whatever it meets while',
  'that wall runs on past it unbroken; where two internals meet, the longer runs',
  'through. A mitre is only ever an external corner.',
  '',
  'When a floor plan is handed to you as a file, read it and take the dimensions',
  'off it. If the site measure is what they want, draw it there with add_walls —',
  'give the room sizes as the inside face and let it work the centrelines out —',
  'then put the openings and room labels on it. If it is the joinery drawing they',
  'are after, reproduce the room with set_site_measure instead. Either way, say',
  'what you read off the plan and what you had to assume. Offer to bring it into',
  'the drawing rather than doing that unasked, because that replaces the room and',
  'its walls.',
  '',
  'Deliver what was asked at the scope intended. Make the routine judgment calls',
  'yourself and check in only when two readings would lead to genuinely different',
  'work. Every change you make is one undo step in the app, so a mistake costs',
  'them one Ctrl+Z — act rather than asking permission for reversible things.',
].join('\n');

function createChat({ userDataDir, bridgeUrl, siteMeasureUrl, send }) {
  const smUrl = siteMeasureUrl || (() => null);
  let child = null;
  let sessionId = null;
  // Set the moment a turn is asked for, not when the process finally exists.
  // Checking `child` alone let a second question through, because the first is
  // still waiting on the CLI lookup at that point and has nothing spawned yet.
  let busy = false;

  const emit = (type, payload) => { try { send(Object.assign({ type }, payload)); } catch (_) {} };

  // Whether Claude Code has an account behind it. It answers on stdout and exits
  // non-zero when signed out, so the exit code is no use — read what it said.
  function authStatus(cli) {
    return new Promise(resolve => {
      execFile(cli, ['auth', 'status', '--json'], { windowsHide: true }, (_err, stdout) => {
        try { resolve(JSON.parse(String(stdout || '{}'))); }
        catch (_) { resolve({ loggedIn: false }); }
      });
    });
  }

  async function status() {
    const cli = await findCli();
    if (!cli) {
      // Say where it looked. "Not installed" on a machine where it is installed
      // is not something anyone can act on.
      return { ready: false, reason: 'not-installed',
               message: 'Could not find Claude Code. If it is not installed, install it with '
                      + '"npm install -g @anthropic-ai/claude-code". If it is, it is somewhere this '
                      + 'looked past — PATH, and ' + knownCliPaths().slice(0, 3).join(', ')
                      + ' — so set BATHROOM_CLAUDE_CLI to the full path of claude.exe and reopen '
                      + 'this panel.' };
    }
    if (!bridgeUrl()) {
      return { ready: false, reason: 'no-bridge',
               message: 'The Claude bridge is not running, so Claude would not be able to see the '
                      + 'drawing. Start it from the Claude menu.' };
    }
    const auth = await authStatus(cli);
    if (!auth.loggedIn) {
      return { ready: false, reason: 'not-logged-in',
               message: 'Sign in to Claude to use this panel.' };
    }
    return { ready: true, cli, authMethod: auth.authMethod };
  }

  // ------------------------------------------------------------- signing in --
  // `claude auth login` opens the browser itself, prints the address as a
  // fallback, and then waits on stdin for the code the browser shows at the end.
  // All this does is carry that code the few inches from the panel to the
  // process — the signing in happens in the browser, as yours, and the code is
  // never written to a log or sent anywhere but that process on this machine.
  let loginProc = null;

  async function loginStart() {
    if (loginProc) return { started: true, already: true };
    const cli = await findCli();
    if (!cli) return { error: 'Claude Code is not installed on this machine.' };

    let proc;
    try {
      proc = spawn(cli, ['auth', 'login'], { cwd: workDir(userDataDir), windowsHide: true });
    } catch (err) {
      return { error: 'Could not start the sign-in: ' + err.message };
    }
    loginProc = proc;

    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      out += chunk;
      const url = (out.match(/https:\/\/\S*oauth\/authorize\S*/) || [])[0];
      // The authorize address is not a secret — it is the page you sign in on —
      // so it is worth handing over in case the browser did not open by itself.
      if (url && !proc.__sentUrl) { proc.__sentUrl = true; emit('auth-url', { url }); }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => {});

    proc.on('error', err => {
      loginProc = null;
      emit('auth-done', { ok: false, message: 'Sign-in failed to start: ' + err.message });
    });
    proc.on('close', async () => {
      loginProc = null;
      const cliNow = await findCli();
      const auth = cliNow ? await authStatus(cliNow) : { loggedIn: false };
      emit('auth-done', { ok: !!auth.loggedIn,
        message: auth.loggedIn ? 'Signed in.' : 'Not signed in — the sign-in did not complete.' });
    });

    return { started: true };
  }

  // The code the browser showed. Written straight through; nothing keeps it.
  function loginCode(code) {
    if (!loginProc) return { error: 'The sign-in is not running. Start it again.' };
    try { loginProc.stdin.write(String(code).trim() + '\n'); }
    catch (err) { return { error: 'Could not hand the code over: ' + err.message }; }
    return { sent: true };
  }

  function loginCancel() {
    if (!loginProc) return { cancelled: false };
    try { loginProc.kill(); } catch (_) {}
    loginProc = null;
    return { cancelled: true };
  }

  function stop() {
    if (!child) { busy = false; return { stopped: false }; }
    try { child.kill(); } catch (_) {}
    child = null;
    busy = false;
    emit('done', { stopped: true });
    return { stopped: true };
  }

  function reset() { sessionId = null; return { reset: true }; }

  async function ask(text) {
    if (busy) return { error: 'Still working on the last one.' };
    busy = true;
    const state = await status();
    if (!state.ready) { busy = false; emit('error', { message: state.message }); return state; }

    const cwd = workDir(userDataDir);
    const mcpConfig = writeMcpConfig(userDataDir, bridgeUrl(), smUrl());

    const args = [
      '-p', text,
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', mcpConfig,
      // Only the bridges. Not whatever else is configured globally on this machine.
      '--strict-mcp-config',
      // Headless cannot put a prompt on screen, so anything not allowed here would
      // hang rather than ask. The drawing tools, the site measure tools, and
      // reading a file — which is how a floor plan handed to the panel gets looked
      // at. Nothing else: no shell, no writes, and Read only reaches the working
      // directory below, which holds copies of what you attached and nothing of
      // yours.
      '--allowedTools', 'mcp__bathroom',
      '--allowedTools', 'mcp__sitemeasure',
      '--allowedTools', 'Read',
      '--append-system-prompt', SYSTEM_NOTE,
    ];
    // Carry the thread, so "now move it 200 left" means something.
    if (sessionId) args.push('--resume', sessionId);

    emit('start', {});

    return new Promise(resolve => {
      let proc;
      try {
        proc = spawn(state.cli, args, { cwd, windowsHide: true, env: process.env });
      } catch (err) {
        emit('error', { message: 'Could not start Claude Code: ' + err.message });
        return resolve({ error: err.message });
      }
      child = proc;

      let buffered = '';
      let sawText = false;
      let stderr = '';
      let lastText = '';       // so the same sentence is not printed twice

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        buffered += chunk;
        // stream-json is one JSON object per line. A chunk can split a line, so
        // the tail is kept until the newline that completes it arrives.
        let nl;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch (_) { continue; }
          if (handle(evt)) sawText = true;
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => { stderr += d; });

      proc.on('error', err => {
        child = null;
        emit('error', { message: 'Could not start Claude Code: ' + err.message });
        resolve({ error: err.message });
      });

      proc.on('close', code => {
        child = null;
        busy = false;
        if (code !== 0 && !sawText) {
          emit('error', { message: (stderr.trim() || 'Claude Code stopped with code ' + code + '.') });
        }
        emit('done', {});
        resolve({ ok: true, sessionId });
      });

      // Returns true when the event carried assistant text, so a non-zero exit
      // with something already on screen is not reported as a bare failure.
      function handle(evt) {
        if (evt.session_id) sessionId = evt.session_id;

        if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
          let had = false;
          evt.message.content.forEach(block => {
            if (block.type === 'text' && block.text) {
              lastText = block.text; emit('text', { text: block.text }); had = true;
            }
            // A tool call is worth showing — it is the app being changed, and
            // seeing which one ran is how you know what to undo.
            if (block.type === 'tool_use') {
              emit('tool', { name: String(block.name || '').replace(/^mcp__(?:bathroom|sitemeasure)__/, '') });
            }
          });
          return had;
        }

        if (evt.type === 'result') {
          // The CLI reports its own failures here — not logged in, usage limits —
          // as a result rather than a crash, so this is where they surface.
          if (evt.is_error) {
            const why = String(evt.result || 'Claude Code could not answer.');
            // The CLI often says it twice — once as the assistant's reply and
            // again in the result. Printing both reads like a stutter.
            if (why.trim() !== lastText.trim()) emit('error', { message: why });
            return false;
          }
          if (evt.result && !sawText) { emit('text', { text: String(evt.result) }); return true; }
        }
        return false;
      }
    });
  }

  // ------------------------------------------------------------- dictation --
  // Windows' own speech engine, driven by dictate.ps1. Chromium's recogniser is
  // present in Electron but non-functional in it — it fails with a network error
  // the instant it is started, because the build has no backend to call. This
  // one runs on the machine: no key, no account, no audio going anywhere.
  let dictateProc = null;

  function dictateStart(lang) {
    if (process.platform !== 'win32') {
      return { error: 'Dictation here uses the Windows speech engine, and this is not Windows.' };
    }
    if (dictateProc) return { started: true, already: true };
    // PowerShell is not Electron and knows nothing about asar archives — a path
    // inside app.asar simply does not exist as far as it is concerned, and the
    // spawn fails with something that reads like a broken microphone. Packaging
    // leaves this one file beside the archive; point at that copy.
    //
    // This is why dictation worked when run from a checkout and never once in a
    // built copy: from source, __dirname is a real folder.
    const script = path.join(__dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1'),
                             'dictate.ps1');
    if (!fs.existsSync(script)) {
      return { error: 'The dictation script is missing from this build. It should sit beside '
                    + 'app.asar in resources/app.asar.unpacked.' };
    }
    let proc;
    try {
      proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, env: Object.assign({}, process.env,
            // It listens until it is stopped, so it has to know who to outlive
            // and who to follow. Killing this process leaves the child holding
            // the microphone open otherwise.
            { BATHROOM_DICTATE_PARENT: String(process.pid) },
            lang ? { BATHROOM_DICTATE_LANG: String(lang) } : {}) });
    } catch (err) {
      return { error: 'Could not start dictation: ' + err.message };
    }
    dictateProc = proc;

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.error) { emit('dictate-error', { message: msg.error }); return; }
        if (msg.ready) { emit('dictate-ready', { culture: msg.culture, available: msg.available }); continue; }
        // Everything between starting and a finished sentence, so the panel can
        // show that it is listening rather than leaving it to be guessed at.
        if (msg.partial) { emit('dictate-partial', { text: msg.partial }); continue; }
        if (msg.level != null) { emit('dictate-level', { level: msg.level }); continue; }
        if (msg.audio) { emit('dictate-audio', { state: msg.audio }); continue; }
        if (msg.silent) { emit('dictate-silent', { message: msg.message }); continue; }
        // Heard, but not as words worth keeping.
        if (msg.noise) { emit('dictate-noise', { confidence: msg.confidence }); continue; }
        if (msg.text)  emit('dictate-text', { text: msg.text, confidence: msg.confidence });
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => {});
    proc.on('error', err => {
      dictateProc = null;
      emit('dictate-error', { message: 'Could not start dictation: ' + err.message });
    });
    proc.on('close', () => {
      dictateProc = null;
      if (!proc.__doneSaid) emit('dictate-done', {});
    });
    return { started: true };
  }

  // ----------------------------------------------------- attaching a plan --
  // A copy is taken into the working directory rather than the original being
  // pointed at. Claude is allowed to read that directory and nowhere else, so a
  // plan you hand over is reachable and the rest of your disk is not — and the
  // file you chose is never opened by anything but the copy.
  function attachPlan(sourcePath) {
    if (!sourcePath) return { error: 'No file chosen.' };
    let stat;
    try { stat = fs.statSync(sourcePath); }
    catch (_) { return { error: 'That file could not be read: ' + sourcePath }; }
    if (stat.size > 32 * 1024 * 1024) {
      return { error: 'That plan is ' + Math.round(stat.size / 1048576) + ' MB, which is too big to hand over. '
                    + 'Export it smaller, or screenshot the part that matters.' };
    }
    const dir = path.join(workDir(userDataDir), 'plans');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // Its own name, kept readable, with anything awkward taken out of it.
    const safe = path.basename(sourcePath).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
    const dest = path.join(dir, safe);
    try { fs.copyFileSync(sourcePath, dest); }
    catch (err) { return { error: 'Could not take a copy of that plan: ' + err.message }; }
    return { attached: true, name: safe, path: dest, bytes: stat.size };
  }

  function dictateStop() {
    if (!dictateProc) return { stopped: false };
    // The process exiting emits this too, and the panel gets both. Say it once:
    // here, because a kill that does not take should still end the listening
    // state, and let the close handler see that it has already been said.
    dictateProc.__doneSaid = true;
    try { dictateProc.kill(); } catch (_) {}
    dictateProc = null;
    emit('dictate-done', {});
    return { stopped: true };
  }

  return { status, ask, stop, reset, loginStart, loginCode, loginCancel,
           dictateStart, dictateStop, attachPlan,
           isRunning: () => !!child };
}

module.exports = { createChat };
