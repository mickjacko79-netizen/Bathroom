// The site measure's own bridge to Claude.
//
// Separate from the drawing's bridge on purpose. The site measure is one
// component that gets embedded in several apps, so its integration is its own
// thing: this file knows nothing about bathrooms, or joinery, or whatever the
// host happens to be. Point it at a window whose page embeds sitemeasure's
// inline.html and it works.
//
// It reaches the component the same way the host page does — by postMessage,
// not by reaching into the iframe. The verbs, the units and the junction rule
// all live inside inline.html under window.smClaude, so the component and its
// integration travel together and this file stays a courier.
//
// Dropping it into another app:
//
//   const sm = require('./sitemeasure-mcp');
//   const handle = sm.startServer({
//     window: mainWindow,           // the window whose page holds the iframe
//     userDataDir: app.getPath('userData'),
//     version: app.getVersion(),
//     frameSelector: '#smFrame',    // optional; the default finds most of them
//     onListening: info => console.log(info.url),
//   });
//
// If the host has a function that creates the iframe on demand — Bathroom's
// ensureSiteMeasureFrame() does — pass its name as `ensureFn` and the bridge
// will call it rather than requiring the tab to have been opened by hand.

const transport = require('./mcp-transport');

const DEFAULT_PORT = Number(process.env.SITEMEASURE_MCP_PORT) || 8792;
const DEFAULT_FRAME_SELECTOR = '#smFrame, iframe[src*="sitemeasure"], iframe[src*="inline.html"]';

// ------------------------------------------------------------- the component --
// Finds the iframe, asks it, waits for the answer on the same request id.
//
// The component answers by message rather than by returning, so every call here
// is a promise the outer wrapper has to await. That is why transport.pageEval
// wraps snippets in an async function: a promise handed to JSON.stringify comes
// back as "{}", which reads as a successful call that found nothing.
function bridgeSnippet(frameSelector, ensureFn) {
  const sel = JSON.stringify(frameSelector || DEFAULT_FRAME_SELECTOR);
  const ensure = JSON.stringify(ensureFn || 'ensureSiteMeasureFrame');
  return `
  const smFrame = () => {
    const named = ${ensure};
    if (named && typeof window[named] === 'function') {
      try { const f = window[named](); if (f && f.contentWindow) return f; } catch (_) {}
    }
    return document.querySelector(${sel});
  };
  // Asking the frame whether it is there yet, rather than assuming it is.
  //
  // A frame that has only just been created is sitting on about:blank with no
  // listener on it, and a message posted into that is not refused — it is
  // simply gone. Which is the ordinary case, not the odd one: the site measure
  // is usually a tab nobody has opened when the first tool call arrives. So
  // knock until it answers.
  const smReady = async () => {
    const f = smFrame();
    if (!f || !f.contentWindow) throw new Error('There is no site measure on this page.');
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const hello = await new Promise(resolve => {
        const reqId = 'sh' + Math.random().toString(36).slice(2);
        const on = ev => {
          const m = ev && ev.data;
          if (!m || m.type !== 'sm-claude-ready' || m.reqId !== reqId) return;
          clearTimeout(t); window.removeEventListener('message', on); resolve(m);
        };
        const t = setTimeout(() => { window.removeEventListener('message', on); resolve(null); }, 500);
        window.addEventListener('message', on);
        try { f.contentWindow.postMessage({ type: 'sm-claude-hello', reqId }, '*'); } catch (_) {}
      });
      if (hello) return f;
    }
    throw new Error('The site measure did not answer. Either it is still loading, or this copy of it ' +
                    'predates the Claude integration and has no window.smClaude in it.');
  };

  const smCall = async (method, params) => {
    const f = await smReady();
    return await new Promise((resolve, reject) => {
      const reqId = 'sc' + Math.random().toString(36).slice(2);
      const on = ev => {
        const m = ev && ev.data;
        if (!m || m.type !== 'sm-claude-result' || m.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', on);
        if (m.ok) resolve(m.value); else reject(new Error(m.error || 'The site measure refused that.'));
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', on);
        reject(new Error('The site measure took the "' + method + '" call and never answered it.'));
      }, 20000);
      window.addEventListener('message', on);
      f.contentWindow.postMessage({ type: 'sm-claude-call', reqId, method, params: params || {} }, '*');
    });
  };
  `;
}

// -------------------------------------------------------------------- tools ---
// One tool per verb the component exposes, so there is nothing to keep in step
// but the names. Everything crossing this boundary is millimetres on wall
// centrelines, x right and y down.
const MM = 'Millimetres.';

function buildTools(win, frameSelector, ensureFn) {
  const prelude = bridgeSnippet(frameSelector, ensureFn);
  const call = (method, args) =>
    transport.pageEval(win, prelude + 'return await smCall(' + JSON.stringify(method) + ', ' +
                            JSON.stringify(args || {}) + ');', 'site measure');

  const tool = (name, description, inputSchema, method) => ({
    name, description, inputSchema,
    run: a => call(method || name, a)
  });

  const obj = (properties, required) => ({
    type: 'object',
    properties,
    required: required || [],
    additionalProperties: false
  });

  const wallTypeProp = {
    type: 'string',
    description: 'Which wall type to build it in — its id, or its name, or enough of the name to ' +
                 'pick it out. Call list_wall_types to see them. Leave it out to use the library default.'
  };

  return [
    tool('describe_site',
      'Everything the site measure is holding: the job, the scale, every wall with its type and ' +
      'thickness and length, every opening, every room, the wall-type library, and how each junction ' +
      'is currently cut. Call this first — the other tools take the ids it returns. All millimetres.',
      obj({}), 'describe'),

    tool('list_wall_types',
      'The wall-type library — the composites walls are built in. Each carries its category ' +
      '(external, internal, wet or party), its total thickness, and its layers from one face to the other.',
      obj({})),

    tool('save_wall_type',
      'Add a wall type to the library, or edit one that is already there. Give it layers and the ' +
      'thickness adds itself up. The category decides how the wall behaves at a junction: external ' +
      'and party walls mitre at a corner, internal and wet walls butt.',
      obj({
        id: { type: 'string', description: 'The id of the type to edit. Leave it out to add a new one, or to edit by name.' },
        name: { type: 'string', description: 'What it is called — "Brick veneer 230", "Wet area partition". Matching an existing name edits that one.' },
        category: { type: 'string', enum: ['external', 'internal', 'wet', 'party'],
                    description: 'external or party walls mitre at corners; internal and wet walls butt into whatever they meet.' },
        thicknessMm: { type: 'number', description: 'Total thickness. ' + MM + ' Ignored when layers are given — they add up to it.' },
        insideFirst: { type: 'boolean', description: 'Whether the FIRST layer is the skin that faces into the building. True unless you say otherwise. Walls are drawn with that skin facing in whichever way round they were drawn, so a brick veneer listed 10 plasterboard first is insideFirst true, and one listed 110 face brick first is insideFirst false.' },
        layers: { type: 'array', description: 'The build-up from one face to the other, in order.',
                  items: obj({
                    thicknessMm: { type: 'number', description: 'Thickness of this layer. ' + MM },
                    material: { type: 'string', description: 'What the layer is — "face brick", "stud", "plasterboard", "cavity".' }
                  }, ['thicknessMm', 'material']) },
        color: { type: 'string', description: 'Hex colour it draws in on the plan, like "#c2410c".' },
        hatch: { type: 'boolean', description: 'Whether to hatch it — true for masonry, false for framed walls.' }
      }, ['name'])),

    tool('add_walls',
      'Draw one wall or a run of them. Give points as [x,y] pairs in millimetres, or a start point ' +
      'plus segments of lengthMm and angleDeg. Junctions are cut to the rule as they are made: two ' +
      'external walls meeting at a corner mitre, and an internal wall butts — it stops on the face ' +
      'of whatever it meets, and that wall runs on past it unbroken.',
      obj({
        points: { type: 'array', description: 'The run, as [x,y] points on the wall centrelines. ' + MM + ' x right, y down.',
                  items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
        start: { type: 'array', description: 'Where the run starts, as [x,y], when you are giving segments rather than points. ' + MM,
                 items: { type: 'number' }, minItems: 2, maxItems: 2 },
        segments: { type: 'array', description: 'The run as lengths and bearings from the start point.',
                    items: obj({
                      lengthMm: { type: 'number', description: 'How long this wall is. ' + MM },
                      angleDeg: { type: 'number', description: 'Which way it heads: 0 is east, 90 is north on screen.' }
                    }, ['lengthMm', 'angleDeg']) },
        closed: { type: 'boolean', description: 'Close the run back to its first point. Use this for the outside of a building.' },
        anchor: { type: 'string', enum: ['centre', 'inside', 'outside'],
                  description: 'What the points describe. "centre" (the default) is wall centrelines. ' +
                               '"inside" means you gave the inside face — the room dimensions off a plan — and the walls ' +
                               'are pushed out half a thickness. "outside" is the reverse. Both need closed:true.' },
        wallType: wallTypeProp,
        heightMm: { type: 'number', description: 'Wall height. ' + MM + ' Defaults to 2400.' },
        status: { type: 'string', enum: ['new', 'existing', 'demo'],
                  description: 'Whether these walls are new work, existing, or coming out.' },
        replace: { type: 'boolean', description: 'Clear every wall and opening in the job first. Use this when redrawing a plan from scratch.' },
        resolve: { type: 'boolean', description: 'Cut the junctions afterwards. True unless you say otherwise.' }
      })),

    tool('update_wall',
      'Change one wall — its type, thickness, height, status, its length or bearing, or either end ' +
      'outright. The junctions it touches are re-cut afterwards.',
      obj({
        wall: { type: 'string', description: 'The id of the wall, from describe_site.' },
        wallType: wallTypeProp,
        thicknessMm: { type: 'number', description: 'Override the thickness for this wall alone, leaving the library type as it is. ' + MM },
        lengthMm: { type: 'number', description: 'Set the measured length. ' + MM + ' The far end moves; the anchored end stays put.' },
        angleDeg: { type: 'number', description: 'Swing it to this bearing: 0 is east, 90 is north on screen.' },
        start: { type: 'array', description: 'Put the start end at this [x,y]. ' + MM, items: { type: 'number' }, minItems: 2, maxItems: 2 },
        end: { type: 'array', description: 'Put the far end at this [x,y]. ' + MM, items: { type: 'number' }, minItems: 2, maxItems: 2 },
        heightMm: { type: 'number', description: 'Wall height. ' + MM },
        status: { type: 'string', enum: ['new', 'existing', 'demo'], description: 'New work, existing, or coming out.' },
        flipSkins: { type: 'boolean', description: 'Turn this wall\'s build-up round, so the skin that was drawn facing into the building faces out. Use it when describe_site shows the wrong material facing in on one wall.' },
        resolve: { type: 'boolean', description: 'Cut the junctions afterwards. True unless you say otherwise.' }
      }, ['wall'])),

    tool('remove_wall',
      'Take a wall out of the plan. Any openings in it go with it — they have nowhere left to sit.',
      obj({ wall: { type: 'string', description: 'The id of the wall, from describe_site.' } }, ['wall'])),

    tool('save_opening',
      'Put a door or window in a wall, or edit one already there. The position is to the middle of ' +
      'the opening, measured from the start of the wall, and it is held far enough along that the ' +
      'whole opening stays inside the wall.',
      obj({
        opening: { type: 'string', description: 'The id of an opening to edit. Leave it out to add a new one.' },
        wall: { type: 'string', description: 'The id of the wall it sits in. Required for a new opening.' },
        type: { type: 'string', enum: ['door', 'window', 'opening', 'sliding', 'bifold'],
                description: 'What it is. "opening" is a hole with nothing in it.' },
        label: { type: 'string', description: 'Its mark on the schedule — D01, W03.' },
        widthMm: { type: 'number', description: 'Structural width of the opening. ' + MM },
        heightMm: { type: 'number', description: 'Height of the opening. ' + MM },
        sillMm: { type: 'number', description: 'Height of the sill above the floor. ' + MM + ' Zero for a door.' },
        positionMm: { type: 'number', description: 'To the middle of the opening, from the start of the wall. ' + MM },
        room: { type: 'string', description: 'Which room it serves, for the schedule.' },
        hingeSide: { type: 'string', enum: ['left', 'right'], description: 'Which side the door is hung.' },
        swingDir: { type: 'string', enum: ['inside', 'outside'], description: 'Which way the door swings.' },
        notes: { type: 'string', description: 'Anything else worth recording against it.' }
      })),

    tool('remove_opening',
      'Take a door or window out of the plan and off the schedule.',
      obj({ opening: { type: 'string', description: 'The id of the opening, from describe_site.' } }, ['opening'])),

    tool('save_room',
      'Label a room on the plan, or edit one. The label sits at the point you give, so put it ' +
      'somewhere inside the room. Finishes and notes ride along with it into the schedules.',
      obj({
        room: { type: 'string', description: 'The id of a room to edit. Leave it out to add a new one.' },
        label: { type: 'string', description: 'What the room is called — "Ensuite", "Kitchen".' },
        at: { type: 'array', description: 'Where the label sits, as [x,y] inside the room. ' + MM,
              items: { type: 'number' }, minItems: 2, maxItems: 2 },
        outline: { type: 'array', description: 'The room\'s corners in order, as [x,y] pairs. ' + MM + ' ' +
                   'Give this to draw an L-shaped or T-shaped room outright. Leave it out and the room ' +
                   'keeps whatever shape it has.',
                   items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
        traceOutline: { type: 'boolean', description: 'Work the outline out from the walls and dividers closing the room in, and use that. This is the way to get an L or a T right without listing corners — the room has to be enclosed and its label has to sit inside it.' },
        color: { type: 'string', description: 'Hex tint for the room fill, like "#38bdf8". One is picked for you if you leave it out.' },
        notes: { type: 'string', description: 'Site notes for this room — defects, services, anything measured.' },
        floorFinish: { type: 'string', description: 'Floor finish recorded on site.' },
        wallFinish: { type: 'string', description: 'Wall finish recorded on site.' },
        ceilingFinish: { type: 'string', description: 'Ceiling finish and height recorded on site.' }
      })),

    tool('remove_room',
      'Take a room label, and the notes and finishes recorded against it, off the plan.',
      obj({ room: { type: 'string', description: 'The id of the room, from describe_site.' } }, ['room'])),

    tool('resolve_junctions',
      'Re-cut every junction in the plan to the rule: two external walls meeting at a corner mitre, ' +
      'and an internal wall stops on the face of whatever it meets while that wall runs on past it ' +
      'unbroken. Where two internals meet, the longer one runs through. Safe to run twice.',
      obj({})),

    tool('set_job',
      'Start a new site measure, or rename the open one, set its scale, fit the plan on screen, or ' +
      'bring the plan tab to the front.',
      obj({
        newJob: { type: 'boolean', description: 'Start a fresh job rather than changing the open one. The open job is kept and can be reopened from the Jobs tab.' },
        name: { type: 'string', description: 'What the job is called — usually the address.' },
        address: { type: 'string', description: 'Site address.' },
        client: { type: 'string', description: 'Who it is for. Only used when starting a new job.' },
        scaleMmPerUnit: { type: 'number', description: 'Millimetres per drawing unit. Walls drawn through these tools set this to 1, so a unit is a millimetre.' },
        fitView: { type: 'boolean', description: 'Zoom the plan to fit what has been drawn.' },
        showPlan: { type: 'boolean', description: 'Bring the Plan tab to the front so the user can see it.' }
      }))
  ];
}

// --------------------------------------------------------------------- HTTP --
function startServer({ window, userDataDir, version, port, frameSelector, ensureFn,
                       onListening, onError }) {
  return transport.startServer({
    tools: buildTools(window, frameSelector, ensureFn),
    name: 'sitemeasure',
    title: 'SiteMeasure — the as-built plan on screen',
    instructions:
      'These tools read and change the site measure open on this machine, live: walls and the wall ' +
      'types they are built in, doors and windows, rooms and their finishes. Call describe_site ' +
      'first — it carries the scale and the id of everything else, and the other tools take those ' +
      'ids. Everything is in millimetres, measured on wall centrelines, x right and y down, with 0° ' +
      'east and 90° north on screen. ' +
      'Junctions follow one rule and the tools apply it for you: external walls mitre where they ' +
      'meet at an external corner; an internal wall butts, stopping on the face of whatever it ' +
      'meets while that wall runs on past it unbroken; where two internals meet, the longer runs ' +
      'through. A mitre is only ever an external corner. ' +
      'Every change is one undo step in the app.',
    tokenFile: 'sitemeasure-mcp-token',
    defaultPort: DEFAULT_PORT,
    userDataDir, version, port, onListening, onError
  });
}

module.exports = { startServer, DEFAULT_PORT, DEFAULT_FRAME_SELECTOR };
