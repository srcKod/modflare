@echo off
REM Thin wrapper — all logic is in kill-wrangler-dev.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-wrangler-dev.ps1"
