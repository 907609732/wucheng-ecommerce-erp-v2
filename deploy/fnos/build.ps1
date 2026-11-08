param(
    [string]$Fnpack = 'C:/Tools/fnpack/fnpack.exe',
    [string]$OutputDir = (Join-Path $env:TEMP 'wuchengerp-fpk-builds')
)
$ErrorActionPreference = 'Stop'
$packageRoot = Join-Path $PSScriptRoot 'wuchengerp'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not (Test-Path -LiteralPath $Fnpack -PathType Leaf)) { throw 'Install official fnpack 1.2.3 and supply its executable path.' }
$fnpackHelp = (& $Fnpack --help 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $fnpackHelp -notmatch 'Version 1\.2\.3') { throw 'Expected official fnpack 1.2.3.' }
# Stage only these repository-owned package assets; never copy a deployment folder.
$allowed = @(
    'manifest', 'config/privilege', 'config/resource', 'app/ui/config',
    'cmd/main', 'cmd/install_init', 'cmd/install_callback',
    'cmd/upgrade_init', 'cmd/upgrade_callback', 'cmd/uninstall_init',
    'cmd/uninstall_callback', 'cmd/config_init', 'cmd/config_callback'
)
$buildRoot = Join-Path ([IO.Path]::GetFullPath($OutputDir)) ([Guid]::NewGuid().ToString('N'))
$stage = Join-Path $buildRoot 'wuchengerp'
New-Item -ItemType Directory -Path (Join-Path $stage 'wizard') -Force | Out-Null
foreach ($relative in $allowed) {
    $source = Join-Path $packageRoot $relative
    if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked source: $relative" }
    $target = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
# Reuse the existing bitmap unmodified; no private configuration or logs enter the FPK.
$logo = Join-Path $repoRoot 'shared/ui/loading-logo.png'
foreach ($relative in @('ICON.PNG', 'ICON_256.PNG', 'app/ui/images/icon_64.png', 'app/ui/images/icon_256.png')) {
    $target = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $logo -Destination $target
}
Push-Location $buildRoot
try {
    & $Fnpack build --directory $stage
    if ($LASTEXITCODE -ne 0) { throw 'Official fnpack build failed.' }
} finally { Pop-Location }
$artifacts = @(Get-ChildItem -LiteralPath $buildRoot -File -Filter '*.fpk')
if ($artifacts.Count -ne 1) { throw "Expected exactly one FPK in $buildRoot" }
$artifact = $artifacts[0]
$hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $($artifact.Name)" | Set-Content -LiteralPath (Join-Path $buildRoot 'SHA256SUMS.txt') -Encoding ascii
[pscustomobject]@{ Package = $artifact.FullName; SHA256 = $hash; Stage = $stage; Note = 'Not installed or deployed.' }
