[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw '包内 Node.js runtime 缺失。' }
& $node (Join-Path $root 'erp\server\environment.mjs') @Arguments
exit $LASTEXITCODE
