# Console helpers shared with dev-console.ps1. ASCII only so Windows PowerShell
# 5.1 can read this file without an encoding surprise.

$script:ErpLogOffsets = @{}

# Return only complete new lines since the previous call for this file.
function Read-NewLines {
    param([string]$File)
    if (-not (Test-Path -LiteralPath $File)) { return @() }
    $length = (Get-Item -LiteralPath $File).Length
    $offset = 0
    if ($script:ErpLogOffsets.ContainsKey($File)) { $offset = [long]$script:ErpLogOffsets[$File] }
    if ($length -lt $offset) { $offset = 0 }
    if ($length -eq $offset) { return @() }
    $stream = [System.IO.File]::Open($File, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] ($length - $offset)
        $read = $stream.Read($buffer, 0, $buffer.Length)
    } finally { $stream.Dispose() }
    if ($read -le 0) { return @() }
    $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    $lastBreak = $text.LastIndexOf("`n")
    if ($lastBreak -lt 0) { return @() }
    $complete = $text.Substring(0, $lastBreak)
    if ($complete.EndsWith("`r")) { $complete = $complete.Substring(0, $complete.Length - 1) }
    $script:ErpLogOffsets[$File] = $offset + [System.Text.Encoding]::UTF8.GetByteCount($text.Substring(0, $lastBreak + 1))
    return @($complete -split "`r?`n")
}

# Skip whatever is already in the file, e.g. when reusing a running service.
function Skip-Existing {
    param([string]$File)
    if (Test-Path -LiteralPath $File) {
        $script:ErpLogOffsets[$File] = [long](Get-Item -LiteralPath $File).Length
    }
}

# Paint by level so that errors stand out in the console window.
function Write-ErpLine {
    param([string]$Line)
    $Line = $Line.TrimEnd("`r")
    if ($Line -match '\sERROR\s') { Write-Host $Line -ForegroundColor Red; return }
    if ($Line -match '\sWARN\s') { Write-Host $Line -ForegroundColor Yellow; return }
    if ($Line -match '\sINFO\s') { Write-Host $Line -ForegroundColor Gray; return }
    Write-Host $Line -ForegroundColor DarkGray
}
