# SiteMeasure AU

A browser-based site-measure app for capturing residential as-built drawings on-site in Australia.

## Run it

This is a static web app — no server, no build step. Two ways to use it:

1. **Locally:** Open `index.html` in Chrome, Edge, Safari, or Firefox. Works on phone, tablet, or laptop.
2. **Offline / installable:** Serve the folder from any static host (Netlify, GitHub Pages, your own server) over HTTPS. Then "Add to Home Screen" — it'll work fully offline thanks to the service worker, which matters when you're under a slab with no signal.

For local development with full PWA support, run a simple local server in the folder:

```
python -m http.server 8000
# then open http://localhost:8000
```

## What it does

- **Jobs** — create one per site visit (address, client, date). Stored in your browser via IndexedDB so you can carry multiple jobs around.
- **Plan** — sketch the floor plan with click-to-click wall drawing. Snap-to-grid and ortho lock for clean walls.
- **Dimension** — tap any wall, enter the measured mm. First dimension sets the overall scale; subsequent dimensions are stored against each wall for the schedule and DXF.
- **Openings** — tap a wall to place a door/window. Captures type, ref, W × H × sill, room, notes.
- **Rooms & notes** — label rooms on the plan, then record finishes/services/defects per room.
- **Photos** — capture from your phone's camera or upload. Annotate with arrows, circles, text.
- **Schedule** — auto-built door & window schedule.
- **Export PDF** — title page, dimensioned floor plan, schedule, room notes, photo pages.
- **Export DXF** — opens in AutoCAD/BricsCAD/LibreCAD/Revit. Walls on `A-WALL`, doors on `A-DOOR`, glazing on `A-GLAZ`, units in mm.
- **Backup JSON** — full export with embedded photos, importable on another device.

## Workflow on-site

1. New job → enter address.
2. Plan tab → rough-sketch the outline with the Wall tool (don't worry about exact size).
3. Dim tool → tap one wall you've measured, type the mm. The plan rescales automatically.
4. Keep dim'ing each measured wall — those measured values are what go to PDF/DXF.
5. Opening tool → tap a wall where each door/window goes, fill the dialog.
6. Photos tab → capture rooms / defects / details.
7. Rooms tab → add finish + defect notes per room.
8. Export tab → PDF for the client, DXF for the draftsperson.

## Wall junctions

Where walls meet is decided one way, everywhere: external walls mitre at an
external corner; an internal wall butts, stopping on the face of whatever it
meets while that wall runs on past it unbroken; where two internals meet, the
longer runs through. A mitre is only ever an external corner.

Drawing a chain with the Wall tool applies it as you go. **⌙ Resolve junctions**
in the Plan toolbar re-cuts everything to it, which is what to reach for after
importing a plan or changing a wall's type. Running it twice changes nothing.

## Claude

SiteMeasure carries its own Claude integration — `window.smClaude`, plus a
postMessage door for whichever app it is embedded in. Walls, wall types,
openings and rooms are all reachable, and everything drawn through it follows
the junction rule above.

There is an **🤖 Ask Claude** panel in the top bar too, so you can ask for the
plan to be drawn without leaving it. It only appears when the app hosting
SiteMeasure says it can answer; on its own in a browser there is nobody to ask
and the button stays hidden.

See [CLAUDE-INTEGRATION.md](CLAUDE-INTEGRATION.md).

## Notes / known limits (this is v1)

- The "sketch then auto-scale" model uses the first measured wall as the master scale. Other walls keep their sketched proportions but display/export their measured length where given. For a fully reconciled plan, dimension every wall before exporting DXF.
- Room polygons aren't auto-detected — rooms are labelled points. (Easy to add later.)
- No login / cloud sync — data lives in your browser. Use the JSON export for backup or to move between devices.

## Files

- `index.html` — UI shell
- `app.js` — all app logic
- `sw.js` — service worker (offline cache)
- `manifest.webmanifest` + `icon.svg` — PWA install metadata
