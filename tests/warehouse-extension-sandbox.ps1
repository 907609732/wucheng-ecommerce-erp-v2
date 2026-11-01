$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$candidate=Get-Content -LiteralPath (Join-Path $root '.codex-artifacts/engineering/installer-current.json') -Raw | ConvertFrom-Json
if(Get-Process WindowsSandboxClient -ErrorAction SilentlyContinue){throw 'An existing Windows Sandbox is open; preserve that session.'}
$kit=Join-Path $root '.codex-artifacts/warehouse-extension-sandbox-kit'
$results=Join-Path $root '.codex-artifacts/warehouse-extension-sandbox-results'
New-Item -ItemType Directory -Force -Path $kit,$results | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'tests/warehouse-extension-sandbox-bootstrap.ps1') -Destination $kit
@{file=[IO.Path]::GetFileName($candidate.installer);sha256=(Get-FileHash -LiteralPath $candidate.installer -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $kit 'candidate.json') -Encoding utf8
$a=[Security.SecurityElement]::Escape([IO.Path]::GetDirectoryName($candidate.installer))
$b=[Security.SecurityElement]::Escape($kit)
$c=[Security.SecurityElement]::Escape($results)
$xml=@"
<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking><MemoryInMB>4096</MemoryInMB><AudioInput>Disable</AudioInput><ClipboardRedirection>Disable</ClipboardRedirection><MappedFolders><MappedFolder><HostFolder>$a</HostFolder><SandboxFolder>C:\Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$b</HostFolder><SandboxFolder>C:\Kit</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$c</HostFolder><SandboxFolder>C:\Results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Kit\warehouse-extension-sandbox-bootstrap.ps1</Command></LogonCommand></Configuration>
"@
$file=Join-Path $kit 'clean-install.wsb'
[IO.File]::WriteAllText($file,$xml,[Text.UTF8Encoding]::new($false))
Start-Process -FilePath (Join-Path $env:WINDIR 'System32/WindowsSandbox.exe') -ArgumentList ('"'+$file+'"') -WindowStyle Hidden
Write-Output $results
