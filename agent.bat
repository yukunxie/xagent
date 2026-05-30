@echo off
setlocal

rem 启动 opencode-bridge 并打开 agent.html
rem 用法: agent.bat [项目目录] [WebSocket 端口]

set DIR=%~1
if "%DIR%"=="" set DIR=%CD%

set PORT=%~2
if "%PORT%"=="" set PORT=9001

cd /d "%~dp0opencode-bridge"

rem 安装依赖（首次）
if not exist node_modules (
    echo [bridge] 安装依赖...
    npm install
)

echo [bridge] 启动 opencode-bridge，工作目录: %DIR%，端口: %PORT%
node --experimental-strip-types src/index.ts --dir "%DIR%" --port %PORT%
