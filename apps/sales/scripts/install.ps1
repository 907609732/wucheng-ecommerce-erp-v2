[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$SalesRoot = Split-Path -Parent $PSScriptRoot
$SalesLauncher = Join-Path $PSScriptRoot 'start-app.ps1'
$PowerShellExe = Join-Path $PSHOME 'powershell.exe'
$SalesDesktop = [Environment]::GetFolderPath('Desktop')
$SalesShortcutName = (-join @([char]0x7075,[char]0x5154,[char]0x7535,[char]0x5546,[char]0x9500,[char]0x552e,[char]0x53f0)) + '.lnk'
$SalesShell = New-Object -ComObject WScript.Shell
$SalesShortcut = $SalesShell.CreateShortcut((Join-Path $SalesDesktop $SalesShortcutName))
$SalesShortcut.TargetPath = $PowerShellExe
$SalesShortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $SalesLauncher + '"'
$SalesShortcut.WorkingDirectory = $SalesRoot
$SalesShortcut.Description = 'Lingtu e-commerce sales and reconciliation desk'
$SalesShortcut.Save()
Write-Output (Join-Path $SalesDesktop $SalesShortcutName)
