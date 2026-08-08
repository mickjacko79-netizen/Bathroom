# The site measure's Claude integration

SiteMeasure carries its own integration. It is not part of the app it happens to
be embedded in, so it goes wherever `inline.html` goes — copy the file into
another app and the integration is already there.

There are three pieces, and only the first is required.

| | Where it lives | What it is |
|---|---|---|
| The component side | `sitemeasure/inline.html` | `window.smClaude` and a postMessage door |
| The host bridge | `desktop/sitemeasure-mcp.js` | an MCP server that drives it from Electron |
| The chat panel | `sitemeasure/inline.html` | **🤖 Ask Claude** in the top bar, answered by the host |

## The rule it knows

> External walls mitre where they meet at an external corner. An internal wall
> butts — it stops on the face of whatever it meets, and that wall runs on past
> it unbroken. Where two internals meet, the longer runs through. A mitre is
> only ever an external corner.

Everything that draws or edits a wall applies this. It is applied when a chain
is drawn by hand with the Wall tool, when walls arrive through the integration,
and on demand from **⌙ Resolve junctions** in the Plan toolbar. `wallCornersMitered()`
follows the same rule when it draws the faces, so what is stored and what is on
screen agree.

Running it twice changes nothing: a junction already cut resolves to the same
point, because the face lines it is cut against don't move when a wall is
shortened or run on.

An external corner is a corner between two **external** walls — including the
re-entrant corner of an L-shaped plan, which is still brickwork turning a corner
and still mitres. "External" here means the wall's type is categorised
`external` or `party`; `internal` and `wet` are internal.

## Talking to it from a host page

```js
const frame = document.querySelector('#smFrame');

// Is this copy carrying the integration at all?
frame.contentWindow.postMessage({ type: 'sm-claude-hello', reqId: 'x1' }, '*');
// -> { type:'sm-claude-ready', reqId:'x1', version, app:'sitemeasure', methods:[...], rule }

frame.contentWindow.postMessage({
  type: 'sm-claude-call', reqId: 'x2',
  method: 'add_walls',
  params: { points: [[0,0],[4200,0],[4200,3600],[0,3600]],
            closed: true, anchor: 'inside', wallType: 'Brick veneer' }
}, '*');
// -> { type:'sm-claude-result', reqId:'x2', ok:true, value:{...} }
// -> { type:'sm-claude-result', reqId:'x2', ok:false, error:'...' } on a refusal
```

A newly created iframe is on `about:blank` with no listener on it, and a message
posted into that is not refused — it is simply gone. Knock with
`sm-claude-hello` until it answers before sending anything that matters.

Inside the page itself, `await window.smClaude.call(method, params)` is the same
thing without the postMessage.

## The verbs

All millimetres, measured on wall **centrelines**, x right and y down, 0° east
and 90° north on screen.

| Verb | What it does |
|---|---|
| `describe` | the job, the scale, walls, openings, rooms, the wall-type library, and every junction |
| `list_wall_types` | the composite library |
| `save_wall_type` | add or edit a composite; layers add up to the thickness |
| `add_walls` | one wall or a run; junctions cut as they are made |
| `update_wall` | type, thickness, height, status, length, bearing, either end |
| `remove_wall` | and the openings in it, which have nowhere left to sit |
| `save_opening` | add or edit a door or window |
| `remove_opening` | |
| `save_room` | label, position, notes and finishes |
| `remove_room` | |
| `resolve_junctions` | re-cut everything to the rule |
| `set_job` | new job, rename, scale, fit the view, show the plan |

Each mutating verb takes its own undo step, so anything done through the
integration comes back with one Ctrl+Z.

### `add_walls` and the anchor

`anchor` says what the points you gave describe:

- `centre` (the default) — wall centrelines, which is what the file stores.
- `inside` — the inside face. This is what you read off a plan: "the room is
  4200 × 3600". Each run is pushed out half a thickness and the corners are put
  back together, so the finished inside clear is the number you asked for.
- `outside` — the reverse.

`inside` and `outside` need `closed: true`; there is no inside to a run that
doesn't enclose anything.

## Dropping the host side into another Electron app

`sitemeasure-mcp.js` knows nothing about the app around it. It needs
`mcp-transport.js` next to it and nothing else — no dependencies.

```js
const sm = require('./sitemeasure-mcp');

sm.startServer({
  window: mainWindow,                 // the window whose page holds the iframe
  userDataDir: app.getPath('userData'),
  version: app.getVersion(),
  frameSelector: '#smFrame',          // optional; the default finds most of them
  ensureFn: 'ensureSiteMeasureFrame', // optional; a global that makes the frame on demand
  onListening: info => console.log(info.url),
  onError: err => console.warn(err.message),
});
```

Then, once:

```
claude mcp add --transport http sitemeasure http://127.0.0.1:8792/mcp/<token>
```

It binds to loopback only, refuses a cross-site `Origin`, and keeps a token in
the path, held in the app's own data directory so the address survives a
restart. Being plain about the limit: anything already running as you can read
that token file.

`SITEMEASURE_MCP_PORT` moves it off 8792 if something else wants that port.

## The chat panel, and answering for it

There is an **🤖 Ask Claude** button in the top bar. It is hidden until a host
says it can answer, so opening this file on its own shows nothing and runs none
of it.

The site measure cannot reach Claude itself — it is a page in an iframe with no
shell behind it, and it stays that way on purpose. So it asks:

```
out   { type:'sm-chat-call', reqId, method, args }
back  { type:'sm-chat-result', reqId, ok, value }   or { ok:false, error }
push  { type:'sm-chat-event', payload }             as a turn is written
```

`sm-chat-hello` is answered with `sm-chat-ready`, and that is what reveals the
button. The site measure knocks every half second for twenty seconds, so the
host's own bridge does not have to be up before the iframe loads.

The methods a host is asked for: `status`, `ask`, `stop`, `reset`, `loginStart`,
`loginCode`, `loginCancel`, `dictateStart`, `dictateStop`, `attachPlan`. Refuse
anything else by name rather than ignoring it — a call that never comes back
leaves the panel stuck on "Working…".

The events pushed back are whatever your Claude runner emits: `start`, `text`,
`tool`, `error`, `done`, plus `dictate-text` / `dictate-done` / `dictate-error`
and `auth-url` / `auth-done` if you support those.

**It is one conversation, not two.** The host's panel and this one share a
thread, so asking here writes into both. That is the point: asking about the
plan in here and about the joinery in there is one conversation that has seen
both. If your host has no panel of its own, nothing changes.

In Bathroom the whole answer is about forty lines at the end of the chat panel's
script in `bathroom.html` — forward those ten methods to `window.bathroomChat`,
and fan `onEvent` out to whichever frames have said hello. Copy that.

## If you are hosting it somewhere that isn't Electron

Nothing above needs Electron except `mcp-transport.js`'s use of
`webContents.executeJavaScript`. The component side is ordinary postMessage, so
a web host can drive `window.smClaude` directly and skip the MCP server
entirely.
