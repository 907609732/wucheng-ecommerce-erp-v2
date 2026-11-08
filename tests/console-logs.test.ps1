param([string]$Helper = (Join-Path $PSScriptRoot '..\server\windows\console-logs.ps1'))
$ErrorActionPreference = 'Stop'
. $Helper
$dir = Join-Path ([IO.Path]::GetTempPath()) ('erp-console-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $dir)
$file = Join-Path $dir 'web.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Assert-Equal($actual, $expected, $label) {
    if ($actual -ne $expected) { throw "$label expected [$expected] got [$actual]" }
}

[IO.File]::WriteAllText($file, "2026-11-05 01:00:00.000 INFO  host   第一条`r`n2026-11-05 01:00:01.000 ERROR host:gateway   第二条`r`n", $utf8)
$first = @(Read-NewLines -File $file)
Assert-Equal $first.Count 2 'first batch count'
Assert-Equal $first[0] '2026-11-05 01:00:00.000 INFO  host   第一条' 'first line'
Assert-Equal $first[1] '2026-11-05 01:00:01.000 ERROR host:gateway   第二条' 'second line'
Assert-Equal @(Read-NewLines -File $file).Count 0 'nothing new'

[IO.File]::AppendAllText($file, "2026-11-05 01:00:02.000 WARN  host   第三条`r`n", $utf8)
$second = @(Read-NewLines -File $file)
Assert-Equal $second.Count 1 'incremental count'
Assert-Equal $second[0] '2026-11-05 01:00:02.000 WARN  host   第三条' 'incremental line'

[IO.File]::AppendAllText($file, "partial", $utf8)
Assert-Equal @(Read-NewLines -File $file).Count 0 'partial line waits'
[IO.File]::AppendAllText($file, " line`r`n", $utf8)
$third = @(Read-NewLines -File $file)
Assert-Equal $third.Count 1 'partial line completes'
Assert-Equal $third[0] 'partial line' 'partial content'

[IO.File]::WriteAllText($file, "2026-11-05 01:00:03.000 INFO  host   reset`r`n", $utf8)
Assert-Equal @(Read-NewLines -File $file).Count 1 'truncated file restarts'

Assert-Equal @(Read-NewLines -File (Join-Path $dir 'missing.log')).Count 0 'missing file'

Skip-Existing -File $file
Assert-Equal @(Read-NewLines -File $file).Count 0 'skip existing content'

Write-ErpLine '2026-11-05 01:00:04.000 ERROR host   红色错误'
Write-ErpLine 'raw text without level'

Remove-Item -LiteralPath $dir -Recurse -Force
Write-Output ("console-logs ok: ps " + $PSVersionTable.PSVersion)
