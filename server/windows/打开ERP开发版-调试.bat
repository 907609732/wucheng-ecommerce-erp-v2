@echo off
chcp 65001 >nul
title Wucheng ERP Dev Console - debug
set ERP_LOG_LEVEL=debug
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0dev-console.ps1" -Debug
