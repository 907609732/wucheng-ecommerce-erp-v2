$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$kit = Join-Path $root 'dist\sandbox-kit'
$results = Join-Path $root 'dist\module-verification\sandbox-offline'
$inputFolder = Join-Path $root 'dist\launcher-release'
New-Item -ItemType Directory -Force -Path $kit,$results | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'tests\sandbox-driver.mjs') -Destination $kit
Get-Content -LiteralPath (Join-Path $root 'tests\sandbox-bootstrap.ps1') -Raw -Encoding utf8 | Set-Content -LiteralPath (Join-Path $kit 'sandbox-bootstrap.ps1') -Encoding utf8BOM
$xmlInput = [Security.SecurityElement]::Escape($inputFolder)
$xmlKit = [Security.SecurityElement]::Escape($kit)
$xmlResults = [Security.SecurityElement]::Escape($results)
$configuration = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
  <MemoryInMB>3072</MemoryInMB>
  <AudioInput>Disable</AudioInput>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder><HostFolder>$xmlInput</HostFolder><SandboxFolder>C:\Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$xmlKit</HostFolder><SandboxFolder>C:\Kit</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$xmlResults</HostFolder><SandboxFolder>C:\Results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Kit\sandbox-bootstrap.ps1</Command></LogonCommand>
</Configuration>
"@
$configPath = Join-Path $kit 'offline-acceptance.wsb'
[IO.File]::WriteAllText($configPath,$configuration,[Text.UTF8Encoding]::new($false))
Write-Output $configPath
