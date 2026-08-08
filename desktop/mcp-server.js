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
// The transport under it — loopback binding, Origin check, token in the path —
// lives in mcp-transport.js, shared with the site measure's own bridge.

const transport = require('./mcp-transport');

const DEFAULT_PORT = Number(process.env.BATHROOM_MCP_PORT) || 8791;

// Everything below reaches the drawing the same way the menu does: a snippet
// evaluated in the page, returning JSON. The page's functions are top-level in a
// classic inline script, so they are simply in scope.
const pageEval = (win, expression) => transport.pageEval(win, expression, 'Bathroom');

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
  // SiteMeasure answers in two shapes and they are easy to mistake for each
  // other. What it volunteers is flat — walls and openings at the top level, and
  // that is what importSiteMeasure reads. What it hands over when asked for a job
  // to keep is the export, with all of that a level down under .job, and that is
  // what lands in state.siteMeasure. Reading the flat shape off the stored one
  // finds nothing at all, which looks exactly like an empty Draw tab rather than
  // like a bug.
  const smFlat = j => {
    if(!j) return null;
    const core = (j.job && typeof j.job === 'object') ? j.job : j;
    return { format:'sitemeasure-job',
             scaleMmPerUnit: core.scaleMmPerUnit || null,
             walls: core.walls || [], openings: core.openings || [], rooms: core.rooms || [] };
  };
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
      name: 'describe_site_measure',
      description:
        'Read the plan traced in the Draw tab — the site measure the drawing gets built from. ' +
        'Says how many walls have been drawn, whether a scale has been set, whether they close ' +
        'into a room, and what doors and windows are on them. Use it to answer questions about ' +
        'the measure, and to check it is ready before calling bring_in_from_draw.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => call(`
        // The Draw tab builds its frame the first time it is opened, so a job
        // that has not been there yet has nothing to ask.
        if(typeof ensureSiteMeasureFrame === 'function') ensureSiteMeasureFrame();
        const got = await captureSiteMeasurePlan(2500);
        const job = smFlat(state.siteMeasure);
        if(!got && !job) return { traced: false,
          note: 'Nothing has been traced yet, or the Draw tab has not finished loading. Open the Draw tab and trace the room.' };
        if(!job) return { traced:false, note:'Nothing has been traced yet.' };
        const walls = (job.walls || []).filter(w => isFinite(w.x1) && isFinite(w.y1) && isFinite(w.x2) && isFinite(w.y2));
        const scale = (typeof job.scaleMmPerUnit === 'number' && job.scaleMmPerUnit > 0) ? job.scaleMmPerUnit : null;
        const out = { traced: true, wallsDrawn: walls.length, scaleSet: !!scale };
        if(!scale) out.blocking = 'No scale is set. Dimension one wall in the Draw tab first, or nothing can be brought in.';
        // Say the lengths in millimetres where we can, since that is what the
        // person is holding a tape measure against.
        if(scale) out.wallLengths = walls.map(w =>
          Math.round(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) * scale));
        out.openings = (job.openings || []).map(o => ({ kind: o.type || 'opening', width: o.widthMm || null }));
        // Whether it closes is what decides if it can be brought in at all.
        try {
          const tol = scale ? 60 / scale : 0;
          out.closesIntoARoom = scale ? !!smTraceLoop(walls, tol) : null;
          if(scale && !out.closesIntoARoom)
            out.blocking = 'The walls do not close into a room — check they join at the corners.';
        } catch(_){ out.closesIntoARoom = null; }
        return out;
      `)
    },

    {
      name: 'set_site_measure',
      description:
        'Draw a plan into the Draw tab — the walls of a room, given as millimetres. Use it to ' +
        'reproduce a floor plan you have been shown: read the dimensions off it, work out the ' +
        'corners, and send them here. Coordinates are millimetres on a flat plan, x to the right ' +
        'and y down; the corners of a rectangular room 2400 wide and 2700 deep are (0,0), (2400,0), ' +
        '(2400,2700), (0,2700). Walls must join end to end and close back to the first corner, or ' +
        'nothing can be brought in from it afterwards. This replaces whatever is in the Draw tab. ' +
        'Openings are not carried yet — add doors and windows in the Draw tab by hand.',
      inputSchema: {
        type: 'object',
        properties: {
          walls: {
            type: 'array',
            description: 'The walls, in order around the room, each joining the next.',
            items: {
              type: 'object',
              properties: {
                x1: { type: 'number', description: 'Start corner, millimetres across.' },
                y1: { type: 'number', description: 'Start corner, millimetres down.' },
                x2: { type: 'number', description: 'End corner, millimetres across.' },
                y2: { type: 'number', description: 'End corner, millimetres down.' },
                thickness: { type: 'number', description: 'Wall thickness in millimetres. Defaults to 90.' },
                height:    { type: 'number', description: 'Wall height in millimetres. Defaults to the room height.' }
              },
              required: ['x1', 'y1', 'x2', 'y2'],
              additionalProperties: false
            }
          },
          name: { type: 'string', description: 'What to call the plan. Optional.' }
        },
        required: ['walls'],
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        const src = a.walls || [];
        if(src.length < 3) throw new Error('A room needs at least three walls. Got ' + src.length + '.');
        const bad = src.findIndex(w => ![w.x1,w.y1,w.x2,w.y2].every(n => typeof n === 'number' && isFinite(n)));
        if(bad >= 0) throw new Error('Wall ' + (bad+1) + ' has a corner that is not a number.');
        // Say so here rather than letting it fail later at the import, where the
        // message is about a loop that cannot be traced and the actual mistake —
        // two corners that do not meet — is several steps back.
        for(let i = 0; i < src.length; i++){
          const cur = src[i], nxt = src[(i+1) % src.length];
          const gap = Math.hypot(nxt.x1 - cur.x2, nxt.y1 - cur.y2);
          if(gap > 1) throw new Error('Wall ' + (i+1) + ' ends at (' + Math.round(cur.x2) + ',' + Math.round(cur.y2)
            + ') but wall ' + (((i+1) % src.length) + 1) + ' starts at (' + Math.round(nxt.x1) + ',' + Math.round(nxt.y1)
            + ') — ' + Math.round(gap) + ' mm apart. They have to meet, and the last has to close back to the first.');
        }
        pushHistory();
        // One unit is one millimetre, so what arrives is what gets drawn and
        // there is no scale to be set by hand before it can be used.
        const H = state.room.H || 2400;
        const payload = {
          format: 'sitemeasure-job',
          appVersion: 'bathroom-bridge',
          exportedAt: new Date().toISOString(),
          job: {
            id: 'smj_' + Math.random().toString(36).slice(2,10),
            name: a.name || 'Reproduced plan',
            scaleMmPerUnit: 1,
            walls: src.map((w,i) => ({
              id: 'w' + (i+1),
              x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
              thicknessMmOverride: w.thickness > 0 ? w.thickness : 90,
              heightMm: w.height > 0 ? w.height : H
            })),
            openings: [], rooms: [], markups: [], dividers: [],
            northDeg: 0, underlay: null, stories: null, activeStoryId: null
          },
          composites: []
        };
        state.siteMeasure = payload;
        // Into the Draw tab as well as into the job, so it is there to look at
        // and correct rather than only usable through a tool.
        if(typeof ensureSiteMeasureFrame === 'function') ensureSiteMeasureFrame();
        const f = document.getElementById('smFrame');
        let shown = false;
        if(f && f.contentWindow){
          try { f.contentWindow.postMessage({ type:'sm-import-job-json', data: payload }, '*'); shown = true; }
          catch(_){}
        }
        try { scheduleAutosave(); } catch(_){}
        const per = src.map(w => Math.round(Math.hypot(w.x2-w.x1, w.y2-w.y1)));
        const xs = src.flatMap(w => [w.x1, w.x2]), ys = src.flatMap(w => [w.y1, w.y2]);
        return { wallsDrawn: src.length, wallLengths: per,
                 overall: { width: Math.round(Math.max.apply(null,xs) - Math.min.apply(null,xs)),
                            depth: Math.round(Math.max.apply(null,ys) - Math.min.apply(null,ys)) },
                 shownInDrawTab: shown,
                 next: 'Call bring_in_from_draw to turn this into the drawing.' };
      `)
    },

    {
      name: 'bring_in_from_draw',
      description:
        'Turn the plan traced in the Draw tab into the drawing: the room outline, a wall per traced ' +
        'wall, and optionally the doors and windows on them. This is the "Bring in from Draw" button. ' +
        'It replaces the room and its walls, so anything already placed on a wall may be affected — ' +
        'call describe_job first if that matters. One undo step.',
      inputSchema: {
        type: 'object',
        properties: {
          openings: { type: 'boolean',
            description: 'Bring the doors and windows across too. Defaults to true.' }
        },
        additionalProperties: false
      },
      run: a => call(`
        const a = ${JSON.stringify(a)};
        if(typeof ensureSiteMeasureFrame === 'function') ensureSiteMeasureFrame();
        await captureSiteMeasurePlan(2500);
        const job = smFlat(state.siteMeasure);
        if(!job || !(job.walls || []).length) throw new Error('Nothing has been traced yet. Open the Draw tab and trace the room first.');
        pushHistory();
        // importSiteMeasure says exactly what is wrong — no scale, walls that do
        // not meet, a degenerate outline — so let it, rather than replacing it
        // with something vaguer.
        const r = importSiteMeasure(job, { openings: a.openings !== false });
        renderWallLetterList(); renderWallBars();
        touched();
        showView('plan'); renderActive();
        return { broughtIn: { walls: r.walls, letters: r.letters,
                              room: { width: r.W, length: r.L },
                              openingsPlaced: r.placed || 0, openingsSkipped: r.skipped || 0 } };
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

// --------------------------------------------------------------------- HTTP --
function startServer({ window, userDataDir, version, port, onListening, onError }) {
  return transport.startServer({
    tools: buildTools(window),
    name: 'bathroom',
    title: 'Bathroom — the drawing on screen',
    instructions:
      'These tools read and change the bathroom drawing open on this machine, live. Call ' +
      'describe_job first — it carries the room, the walls, and the id of every fitting, and the ' +
      'other tools take those ids. Set-outs are millimetres from the start of a wall to a ' +
      "fitting's near edge. Every change is one undo step in the app.",
    tokenFile: 'mcp-token',
    defaultPort: DEFAULT_PORT,
    userDataDir, version, port, onListening, onError
  });
}

module.exports = { startServer, DEFAULT_PORT };
