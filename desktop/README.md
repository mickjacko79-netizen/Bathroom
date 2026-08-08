# Bathroom — desktop app

Native desktop shell around the Bathroom drawing app, packaged as a Windows exe.
Same shell as `JoineryApp`, pointed at a different drawing file.

## Layout

    Bathroom/                             <- the repo
      bathroom.html                       the drawing app itself — edit this
      jspdf.umd.min.js                    PDF library, so export works offline
      sitemeasure/                        the site-measure app, loaded into the Draw tab
      desktop/                            <- you are here
        main.js                           window, native menu, save/print plumbing
        mcp-transport.js                  loopback HTTP + JSON-RPC, shared by both bridges
        mcp-server.js                     the drawing's Claude bridge — see below
        sitemeasure-mcp.js                the site measure's own bridge — see below
        package.json                      also holds the electron-builder config
        sync-bundle.js                    copies the drawing app into bundled/
        icon.ico / icon.png               app icon (16–256 px)
        bundled/                          packaged copy of the app   (not tracked)
        node_modules/                     Electron + electron-builder (not tracked)
        dist/                                                        (not tracked)
          Bathroom-1.0.0-portable.exe     <- THE STANDALONE EXE (86 MB, single file)
          Bathroom-1.0.0-setup.exe        <- NSIS installer (86 MB)
          win-unpacked/Bathroom.exe       same app, already unpacked (fast to start)

`node_modules`, `dist` and `bundled` are all regenerated — by `npm install` and
`npm run build:all` — so none of them are in git. Everything that is not
regenerated is.

## First run on a fresh clone

    cd desktop
    npm install
    node node_modules\electron\install.js   # only if electron.exe is missing
    npm run build:all

## Which exe to use

| | Startup | Use for |
|---|---|---|
| `dist\win-unpacked\Bathroom.exe` | instant | day-to-day on this PC — the **Bathroom** desktop and Start-menu shortcuts point here |
| `dist\Bathroom-1.0.0-portable.exe` | ~10 s first run | copying to another PC or a USB stick; one self-contained file, installs nothing |
| `dist\Bathroom-1.0.0-setup.exe` | — | proper install on another machine, with its own shortcuts |

The desktop and Start-menu shortcuts are plain `.lnk` files pointing at the
unpacked exe, so a rebuild is picked up without reinstalling anything. They are
not created by the build — if you ever move this folder, recreate them:

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Bathroom.lnk'))
$lnk.TargetPath = 'C:\git\Bathroom\desktop\dist\win-unpacked\Bathroom.exe'
$lnk.IconLocation = 'C:\git\Bathroom\desktop\icon.ico'
$lnk.Save()
```

The portable exe unpacks itself to `%TEMP%` on each run, which is why it starts
more slowly. All three are the same application.

**On another PC, Windows SmartScreen will warn** that the publisher is unknown —
the exe is not code-signed. Click *More info → Run anyway*. Signing needs a paid
code-signing certificate; set `CSC_LINK` / `CSC_KEY_PASSWORD` before building if
you get one.

## Which drawing app it loads

Resolution order, first match wins:

1. an explicit path set via **File → Change bathroom.html location…**
2. `../bathroom.html` — the copy in this repo, so **your edits are picked up on reload**
3. the copy packaged inside the exe — the fallback that makes it standalone

**About** (Help menu) shows which one is live. Settings live in
`%APPDATA%\Bathroom\` (`config.json`, `window-state.json`), separate from
Joinery's, so the two apps do not share window state or file overrides.

## Menu

| Menu | |
|---|---|
| File | Save, Library, Export PDF, Export JSON, Print, open/relocate drawings folder |
| Edit | Undo, Redo, clipboard, delete selected fixture |
| Sheets | Jump to any sheet (Ctrl+1…Ctrl+9), previous/next |
| View | Sheet zoom, fit, full screen, reload, DevTools |
| Claude | The two bridges — copy the connect commands, start them, stop them |
| Help | Keyboard shortcuts, About |

The Sheets menu is read from the running job, not hard-coded — a plan traced
from a site measure has one elevation per wall, which runs well past D.

Edit-menu shortcuts are displayed but not registered app-wide, so `Delete` and
`Ctrl+Z` still behave normally while typing in the sidebar's text fields.

## The Claude bridge

Lets Claude Code on this machine read the drawing that is open and change it
while you watch, instead of you describing the job to it and copying the answer
back by hand. `mcp-server.js` puts the shell's existing page bridge — the same
one the menu drives — behind an MCP endpoint.

Connect it once:

    Claude → Copy connect command…       then paste it into a terminal

That runs `claude mcp add --transport http bathroom http://127.0.0.1:8791/mcp/<token>`.
Start Claude Code afterwards and it can call:

| Tool | |
|---|---|
| `describe_job` | room, walls, and every fitting with its id, set-out and height band |
| `list_fitting_types` | what this app can draw, and which row each type belongs on |
| `add_fitting` | put one on a wall, at a set-out |
| `move_fitting` | slide one along its wall |
| `update_fitting` | width, height off the floor, label |
| `remove_fitting` | take one off |
| `set_room` | room width, length, floor-to-ceiling |
| `describe_site_measure` | the plan traced in the Draw tab — walls, scale, whether it closes, openings |
| `bring_in_from_draw` | turn that traced plan into the drawing |
| `show_sheet` | put a sheet on screen so you can see what changed |

Every change is one undo step, so `Ctrl+Z` takes back whatever it did, exactly as
if you had done it by hand.

## The site measure's bridge

A second one, on its own port with its own token, because the site measure is a
separate component that gets embedded in more than one app. Its integration is
not part of this one: the verbs, the units and the junction rule all live inside
`sitemeasure/inline.html`, and `sitemeasure-mcp.js` only carries messages to it.
Copy the site measure into another app and the integration goes with it — see
[../sitemeasure/CLAUDE-INTEGRATION.md](../sitemeasure/CLAUDE-INTEGRATION.md).

`Claude → Copy connect commands…` hands over both lines. The second is
`claude mcp add --transport http sitemeasure http://127.0.0.1:8792/mcp/<token>`,
and it adds:

| Tool | |
|---|---|
| `describe_site` | the job, scale, walls, openings, rooms, wall types, and how every junction is cut |
| `list_wall_types` | the composite library, with each build-up layer by layer |
| `save_wall_type` | add or edit a composite; layers add up to the thickness |
| `add_walls` | one wall or a whole outline; junctions cut to the rule as they are made |
| `update_wall` | type, thickness, height, status, length, bearing, either end |
| `remove_wall` | and the openings in it |
| `save_opening` | a door or window, positioned to its centre from the start of the wall |
| `remove_opening` | |
| `save_room` | label, position, notes and finishes |
| `remove_room` | |
| `resolve_junctions` | re-cut everything to the rule |
| `set_job` | new job, rename, scale, fit the view, show the plan |

Everything there is millimetres on wall centrelines, x right and y down, 0° east
and 90° north on screen.

**The junction rule.** External walls mitre where they meet at an external
corner. An internal wall butts — it stops on the face of whatever it meets, and
that wall runs on past it unbroken. Where two internals meet, the longer runs
through. A mitre is only ever an external corner. The tools apply it for you,
and **⌙ Resolve junctions** in the site measure's own toolbar does the same by
hand.

**What they listen on.** The loopback interface only, so nothing off this
machine can reach them. They refuse a cross-site `Origin`, so a web page cannot
drive them through your browser. Each address carries a token — kept in the
app's own data directory so it survives a restart and you configure it once.

**What that does not protect against.** Anything running as you on this machine
can read the token files and drive your drawing. That is the trade for not
having to authorise every call. If you would rather they were off, **Claude →
Stop drawing bridge** / **Stop site measure bridge**, or start the app with
`BATHROOM_MCP_PORT` and `SITEMEASURE_MCP_PORT` pointed somewhere harmless. They
also take their ports at launch: if another copy of Bathroom already has 8791 or
8792 that bridge just does not start, and the menu says so.

No dependencies were added for this — the app still has none beyond the copy of
jsPDF beside it, and one endpoint speaking JSON-RPC was not worth breaking that
for.

## Rebuilding after you edit bathroom.html

Day to day you don't need to — **View → Reload app** (Ctrl+R) picks up changes,
because the app prefers the checked-out file over the packaged one.

Rebuild only when you want the *packaged* copy refreshed (i.e. before giving the
portable exe to someone else):

    cd C:\git\Bathroom\desktop
    npm run build              # portable exe  -> dist\Bathroom-1.0.0-portable.exe
    npm run build:installer    # NSIS setup    -> dist\Bathroom-1.0.0-setup.exe
    npm run build:all          # both

`npm run build` runs `sync-bundle.js` first, so the packaged copy always matches
the file in the repo. Bump `version` in `package.json` to change the
filenames.

If `npm install` is ever re-run on a clean checkout and Electron's binary does
not appear (`node_modules\electron\dist\electron.exe` missing), the postinstall
was skipped by the script policy — run it by hand:

    node node_modules\electron\install.js
