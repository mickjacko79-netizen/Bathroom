@echo off
REM ============================================================
REM  Bathroom — sync-and-run
REM  Creates a timestamped backup of bathroom.html, then opens the
REM  app in the default browser.
REM ============================================================

setlocal ENABLEEXTENSIONS
set "APP_DIR=%~dp0"
set "APP_FILE=%APP_DIR%bathroom.html"
set "BACKUP_DIR=%APP_DIR%backups"

echo.
echo [Bathroom] Working folder: %APP_DIR%

REM ---- Verify the app file exists ----
if not exist "%APP_FILE%" (
    echo [Bathroom] ERROR: bathroom.html not found in this folder.
    echo Expected: %APP_FILE%
    pause
    exit /b 1
)

REM ---- Make a timestamped backup ----
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value ^| find "="') do set "DT=%%I"
set "STAMP=%DT:~0,4%%DT:~4,2%%DT:~6,2%_%DT:~8,2%%DT:~10,2%%DT:~12,2%"
set "BACKUP_FILE=%BACKUP_DIR%\bathroom_%STAMP%.html"
copy /Y "%APP_FILE%" "%BACKUP_FILE%" >nul
if exist "%BACKUP_FILE%" (
    echo [Bathroom] Backup saved: %BACKUP_FILE%
) else (
    echo [Bathroom] WARNING: backup failed.
)

REM ---- Prune old backups: keep newest 20 ----
pushd "%BACKUP_DIR%" >nul
for /f "skip=20 delims=" %%F in ('dir /b /o-d bathroom_*.html 2^>nul') do (
    del /q "%%F" >nul 2>&1
)
popd >nul

REM ---- Open in the default browser ----
echo [Bathroom] Launching app in default browser...
start "" "%APP_FILE%"

REM Brief pause so you can read the messages if launched by double-click.
timeout /t 3 /nobreak >nul
endlocal
exit /b 0
