param([Parameter(Mandatory=$true)][string]$PrivateBackup,[string]$VerifiedInstallReport,[switch]$Preview)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Get-CheckedPath([string]$Value,[switch]$AllowMissing){
 if([string]::IsNullOrWhiteSpace($Value)){throw '缺少明确路径'}
 $full=[IO.Path]::GetFullPath($Value)
 if(!$AllowMissing -and !(Test-Path -LiteralPath $full)){throw '需要核对的路径不存在'}
 $walk=$full
 while($walk){
  if(Test-Path -LiteralPath $walk){$item=Get-Item -LiteralPath $walk -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw '路径包含链接或重定向，请核对物理位置'}}
  $parent=[IO.Path]::GetDirectoryName($walk);if($parent -eq $walk){break};$walk=$parent
 }
 return $full
}
function Test-SamePath([string]$A,[string]$B){return [IO.Path]::GetFullPath($A).Equals([IO.Path]::GetFullPath($B),[StringComparison]::OrdinalIgnoreCase)}
function Test-Inside([string]$Base,[string]$Value){return [IO.Path]::GetFullPath($Value).StartsWith(([IO.Path]::GetFullPath($Base).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)}
function Get-Digest([string]$File){$stream=[IO.File]::OpenRead((Get-CheckedPath $File));$sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','')}finally{$sha.Dispose();$stream.Dispose()}}
function Get-BytesDigest([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','')}finally{$sha.Dispose()}}
$workspace=Get-CheckedPath (Join-Path $PSScriptRoot '..')
$backupRoot=Get-CheckedPath $PrivateBackup
if((Test-SamePath $workspace $backupRoot) -or (Test-Inside $workspace $backupRoot)){throw '私有备份必须位于工程外'}
$installedExe=Get-CheckedPath (Join-Path $env:LOCALAPPDATA 'Programs\wucheng-ecommerce-erp-v2\云仓库存同步.exe')
if(!$Preview){
 if(!$VerifiedInstallReport){throw '接管快捷方式需要已验证安装报告'}
 $report=Get-Content -LiteralPath (Get-CheckedPath $VerifiedInstallReport) -Raw -Encoding UTF8 | ConvertFrom-Json
 if($report.version -ne '0.11.0' -or $report.ok -ne $true -or $report.dataVerified -ne $true -or $report.installedHashesMatch -ne $true){throw '完整安装与数据核对尚未通过'}
}
$sourceManifest=Get-Content -LiteralPath (Get-CheckedPath (Join-Path $backupRoot 'source-manifest.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
$documents=Join-Path $env:USERPROFILE 'Documents\ChatGPT'
$expected=@{purchase=(Join-Path $documents '采购');sales=(Join-Path $documents '销售台');overview=(Join-Path $documents '采购\采购台和销售额台聚合');exporter=(Join-Path $documents '复刻买家历史订单导出软件')}
$sourceRoots=@{}
foreach($module in @('purchase','sales','overview','exporter')){
 $sourceRoots[$module]=Get-CheckedPath $sourceManifest.roots.$module
 if(!(Test-SamePath $sourceRoots[$module] $expected[$module])){throw '旧源码根不在本次明确接管的工作区'}
}
$orderedModules=@($sourceRoots.Keys | Sort-Object { $sourceRoots[$_].Length } -Descending)
$folder=Get-CheckedPath (Join-Path $backupRoot 'shortcut-adoption') -AllowMissing
$journalFile=Join-Path $folder 'journal.json'
$entries=New-Object 'Collections.Generic.List[object]'
if(Test-Path -LiteralPath $journalFile){
 $savedJournal=Get-Content -LiteralPath (Get-CheckedPath $journalFile) -Raw -Encoding UTF8 | ConvertFrom-Json
 if($savedJournal.schemaVersion -ne 1){throw '快捷方式备份记录版本需要核对'}
 foreach($entry in $savedJournal.entries){
  $entry.backup=Get-CheckedPath $entry.backup
  if(!(Test-Inside $folder $entry.backup) -or (Get-Digest $entry.backup) -ne $entry.originalSha256){throw '快捷方式原始备份摘要不符'}
  [void]$entries.Add($entry)
 }
}
function Save-Journal {
 if($Preview){return}
 New-Item -ItemType Directory -Path $folder -Force | Out-Null
 [void](Get-CheckedPath $folder)
 $temporary=Join-Path $folder ('journal.'+[guid]::NewGuid().ToString()+'.tmp')
 @{schemaVersion=1;entries=@($entries.ToArray())}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $temporary -Encoding UTF8
 Move-Item -LiteralPath $temporary -Destination $journalFile -Force
}
function Get-OriginalBackup([string]$File,[string]$Module,[string]$Kind){
 $filePath=Get-CheckedPath $File
 $entry=@($entries.ToArray() | Where-Object { Test-SamePath $_.path $filePath }) | Select-Object -First 1
 if($entry){
  if($entry.module -ne $Module -or $entry.kind -ne $Kind -or (Get-Digest $entry.backup) -ne $entry.originalSha256){throw '快捷方式原始备份记录不匹配'}
  return $entry
 }
 New-Item -ItemType Directory -Path $folder -Force | Out-Null
 [void](Get-CheckedPath $folder)
 $digest=Get-Digest $filePath
 $backup=Join-Path $folder (([guid]::NewGuid().ToString())+[IO.Path]::GetExtension($filePath))
 [IO.File]::Copy($filePath,$backup,$false)
 if((Get-Digest $backup) -ne $digest -or (Get-Digest $filePath) -ne $digest){throw '原始入口备份核对失败，未修改入口'}
 $entry=[pscustomobject]@{kind=$Kind;module=$Module;path=$filePath;backup=$backup;originalSha256=$digest;adoptedSha256='';status='backed-up'}
 [void]$entries.Add($entry);Save-Journal
 return $entry
}
function Complete-Adoption($Entry){
 if((Get-Digest $Entry.backup) -ne $Entry.originalSha256){throw '采用后原始备份需要核对'}
 $Entry.adoptedSha256=Get-Digest $Entry.path;$Entry.status='updated';Save-Journal
}
function Find-SourceModule([string]$Target,[string]$Arguments){
 $targetText=$Target.Replace('/','\');$argumentsText=$Arguments.Replace('/','\')
 foreach($id in $orderedModules){$prefix=$sourceRoots[$id].TrimEnd('\')+'\';if($targetText.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $argumentsText.IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $id}}
 $oldExporter=Join-Path $env:LOCALAPPDATA 'Programs\lingtu-order-export\'
 if($targetText.StartsWith($oldExporter,[StringComparison]::OrdinalIgnoreCase)){return 'exporter'}
 return $null
}
$shell=New-Object -ComObject WScript.Shell
$places=@([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
$result=@()
foreach($place in $places){
 if(!(Test-Path -LiteralPath $place)){continue};[void](Get-CheckedPath $place)
 foreach($file in Get-ChildItem -LiteralPath $place -Filter '*.lnk' -File -Recurse){
  [void](Get-CheckedPath $file.FullName)
  $link=$shell.CreateShortcut($file.FullName);$module=Find-SourceModule $link.TargetPath $link.Arguments
  $previous=@($entries.ToArray() | Where-Object { Test-SamePath $_.path $file.FullName }) | Select-Object -First 1
  if(!$module -and $previous){$module=$previous.module}
  if(!$module){continue};if(!$sourceRoots.ContainsKey($module)){throw '快捷方式所属模块未登记'}
  $desiredArguments='--open-module='+$module
  $adopted=(Test-SamePath $link.TargetPath $installedExe) -and $link.Arguments -eq $desiredArguments -and (Test-SamePath $link.WorkingDirectory (Split-Path -LiteralPath $installedExe))
  if(!$Preview){
   $entry=Get-OriginalBackup $file.FullName $module 'shortcut'
   if((Get-Digest $file.FullName) -ne $entry.originalSha256 -and !$adopted){throw '入口在上次接管后已有人工修改，已保留'}
   if(!$adopted){$link.TargetPath=$installedExe;$link.Arguments=$desiredArguments;$link.WorkingDirectory=Split-Path -LiteralPath $installedExe;$link.IconLocation=$installedExe;$link.Save()}
   $check=$shell.CreateShortcut($file.FullName)
   if(!(Test-SamePath $check.TargetPath $installedExe) -or $check.Arguments -ne $desiredArguments){throw '快捷方式回读不一致'}
   Complete-Adoption $entry
  }
  $result+=@{kind='shortcut';module=$module;path=$file.FullName;changed=(!$Preview -and !$adopted);alreadyAdopted=$adopted}
 }
}
$wrappers=@{purchase=@('启动采购台.cmd','启动灵兔采购台.cmd','重启采购台.cmd','重启灵兔采购台.cmd');sales=@('启动销售台.bat','启动销售台.cmd');overview=@('启动灵兔经营收支总览.cmd')}
foreach($id in $wrappers.Keys){foreach($name in $wrappers[$id]){
 $file=Join-Path $sourceRoots[$id] $name;if(!(Test-Path -LiteralPath $file)){continue};[void](Get-CheckedPath $file)
 if(!(Test-Inside $sourceRoots[$id] $file)){throw '旧入口越界'}
 $content='@echo off'+"`r`n"+'start "" "'+$installedExe+'" --open-module='+$id+"`r`n"
 $bytes=[Text.Encoding]::GetEncoding(936).GetBytes($content);$desiredDigest=Get-BytesDigest $bytes;$adopted=(Get-Digest $file) -eq $desiredDigest
 if(!$Preview){
  $entry=Get-OriginalBackup $file $id 'source-entry'
  if((Get-Digest $file) -ne $entry.originalSha256 -and !$adopted){throw '入口在上次接管后已有人工修改，已保留'}
  if(!$adopted){[IO.File]::WriteAllBytes($file,$bytes)}
  if((Get-Digest $file) -ne $desiredDigest){throw '旧入口回读不一致'}
  Complete-Adoption $entry
 }
 $result+=@{kind='source-entry';module=$id;path=$file;changed=(!$Preview -and !$adopted);alreadyAdopted=$adopted}
}}
if(!$Preview){$result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $backupRoot 'shortcut-adoption.json') -Encoding UTF8}
@{ok=$true;preview=[bool]$Preview;entries=$result.Count;items=$result}|ConvertTo-Json -Depth 5 -Compress