@echo off
cd /d "%~dp0"

if exist "src-tauri\target\release\xagent.exe" (
    echo [xAgent] Starting release build...
    start "" "src-tauri\target\release\xagent.exe"
) else (
    echo [xAgent] No release build found, starting dev server...
    set npm_config_prefer_offline=true
    npm run tauri dev
)
