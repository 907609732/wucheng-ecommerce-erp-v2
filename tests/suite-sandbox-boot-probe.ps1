param([Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'Boot acceptance probe is restricted to Windows Sandbox'}
# RegistryOptions.Volatile is a Microsoft BCL primitive. This machine key is
# kept in memory and disappears on an actual guest restart, independently of
# WMI's availability inside the minimal Sandbox image. Never run on the host.
$keyName='SOFTWARE\LingtuSuiteAcceptanceBoot'
$token=[Guid]::NewGuid().ToString()
$key=[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($keyName,[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Microsoft.Win32.RegistryOptions]::Volatile)
try{$key.SetValue('Token',$token,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}
$bootTime=$null;$bootError=$null
try{$bootTime=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')}catch{$bootError=($_ | Out-String)}
$evidence=[ordered]@{volatileKey=$keyName;token=$token;beforeBootTime=$bootTime;wmiError=$bootError;createdAt=[DateTime]::UtcNow.ToString('o');tickCount=[Environment]::TickCount}
[IO.File]::WriteAllText($OutputFile,($evidence | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
