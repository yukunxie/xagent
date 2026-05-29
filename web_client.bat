@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "WEB_DIR=%~dp0web-client"
set "PORT=18080"
set "URL=http://localhost:%PORT%"

echo [xAgent Web Client] 正在启动...
echo.

:: ── 优先用 Python 的内置 HTTP server ──────────────────────────────
where python >nul 2>&1
if %errorlevel% equ 0 (
    python --version 2>&1 | findstr /i "Python 3" >nul
    if !errorlevel! equ 0 (
        echo [xAgent Web] 使用 Python 3 HTTP server ^( %URL% ^)
        start "" "%URL%"
        timeout /t 1 /nobreak >nul
        python -m http.server %PORT% --directory "%WEB_DIR%"
        exit /b
    )
)

:: ── 再尝试 python3 命令 ───────────────────────────────────────────
where python3 >nul 2>&1
if %errorlevel% equ 0 (
    echo [xAgent Web] 使用 Python3 HTTP server ^( %URL% ^)
    start "" "%URL%"
    timeout /t 1 /nobreak >nul
    python3 -m http.server %PORT% --directory "%WEB_DIR%"
    exit /b
)

:: ── 再用 Node.js + npx serve ─────────────────────────────────────
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo [xAgent Web] 使用 Node.js ^(npx serve^) ^( %URL% ^)
    start "" "%URL%"
    timeout /t 2 /nobreak >nul
    npx --yes serve -l %PORT% "%WEB_DIR%"
    exit /b
)

:: ── 兜底：直接用 file:// 打开 ────────────────────────────────────
echo [xAgent Web] 未找到 HTTP server，直接在浏览器中打开文件...
start "" "%WEB_DIR%\index.html"
echo.
echo 提示: 安装 Python 3 可获得更好的体验 ^(http://localhost:%PORT%^)
pause
