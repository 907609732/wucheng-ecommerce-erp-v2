param([Parameter(Mandatory=$true)][string]$StateFile,[Parameter(Mandatory=$true)][string]$OutputStem)
$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'Book acceptance probe is restricted to Windows Sandbox'}
$state=Get-Content -LiteralPath $StateFile -Raw -Encoding utf8 | ConvertFrom-Json
$probe=New-Object System.Diagnostics.Process
$probe.StartInfo.FileName=$state.node
$probe.StartInfo.Arguments='"C:\WorkbenchAcceptanceResumeCheck.mjs" "'+$StateFile+'"'
$probe.StartInfo.UseShellExecute=$false
$probe.StartInfo.CreateNoWindow=$true
$probe.StartInfo.RedirectStandardOutput=$true
$probe.StartInfo.RedirectStandardError=$true
try {
  if(!$probe.Start()){throw 'Could not start the bundled Node book probe'}
  $probeId=$probe.Id
  $stdout=$probe.StandardOutput.ReadToEndAsync()
  $stderr=$probe.StandardError.ReadToEndAsync()
  $finished=$probe.WaitForExit(60000)
  if(!$finished){$probe.Kill();$probe.WaitForExit()}
  $exitCode=$probe.ExitCode
  [IO.File]::WriteAllText(($OutputStem+'.stdout.json'),$stdout.GetAwaiter().GetResult(),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText(($OutputStem+'.stderr.log'),$stderr.GetAwaiter().GetResult(),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText(($OutputStem+'.process.json'),(@{pid=$probeId;finished=$finished;hasExited=$probe.HasExited;exitCode=$exitCode;node=$state.node} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  if(!$finished -or $exitCode -ne 0){throw 'Bundled Node book probe failed; inspect the persisted process/stdout/stderr files'}
  $check=Get-Content -LiteralPath ($OutputStem+'.stdout.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if(!$check.ok){throw 'Book probe did not report success'}
  return $check
} finally {$probe.Dispose()}
