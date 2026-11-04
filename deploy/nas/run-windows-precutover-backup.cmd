@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-precutover-backup.ps1"
set "result=%errorlevel%"
if not "%result%"=="0" echo Backup failed. The ERP service and backup status must be checked before retrying.
if "%result%"=="0" echo Backup and verification completed.
pause
exit /b %result%
