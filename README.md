# Bathroom — architectural drawing set

The same app as **Joinery**, with the same look, the same controls and the same
output — set out for bathrooms instead of kitchens. It is one self-contained
HTML file; there is no build step and no server.

    bathroom.html          the app — edit this
    jspdf.umd.min.js       PDF library, kept local so export works with no internet
    sitemeasure/           the site-measure app, loaded into the Draw tab
    sample-sheets/         what the output looks like
    releases/              notes and checksums, one file per released version
    sync-and-run.bat       backs the file up and opens it in the default browser
    backups/               timestamped copies made by sync-and-run.bat (not tracked)
    desktop/               the Electron shell that packages it as a Windows app

Double-click `sync-and-run.bat`, open `bathroom.html` in a browser, or run the
desktop app — all three drive the same file.

## Getting it running

    git clone https://github.com/mickjacko79-netizen/Bathroom.git
    cd Bathroom
    start bathroom.html                 # that is the whole thing

For the desktop app, see `desktop/README.md`. Nothing else needs installing:
the drawing app has no build step and no dependencies beyond the copy of jsPDF
sitting next to it.

## What is the same as Joinery

Everything structural, because it is the same engine: projects and jobs in the
library, undo/redo, autosave, the two draggable control rails, the A3 sheet
viewer with pan/zoom, click-a-fixture-to-edit, the title block, the finishes
board on the cover, the openings, the electrical and lighting layers, PDF and
JSON export, and the **Draw** tab with SiteMeasure in it.

**Site measure → floor plan** works exactly as it does in Joinery. Trace the
room in the Draw tab, then press *Bring in from Draw* in the Site measure panel
(or *Import file…* for a `.sitemeasure.json` captured on a phone). The traced
outline becomes the room, every wall gets its own elevation, and the doors and
windows come across with it. Rooms that are not rectangles are supported —
fixtures sit on whatever wall you put them on, at whatever angle it runs.

Jobs are stored under their own localStorage keys (`bathroom.*`), so this app
and Joinery never see each other's work.

## What is different

**Fixtures.** The base row takes toilet suites, showers, baths, wall-hung and
pedestal basins, and vanity joinery (basin + tap, drawers, doors, linen tower).
The wall row takes mirrors, shaving cabinets, shower niches and towel rails.
Each draws a proper plan symbol and a proper elevation — pan and cistern, bath
hob and rim, shower tray with falls and waste and screen, wall spouts and
mixers, recessed niches.

Every fixture carries the numbers that have to be right on site: the pan
set-out, rim heights, mixer and rose heights, screen height, hob height, waste
position. They are in the fixture's own panel when you select it.

**Wall tiling** replaces the kitchen splashback. It runs on every wall by
default rather than only above the vanity, and it draws the real tile module —
size and bond — at the sheet's own scale, so the setout can be measured off the
elevation.

The tiling is set out from a **datum**, not from wherever the vanity top lands.
Set it in the *Wall tiling* panel as a height above finished floor level; 0 is
FFL, raise it for a hob, a screed or a set-down. Elevations carry a datum mark
and say what the wall gauges out to.

A wall almost never divides into a whole number of courses, so the job says
which end takes the part course:

| Part course goes | What you get |
|---|---|
| Full at bottom | Full tile off the datum, the cut under the tile line |
| Full at top | Full tile at the tile line, the cut at the floor |
| Split both ends | Matched cuts top and bottom |

The panel reads out the actual numbers — how many full courses, how big the cut
is, and where it lands.

**Vanity top** replaces the benchtop, defaulting to 850 rather than 900.

**Sanitaryware schedule** replaces the appliance schedule, and carries brand,
model, set-out and supply for every fixture and every tap. **Fixture schedule**
replaces the cabinet schedule.

**Cover notes** are the wet-area ones: AS 3740 waterproofing, falls to waste,
tiling setout, noggings for wall-hung fixtures.

**The kitchen is gone.** Ovens, cooktops, rangehoods, fridges, dishwashers and
microwaves have been removed from the catalogue, the schedules, the brand
lists, the fixture editor and the drawing code. The laundry stayed — a tub, an
under-bench washer or dryer and a wall-mounted dryer — because a laundry sits
next to a bathroom often enough to be worth having. A job exported from the
Joinery app will still open, but any kitchen appliance in it will not draw.

## Caroma products

Toilets and baths can be set to a real Caroma product instead of a generic
one. Select the fixture, then pick from **Product** at the top of its panel.
Choosing a product sets its width, projection and height, the pan height and
set-out, and puts the brand and item code on the sanitaryware schedule.

Nine products are included — four toilet suites (Urbane II Compact Invisi,
Contura II close-coupled, Contura II Invisi, Riviere close-coupled) and five
baths (Contura II 1700 and 1500 freestanding, Urbane II 1700 back-to-corner,
Newbury 1675 island, Urbane back-to-wall).

The sizes are Caroma's published figures, cross-checked against the geometry in
the CAD model Caroma publishes for each product; anything that disagreed by more
than 12 mm was left out rather than guessed at. Where the outline traced from
that model came out clean it is drawn directly — four in plan, three in
elevation — and where it did not, the app draws its own symbol at the real size.
The fixture's panel says which of the two you are looking at.

This is a copy taken on 3 August 2026. Confirm against the current
specification sheet before ordering or setting out.

## The desktop app

`desktop/` holds an Electron shell that gives the app a window, a native menu
and Save-As plumbing, and packages it as a Windows exe. See `desktop/README.md`.

    cd desktop
    npm install
    npm run build:all      # portable exe + NSIS installer, into desktop/dist/

The build output and `node_modules` are not tracked — they run to about a
gigabyte and are entirely regenerated by those two commands.

The shell prefers **this** `bathroom.html`, one level up from it, over the copy
packaged inside the exe. So editing the file here and pressing Ctrl+R in the app
picks the change up without rebuilding; rebuild only when the packaged copy has
to match, before handing the portable exe to someone else.
