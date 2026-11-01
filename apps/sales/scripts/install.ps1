[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$SalesRoot = Split-Path -Parent $PSScriptRoot
$SalesLauncher = Join-Path $PSScriptRoot 'start-app.ps1'
$SalesMonthly = Join-Path $PSScriptRoot 'run-monthly.ps1'
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
$SalesUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$EscapeUser = [Security.SecurityElement]::Escape($SalesUser)
$EscapeCommand = [Security.SecurityElement]::Escape($PowerShellExe)
$EscapeArgs = [Security.SecurityElement]::Escape('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $SalesMonthly + '"')
$EscapeWorking = [Security.SecurityElement]::Escape($SalesRoot)
$SalesXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Sales Desk: monthly on day 15 at 20:00 Asia/Shanghai. Disabled until real data acceptance.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>2026-10-15T20:00:00+08:00</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>15</Day></DaysOfMonth><Months><January/><February/><March/><April/><May/><June/><July/><August/><September/><October/><November/><December/></Months></ScheduleByMonth></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>$EscapeUser</UserId></LogonTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$EscapeUser</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>false</Enabled><ExecutionTimeLimit>PT30M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$EscapeCommand</Command><Arguments>$EscapeArgs</Arguments><WorkingDirectory>$EscapeWorking</WorkingDirectory></Exec></Actions>
</Task>
"@
$SalesXmlPath = Join-Path $PSScriptRoot 'monthly-task.xml'
$SalesXml | Set-Content -LiteralPath $SalesXmlPath -Encoding Unicode
$ExistingSalesTask = Get-ScheduledTask -TaskName 'Wucheng-SalesDesk-Monthly' -ErrorAction SilentlyContinue
if ($ExistingSalesTask) {
  Write-Output 'Existing sales schedule preserved. Inspect it before changing.'
} else {
  Register-ScheduledTask -TaskName 'Wucheng-SalesDesk-Monthly' -Xml $SalesXml | Out-Null
}
Get-ScheduledTask -TaskName 'Wucheng-SalesDesk-Monthly' | Select-Object TaskName, State
Write-Output (Join-Path $SalesDesktop $SalesShortcutName)
