$ErrorActionPreference='Stop'
$report=@{ok=$false;scope='fresh Windows Sandbox, network disabled';checks=@();upgradeTested=$false}
try{
  if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'This bootstrap must run only in Windows Sandbox.'}
  $spec=Get-Content C:\Kit\candidate.json -Raw | ConvertFrom-Json
  $installer=Join-Path 'C:\Input' $spec.file
  if((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.sha256){throw 'Installer digest mismatch'}
  $report.installerSha256=$spec.sha256
  $process=Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if($process.ExitCode -ne 0){throw ('Installer exit '+$process.ExitCode)}
  $exe=Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs') -Filter WuchengAgentPreview.exe -File -Recurse | Select-Object -First 1 -ExpandProperty FullName
  if(!$exe){throw 'Fresh installed executable was not found'}
  $runtime=Join-Path ([IO.Path]::GetDirectoryName($exe)) 'resources/agent-runtime'
  foreach($relative in @('core','desktop/renderer','desktop/main.mjs','apps/warehouse','vendor','node_modules/playwright','node_modules/playwright-core','node_modules/echarts','node_modules/gridjs','node_modules/xlsx','node_modules/dingtalk-stream')){
    if(Test-Path -LiteralPath (Join-Path $runtime $relative)){throw ('Base installer contains optional warehouse payload: '+$relative)}
  }
  $report.checks+= 'silent NSIS clean install at the actual default path'
  $report.checks+= 'installed base excludes cloud source, browser and exclusive dependencies'
  $probe=Start-Process -FilePath $exe -ArgumentList '--cli','status' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput C:\Results\cli.stdout.log -RedirectStandardError C:\Results\cli.stderr.log
  if($probe.ExitCode -ne 0){throw ('Installed base CLI exit '+$probe.ExitCode)}
  $downloads=Join-Path $env:LOCALAPPDATA 'WuchengAgentBeta-preview/downloads'
  $archives=@(Get-ChildItem -LiteralPath $downloads -Filter '*.part' -File -Recurse -ErrorAction SilentlyContinue)
  if($archives.Count){throw 'Base status unexpectedly downloaded components'}
  $report.checks+='installed host starts offline without downloading cloud'
  $report.exe=$exe;$report.ok=$true
}catch{$report.error=($_ | Out-String)}
$report | ConvertTo-Json -Depth 8 | Set-Content C:\Results\result.json -Encoding UTF8
if($env:USERNAME -eq 'WDAGUtilityAccount'){& "$env:WINDIR\System32\shutdown.exe" /s /t 0}
