param([string]$Version='0.11.0')
$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$kit=Join-Path $root ('dist\suite-sandbox-kit-'+$Version)
$results=Join-Path $root ('dist\module-verification\suite-sandbox-'+$Version)
$inputFolder=Join-Path $root 'dist\launcher-release'
New-Item -ItemType Directory -Force -Path $kit,$results,(Join-Path $kit 'tools\node_modules') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'tests\suite-sandbox-driver.mjs') -Destination $kit
Copy-Item -LiteralPath (Join-Path $root 'tests\suite-sandbox-resume-check.mjs') -Destination $kit
[IO.File]::WriteAllText((Join-Path $kit 'suite-sandbox-resume.ps1'),(Get-Content -LiteralPath (Join-Path $root 'tests\suite-sandbox-resume.ps1') -Raw -Encoding utf8),[Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllText((Join-Path $kit 'suite-sandbox-boot-probe.ps1'),(Get-Content -LiteralPath (Join-Path $root 'tests\suite-sandbox-boot-probe.ps1') -Raw -Encoding utf8),[Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllText((Join-Path $kit 'suite-sandbox-book-probe.ps1'),(Get-Content -LiteralPath (Join-Path $root 'tests\suite-sandbox-book-probe.ps1') -Raw -Encoding utf8),[Text.UTF8Encoding]::new($true))
$Version | Set-Content -LiteralPath (Join-Path $kit 'version.txt') -Encoding ascii
[IO.File]::WriteAllText((Join-Path $kit 'suite-sandbox-bootstrap.ps1'),(Get-Content -LiteralPath (Join-Path $root 'tests\suite-sandbox-bootstrap.ps1') -Raw -Encoding utf8),[Text.UTF8Encoding]::new($true))
foreach($name in @('playwright','playwright-core')){Copy-Item -LiteralPath (Join-Path $root ('node_modules\'+$name)) -Destination (Join-Path $kit 'tools\node_modules') -Recurse -Force}
$a=[Security.SecurityElement]::Escape($inputFolder)
$b=[Security.SecurityElement]::Escape($kit)
$c=[Security.SecurityElement]::Escape($results)
$config=@"
<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking><MemoryInMB>4096</MemoryInMB><AudioInput>Disable</AudioInput><ClipboardRedirection>Disable</ClipboardRedirection><MappedFolders><MappedFolder><HostFolder>$a</HostFolder><SandboxFolder>C:\Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$b</HostFolder><SandboxFolder>C:\Kit</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$c</HostFolder><SandboxFolder>C:\Results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Kit\suite-sandbox-bootstrap.ps1</Command></LogonCommand></Configuration>
"@
$file=Join-Path $kit 'complete-offline.wsb'
[IO.File]::WriteAllText($file,$config,[Text.UTF8Encoding]::new($false))
Write-Output $file
