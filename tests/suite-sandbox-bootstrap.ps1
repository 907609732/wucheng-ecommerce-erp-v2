$ErrorActionPreference='Stop'
try {
  if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'This installer acceptance bootstrap is restricted to Windows Sandbox'}
  if(Test-Path C:\WorkbenchAcceptanceReboot.json){& C:\WorkbenchAcceptanceResume.ps1;return}
  $results='C:\Results'
  'Starting complete-suite offline Windows Sandbox acceptance' | Set-Content (Join-Path $results 'bootstrap.log')
  $version=(Get-Content C:\Kit\version.txt -Raw).Trim()
  $installer=Join-Path C:\Input ('CloudWarehouseInventorySync-Setup-'+$version+'-x64.exe')
  $before=[ordered]@{noSystemNode=!(Get-Command node.exe -ErrorAction SilentlyContinue);noBrowserCache=!(Test-Path (Join-Path $env:LOCALAPPDATA 'ms-playwright'));noBusinessSource=!(Test-Path (Join-Path $env:USERPROFILE 'Documents\ChatGPT'));windowsUser=$env:USERNAME;networking='Disable in .wsb'}
  $before | ConvertTo-Json | Set-Content (Join-Path $results 'environment-before.json') -Encoding UTF8
  if(!$before.noSystemNode -or !$before.noBrowserCache -or !$before.noBusinessSource){throw 'Sandbox is not a fresh prerequisite-free environment'}
  $p=Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru
  if(!$p.WaitForExit(600000)){throw 'Fresh complete installer did not finish in ten minutes'}
  if($p.ExitCode -ne 0){throw ('Fresh installer failed: '+$p.ExitCode)}
  'Initial installer completed' | Add-Content (Join-Path $results 'bootstrap.log')
  $exe=Join-Path $env:LOCALAPPDATA 'Programs\wucheng-ecommerce-erp-v2\云仓库存同步.exe'
  if(!(Test-Path -LiteralPath $exe)){throw 'Installed workbench was not found'}
  # Only the fresh Sandbox foreground process is closed; production profiles are
  # inaccessible to this VM and the host's network is disabled only inside it.
  Get-Process | Where-Object {$_.Path -eq $exe} | ForEach-Object {Stop-Process -Id $_.Id -ErrorAction SilentlyContinue}
  # The acceptance runner must not use the product executable's process name:
  # the real uninstaller is expected to close product processes. Copy only the
  # public Electron vendor runtime, keeping business resources in the install.
  $harness='C:\Harness'
  New-Item -ItemType Directory -Force -Path $harness | Out-Null
  $installRoot=Split-Path $exe
  Get-ChildItem -LiteralPath $installRoot -File | Where-Object {$_.Name -ne (Split-Path $exe -Leaf) -and $_.Name -notlike 'Uninstall*'} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $harness}
  Copy-Item -LiteralPath (Join-Path $installRoot 'locales') -Destination $harness -Recurse
  $runner=Join-Path $harness 'WorkbenchAcceptance.exe'
  Copy-Item -LiteralPath $exe -Destination $runner
  $env:ELECTRON_RUN_AS_NODE='1'
  $driver=Start-Process -FilePath $runner -ArgumentList 'C:\Kit\suite-sandbox-driver.mjs','C:\Results',$installer,$exe -WindowStyle Hidden -PassThru -RedirectStandardOutput C:\driver-stdout.log -RedirectStandardError C:\driver-stderr.log
  if(!$driver.WaitForExit(1200000)){throw 'Offline suite acceptance exceeded twenty minutes'}
  Copy-Item -LiteralPath C:\driver-stdout.log,C:\driver-stderr.log -Destination $results
  ('Driver exit: '+$driver.ExitCode) | Add-Content (Join-Path $results 'bootstrap.log')
  if(Test-Path (Join-Path $results 'result.json')){
    $result=Get-Content (Join-Path $results 'result.json') -Raw | ConvertFrom-Json
    if($result.rebootPending){& "$env:WINDIR\System32\shutdown.exe" /r /t 0}
    elseif($result.ok -ne $null){while(!(Test-Path C:\Results\close-request.txt)){Start-Sleep -Seconds 1};& "$env:WINDIR\System32\shutdown.exe" /s /t 0}
  }
} catch {
  ($_ | Format-List * -Force | Out-String) | Set-Content C:\Results\bootstrap-error.txt -Encoding UTF8
}
