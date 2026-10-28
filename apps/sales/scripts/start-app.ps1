param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$SalesRoot = Split-Path -Parent $PSScriptRoot
$SalesData = Join-Path $SalesRoot 'data'
New-Item -ItemType Directory -Path $SalesData -Force | Out-Null
$SalesPortFile = Join-Path $SalesData 'server.port'
$SalesPreferredPort = 17869
if (Test-Path -LiteralPath $SalesPortFile) {
  $SalesSavedPort = 0
  if ([int]::TryParse((Get-Content -LiteralPath $SalesPortFile -Raw).Trim(), [ref]$SalesSavedPort) -and $SalesSavedPort -ge 17869 -and $SalesSavedPort -le 17889) { $SalesPreferredPort = $SalesSavedPort }
}
function Test-SalesHealth {
  try { $result = Invoke-RestMethod -Uri "$SalesUrl/api/health" -TimeoutSec 2; return ($result.app -eq 'wucheng-sales-desk') } catch { return $false }
}
$SalesOccupiedPorts = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort)
$SalesPort = $null
foreach ($SalesCandidate in (@($SalesPreferredPort) + @(17869..17889) | Select-Object -Unique)) {
  $SalesUrl = "http://127.0.0.1:$SalesCandidate"
  if ($SalesOccupiedPorts -notcontains $SalesCandidate -or (Test-SalesHealth)) { $SalesPort = $SalesCandidate; break }
}
if ($null -eq $SalesPort) { throw 'No available sales desk port in 17869-17889.' }
if (-not (Test-SalesHealth)) {
  $SalesNode = (Get-Command node.exe -ErrorAction Stop).Source
  $SalesServer = Join-Path $SalesRoot 'server.mjs'
  $SalesPreviousPort = $env:SALES_PORT
  try {
    $env:SALES_PORT = [string]$SalesPort
    $proc = Start-Process -FilePath $SalesNode -ArgumentList @('"' + $SalesServer + '"') -WorkingDirectory $SalesRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $SalesData 'server.log') -RedirectStandardError (Join-Path $SalesData 'server-error.log') -PassThru
  } finally { $env:SALES_PORT = $SalesPreviousPort }
  $proc.Id | Set-Content -LiteralPath (Join-Path $SalesData 'server.pid') -Encoding ascii
  $limit = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $limit -and -not (Test-SalesHealth)) { $proc.Refresh(); if ($proc.HasExited) { break }; Start-Sleep -Milliseconds 300 }
}
if (-not (Test-SalesHealth)) { throw 'Sales desk did not become ready. Check data/server-error.log.' }
$SalesPort | Set-Content -LiteralPath $SalesPortFile -Encoding ascii
if (-not $NoBrowser) { Start-Process $SalesUrl | Out-Null }
Write-Output $SalesUrl
