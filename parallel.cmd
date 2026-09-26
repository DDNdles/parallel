@echo off
rem ============================================================
rem  parallel launcher (Windows). Double-click or run from shell.
rem  Usage: parallel.cmd [--data-dir <dir>] [--port <port>]
rem  NOTE: keep this file ASCII-only. cmd.exe parses batch files
rem  with the legacy ANSI codepage (GBK on zh-CN systems), so
rem  UTF-8 Chinese comments here would be executed as garbage.
rem ============================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo [parallel] Node.js not found. Please install Node 24 or newer from https://nodejs.org
  pause
  exit /b 1
)
node bin\parallel.js %*
if errorlevel 1 pause
endlocal
