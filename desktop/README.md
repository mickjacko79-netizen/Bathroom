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
| Help | Keyboard shortcuts, About |

The Sheets menu is read from the running job, not hard-coded — a plan traced
from a site measure has one elevation per wall, which runs well past D.

Edit-menu shortcuts are displayed but not registered app-wide, so `Delete` and
`Ctrl+Z` still behave normally while typing in the sidebar's text fields.

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
