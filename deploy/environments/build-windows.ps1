[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$AcceptedRelease,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$Commit,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+$')][string]$RunId
)
$ErrorActionPreference = 'Stop'
$nodeVersion = '24.22.2'
$expectedZipSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
$release = (Resolve-Path $AcceptedRelease).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw "Output must be a new directory: $output" }
$artifactRoot = Split-Path $output -Parent
foreach ($name in @('environment-build.json','environment-acceptance.json','environment-receipt.json',((Split-Path $output -Leaf) + '.zip'),((Split-Path $output -Leaf) + '.zip.sha256'))) {
  if (Test-Path -LiteralPath (Join-Path $artifactRoot $name)) { throw "Artifact sidecar already exists: $name" }
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("erp-win-build-" + [guid]::NewGuid().ToString('N'))
$runtime = Join-Path $scratch 'runtime'
$zipPath = Join-Path $scratch "node-v$nodeVersion-win-x64.zip"
$sumsPath = Join-Path $scratch 'SHASUMS256.txt'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
try {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $zipPath
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $sumsPath
  $sumLine = Select-String -LiteralPath $sumsPath -Pattern "^$expectedZipSha256\s+node-v$nodeVersion-win-x64\.zip$"
  if (-not $sumLine) { throw 'Official SHASUMS256.txt does not contain the pinned Windows archive hash.' }
  if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedZipSha256) { throw 'Node archive SHA256 mismatch.' }
  $extract = Join-Path $scratch 'extract'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extract
  $nodeFolder = Join-Path $extract "node-v$nodeVersion-win-x64"
  New-Item -ItemType Directory -Path (Join-Path $runtime 'node') | Out-Null
  Copy-Item -Path (Join-Path $nodeFolder '*') -Destination (Join-Path $runtime 'node') -Recurse
  New-Item -ItemType Directory -Path (Join-Path $runtime 'licenses') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeFolder 'LICENSE') -Destination (Join-Path $runtime 'licenses\Node.js-LICENSE')
  $nodeExe = Join-Path $runtime 'node\node.exe'
  $versionOutput = & $nodeExe --version
  if ($LASTEXITCODE -ne 0 -or $versionOutput -ne "v$nodeVersion") { throw 'Prepared Node runtime version check failed.' }
  & node (Join-Path $PSScriptRoot 'package.mjs') --target windows-x64 --release $release --runtime $runtime --output $output --commit $Commit --run $RunId
  if ($LASTEXITCODE -ne 0) { throw 'Environment packaging failed.' }
  $zip = "$output.zip"
  Compress-Archive -Path (Join-Path $output '*') -DestinationPath $zip -CompressionLevel Optimal
  $unpacked = Join-Path $scratch 'unpacked-package'
  Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
  $erpRoot = Join-Path $unpacked 'erp'
  $erpNode = Join-Path $unpacked 'runtime\node\node.exe'
  $bundledVersionOutput = & $erpNode --version
  if ($LASTEXITCODE -ne 0 -or $bundledVersionOutput -ne "v$nodeVersion") { throw 'Unpacked package Node runtime version check failed.' }
  $metadataPath = Join-Path $unpacked 'environment-build.json'
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  Push-Location $repoRoot
  try { $sourceCheck = & node deploy/environments/metadata.mjs --verify-source $erpRoot $metadataPath 2>&1; $sourceCheckExit = $LASTEXITCODE }
  finally { Pop-Location }
  if ($sourceCheckExit -ne 0) { throw "Unpacked package common-source digest check failed: $sourceCheck" }
  Push-Location $erpRoot
  try { $releaseCheck = & $erpNode --input-type=module -e "import {verifyRelease} from './server/release.mjs'; const m=verifyRelease('.'); console.log(JSON.stringify({accepted:m.accepted}));" 2>&1 }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0 -or (($releaseCheck | Select-Object -Last 1) | ConvertFrom-Json).accepted -ne $true) { throw 'Unpacked package accepted-release verification failed.' }
  $oldEnv = @{}
  $businessEnv = Get-ChildItem Env: | Where-Object { $_.Name -match '^(ERP_|LINGTU_|PURCHASE_DATA_DIR$|SALES_DATA_DIR$|OVERVIEW_DATA_DIR$|OVERVIEW_(PURCHASE|SALES)_DB$|SALES_DEMO$)' } | ForEach-Object Name
  foreach ($name in $businessEnv) { $oldEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  $smokeText = @()
  try { $smokeText = & $erpNode (Join-Path $erpRoot 'server\acceptance.mjs') 2>&1; $acceptanceExit = $LASTEXITCODE }
  finally { foreach ($name in $businessEnv) { [Environment]::SetEnvironmentVariable($name, $oldEnv[$name], 'Process') } }
  if ($acceptanceExit -ne 0) { throw 'Unpacked package acceptance smoke failed.' }
  $rawResult = $smokeText | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
  if (-not $rawResult) { throw 'Unpacked package acceptance did not return JSON.' }
  $acceptance = $rawResult | ConvertFrom-Json
  if (-not $acceptance.ok -or $acceptance.services.Count -ne 3) { throw 'Unpacked package acceptance did not pass all three services.' }
  $acceptance | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $artifactRoot 'windows-acceptance.json') -Encoding utf8
  $metadata = Get-Content -LiteralPath (Join-Path $unpacked 'environment-build.json') -Raw | ConvertFrom-Json
  Copy-Item -LiteralPath (Join-Path $unpacked 'environment-build.json') -Destination (Join-Path $artifactRoot 'environment-build.json')
  $environmentAcceptance = [ordered]@{ schemaVersion=1; ok=$true; cleanupComplete=$true; target='windows-x64'; version=$metadata.version; commit=$metadata.commit; runId=$metadata.runId; nodeVersion=$metadata.nodeVersion; checks=[ordered]@{ bundledNodeVersion=$bundledVersionOutput; acceptedRelease=$true; services=3; runtimeAcceptance=$true } }
  $environmentAcceptance | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $artifactRoot 'environment-acceptance.json') -Encoding utf8
  $packageHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $packageName = Split-Path $zip -Leaf
  $receipt = [ordered]@{ schemaVersion=1; target='windows-x64'; packageFile=$packageName; packageSHA256=$packageHash; acceptance=[ordered]@{ passed=$true; evidence=@('environment-acceptance.json') } }
  $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $artifactRoot 'environment-receipt.json') -Encoding utf8
  $packageHash | Set-Content -LiteralPath "$zip.sha256" -NoNewline -Encoding ascii
} finally {
  if (Test-Path -LiteralPath $scratch) {
    $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $leaf = Split-Path $resolvedScratch -Leaf
    if (-not $resolvedScratch.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or $leaf -notmatch '^erp-win-build-[0-9a-f]{32}$') { throw 'Refusing to remove scratch outside the verified temporary prefix.' }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
  }
}
