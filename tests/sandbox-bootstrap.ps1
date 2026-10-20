$ErrorActionPreference = 'Stop'
try {
  $mode = (Get-Content C:\Kit\mode.txt -Raw).Trim()
  "Starting fresh $mode Windows installation" | Set-Content C:\Results\bootstrap.log
  if ($mode -eq 'offline') {
    Expand-Archive -LiteralPath C:\Input\Lingtu-0.8.0-Complete-Offline-Windows-x64.zip -DestinationPath C:\Bundle
  } else {
    New-Item -ItemType Directory C:\Bundle -Force | Out-Null
    Copy-Item C:\Input\CloudWarehouseInventorySync-Setup-0.8.0-x64.exe C:\Bundle
  }
  $installer = Start-Process -FilePath C:\Bundle\CloudWarehouseInventorySync-Setup-0.8.0-x64.exe -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "Installer exited $($installer.ExitCode)" }
  "Installer completed" | Add-Content C:\Results\bootstrap.log
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\wucheng-ecommerce-erp-v2\云仓库存同步.exe'
  if (!(Test-Path -LiteralPath $exe)) { throw 'Installed launcher was not found' }
  # The fresh launcher has no modules or jobs. Close its optional NSIS auto-start
  # before the isolated acceptance driver creates its own controlled UI session.
  Get-Process | Where-Object { $_.Path -eq $exe } | ForEach-Object { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue }
  $env:ELECTRON_RUN_AS_NODE = '1'
  "Starting acceptance driver" | Add-Content C:\Results\bootstrap.log
  $driver = Start-Process -FilePath $exe -ArgumentList 'C:\Kit\sandbox-driver.mjs','C:\Results',$mode -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput C:\driver-stdout.log -RedirectStandardError C:\driver-stderr.log
  Copy-Item C:\driver-stdout.log,C:\driver-stderr.log C:\Results
  "Driver exit: $($driver.ExitCode)" | Add-Content C:\Results\bootstrap.log
  if ($driver.ExitCode -eq 0 -and $env:USERNAME -eq 'WDAGUtilityAccount' -and (Test-Path C:\Results\result.json)) {
    $result = Get-Content C:\Results\result.json -Raw | ConvertFrom-Json
    if ($result.ok) { & "$env:WINDIR\System32\shutdown.exe" /s /t 0 }
  }
} catch {
  ($_ | Format-List * -Force | Out-String) | Set-Content C:\Results\bootstrap-error.txt -Encoding UTF8
}
