$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'VM reboot acceptance is restricted to Windows Sandbox'}
$mutex=New-Object System.Threading.Mutex($false,'Local\LingtuSuiteAcceptanceResume')
if(!$mutex.WaitOne(0)){return}
try {
  if(Test-Path C:\WorkbenchAcceptanceReboot.done){return}
  $state=Get-Content C:\WorkbenchAcceptanceReboot.json -Raw -Encoding utf8 | ConvertFrom-Json
  $deadline=(Get-Date).AddSeconds(180)
  while(!(Test-Path $state.output) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 500}
  $evidence=Get-Content (Join-Path $state.output 'result.json') -Raw -Encoding utf8 | ConvertFrom-Json
  try {
    if(!$state.bootWitness.volatileKey -or !$state.bootWitness.token){throw 'Pre-reboot machine witness is missing'}
    if(Test-Path ('HKLM:\'+$state.bootWitness.volatileKey)){throw 'Volatile machine boot witness still exists; actual guest reboot was not observed'}
    $afterBootTime=$null;$afterBootError=$null
    try{$afterBootTime=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')}catch{$afterBootError=($_ | Out-String)}
    if($state.bootWitness.beforeBootTime -and $afterBootTime -and [DateTime]::Parse($afterBootTime).ToUniversalTime() -le [DateTime]::Parse($state.bootWitness.beforeBootTime).ToUniversalTime()){throw 'WMI did not observe a newer guest boot'}
    $process=$null
    while((Get-Date) -lt $deadline){
      $hostFile=Join-Path (Split-Path $state.registryFile) 'host.json'
      if(Test-Path $hostFile){
        try{$hostRecord=Get-Content $hostFile -Raw | ConvertFrom-Json;$found=Get-Process -Id $hostRecord.pid -ErrorAction Stop;if($found.Path -eq $state.productExe){$process=$found;break}}catch{}
      }
      Start-Sleep -Milliseconds 500
    }
    if(!$process){throw 'Windows Run did not start the hidden workbench bound to the expected registry'}
    $visible=$process.MainWindowHandle
    if($visible -ne 0){throw 'Login startup displayed a foreground main window'}
    $run=(Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').'五成电子商务工作台'
    if(!$run -or $run.Length -gt 260 -or $run -notlike '*--hidden*' -or !$run.Contains($state.productExe)){throw 'Windows Run command is missing, points elsewhere or exceeds its supported limit'}
    $evidence | Add-Member -NotePropertyName startup -NotePropertyValue @{ok=$true;actualGuestRestart=$true;volatileMachineKeyCleared=$true;hidden=$true;canonicalRegistry=$true;runCommandCharacters=$run.Length} -Force
    $check=& C:\WorkbenchAcceptanceBookProbe.ps1 -StateFile C:\WorkbenchAcceptanceReboot.json -OutputStem (Join-Path $state.output 'post-reboot-books')
    $evidence.checks+= 'Actual Windows Sandbox reboot invokes the real Run item, starts hidden with the canonical registry and retains five synthetic books/originals'
    $evidence | Add-Member -NotePropertyName reboot -NotePropertyValue @{ok=$true;actualGuestRestart=$true;volatileMachineKeyCleared=$true;hidden=$true;canonicalRegistry=$true;books=$check.books;runCommandCharacters=$run.Length;afterBootTime=$afterBootTime;wmiError=$afterBootError} -Force
    $evidence.rebootPending=$false
    $evidence.ok=$true
    'PASS after actual guest reboot' | Add-Content (Join-Path $state.output 'progress.log')
  } catch {
    $evidence.ok=$false
    $evidence.rebootPending=$false
    $evidence | Add-Member -NotePropertyName error -NotePropertyValue ($_ | Out-String) -Force
    'FAIL post-reboot verification' | Add-Content (Join-Path $state.output 'progress.log')
  }
  [IO.File]::WriteAllText((Join-Path $state.output 'result.json'),($evidence | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
  'completed' | Set-Content C:\WorkbenchAcceptanceReboot.done
  [IO.File]::WriteAllText((Join-Path $state.output 'guest-status.json'),(@{phase='awaiting-host';ok=$evidence.ok;closeMarker='C:\Results\close-request.txt';productExe=$state.productExe} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  while(!(Test-Path C:\Results\close-request.txt)){Start-Sleep -Seconds 1}
  & "$env:WINDIR\System32\shutdown.exe" /s /t 0
} catch {
  ($_ | Out-String) | Set-Content C:\WorkbenchAcceptanceResume-error.txt -Encoding utf8
  if(Test-Path C:\Results){($_ | Out-String) | Set-Content C:\Results\reboot-bootstrap-error.txt -Encoding utf8}
  while(!(Test-Path C:\Results\close-request.txt)){Start-Sleep -Seconds 1}
  & "$env:WINDIR\System32\shutdown.exe" /s /t 0
} finally {
  $mutex.ReleaseMutex();$mutex.Dispose()
}
