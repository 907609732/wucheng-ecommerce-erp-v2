import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {externalArchive,physicalPath,hashFile,archiveVerified,verifyDeletionTarget,verifySourceReplacement,refersToScope,managedProgramProtection} from '../scripts/lib/workbench-file-safety.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-cleanup-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=name=>{const value=path.join(root,name);fs.mkdirSync(value,{recursive:true});return value;};return {root,dir};}

test('archive refuses project equality, descendants and redirected parents',t=>{
  const f=fixture(t),project=f.dir('project'),outside=f.dir('outside');
  assert.throws(()=>externalArchive(project,project),/工程外/);
  assert.throws(()=>externalArchive(project,f.root),/工程外/);
  assert.throws(()=>externalArchive(project,path.join(project,'archive')),/工程外/);
  assert.equal(externalArchive(project,path.join(outside,'new-archive')),path.join(outside,'new-archive'));
  const alias=path.join(f.root,'alias');fs.symlinkSync(outside,alias,'junction');
  assert.throws(()=>physicalPath(path.join(alias,'new-archive'),{allowMissing:true}),/链接|重定向/);
});

test('deletion preflight refuses root, live data descendants and any nested junction',t=>{
  const f=fixture(t),base=f.dir('allowed'),data=f.dir('allowed/data'),cache=f.dir('allowed/cache'),other=f.dir('outside');
  fs.writeFileSync(path.join(data,'ledger.sqlite'),'private-fixture');
  assert.throws(()=>verifyDeletionTarget(base,{base}),/根/);
  assert.throws(()=>verifyDeletionTarget(path.join(data,'ledger.sqlite'),{base,protectedTrees:[data]}),/受保护/);
  assert.equal(verifyDeletionTarget(cache,{base,protectedTrees:[data]}),cache);
  fs.symlinkSync(other,path.join(cache,'redirect'),'junction');
  assert.throws(()=>verifyDeletionTarget(cache,{base}),/链接/);
  assert.equal(fs.readFileSync(path.join(data,'ledger.sqlite'),'utf8'),'private-fixture');
});

test('source retirement requires contained replacement plus original backup with exact hash',t=>{
  const f=fixture(t),sourceRoot=f.dir('source'),replacementRoot=f.dir('apps/purchase'),backupRoot=f.dir('backup/sources/purchase');
  const source=path.join(sourceRoot,'file.mjs'),replacement=path.join(replacementRoot,'file.mjs'),backup=path.join(backupRoot,'file.mjs');
  fs.writeFileSync(source,'original');fs.writeFileSync(replacement,'new implementation');fs.writeFileSync(backup,'original');
  const value={source,sourceRoot,replacement,replacementRoot,backup,backupRoot,sha256:hashFile(source)};
  verifySourceReplacement(value);
  fs.writeFileSync(backup,'changed');assert.throws(()=>verifySourceReplacement(value),/摘要/);
  fs.writeFileSync(backup,'original');
  const outside=f.dir('external'),link=path.join(sourceRoot,'link');fs.writeFileSync(path.join(outside,'file.mjs'),'original');fs.symlinkSync(outside,link,'junction');
  assert.throws(()=>verifySourceReplacement({...value,source:path.join(link,'file.mjs')}),/链接|重定向/);
  assert.equal(fs.existsSync(source),true);
});

test('archives are digest-checked, retry-safe and cannot overwrite a different backup',t=>{
  const f=fixture(t),source=f.dir('source'),backup=f.dir('archive');fs.writeFileSync(path.join(source,'original.xlsx'),'synthetic original bytes');
  const files=archiveVerified(source,backup);assert.equal(files.length,1);
  archiveVerified(source,backup);
  fs.writeFileSync(path.join(backup,'original.xlsx'),'different backup');
  assert.throws(()=>archiveVerified(source,backup),/不同内容/);
  assert.equal(fs.readFileSync(path.join(source,'original.xlsx'),'utf8'),'synthetic original bytes');
});

test('running references include exact executables and Node/Electron/Go paths regardless of process name',()=>{
  const root=path.resolve('fixture-running-program');
  assert.equal(refersToScope({ExecutablePath:path.join(root,'lingtu-tailnet.exe')},root),true);
  assert.equal(refersToScope({ExecutablePath:path.join(root,'electron.exe')},path.join(root,'electron.exe')),true);
  assert.equal(refersToScope({CommandLine:'node "'+path.join(root,'server.mjs')+'"'},root),true);
  assert.equal(refersToScope({CommandLine:'node "'+path.resolve('unrelated','server.mjs')+'"'},root),false);
});

test('only an exact retired managed program may ignore the broad authentication parent',t=>{
  const f=fixture(t),profile=f.dir('profile'),store=f.dir('profile/modules/packages'),target=f.dir('profile/modules/packages/purchase/1.6.1-11111111-1111-4111-8111-111111111111');
  const options={kind:'retired-managed-program',profile,authRoots:[profile],protectedTrees:[profile],dataRoots:[],programRoots:[],currentRoots:[]};
  const check=(candidate,extra={})=>verifyDeletionTarget(candidate,{base:store,protectedRoots:[profile],protectedTrees:managedProgramProtection(candidate,{...options,...extra})});
  assert.equal(check(target),target);
  for(const extra of [{kind:'retired-source-cache'},{activeReference:true},{currentRoots:[target]},{dataRoots:[profile]},{programRoots:[profile]},{authRoots:[]},{protectedTrees:[profile,target],authRoots:[profile,target]}])assert.throws(()=>check(target,extra),/受保护/);
  const formalData=f.dir('profile/modules/packages/purchase/1.6.1-11111111-1111-4111-8111-111111111111/business-data');
  assert.throws(()=>check(target,{dataRoots:[formalData],protectedTrees:[profile,formalData]}),/受保护/);
  assert.throws(()=>check(target,{programRoots:[target],protectedTrees:[profile,target]}),/受保护/);
  for(const name of ['Cookies','Partitions','Network','LocalState','keys','tailnet','workbench-server']){
    const candidate=f.dir('profile/'+name);
    assert.throws(()=>verifyDeletionTarget(candidate,{base:profile,protectedRoots:[profile],protectedTrees:managedProgramProtection(candidate,options)}),/受保护/);
  }
  const deeper=f.dir('profile/modules/packages/purchase/1.6.1-11111111-1111-4111-8111-111111111111/nested');assert.throws(()=>check(deeper),/受保护/);
  const outside=f.dir('outside'),link=path.join(target,'linked');fs.symlinkSync(outside,link,'junction');assert.throws(()=>check(target),/链接/);
});

test('shortcut helper chooses nested module first and preserves one-time backups across retries',{skip:process.platform!=='win32',timeout:20000},t=>{
  const f=fixture(t);
  const code=String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:WORKBENCH_SHORTCUT_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'script syntax failed'}
foreach($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $function.Extent.Text}
$fixture=$env:WORKBENCH_TEST_ROOT
$purchase=Join-Path $fixture 'purchase';$overview=Join-Path $purchase 'overview';New-Item -ItemType Directory -Force -Path $overview|Out-Null
$sourceRoots=@{purchase=$purchase;overview=$overview};$orderedModules=@($sourceRoots.Keys|Sort-Object {$sourceRoots[$_].Length} -Descending)
if((Find-SourceModule (Join-Path $overview 'start.cmd') '') -ne 'overview'){throw 'nested module misrouted'}
$Preview=$false;$folder=Join-Path $fixture 'backup';$journalFile=Join-Path $folder 'journal.json';$entries=New-Object 'Collections.Generic.List[object]'
$source=Join-Path $purchase 'start.cmd';[IO.File]::WriteAllText($source,'original fixture')
$entry=Get-OriginalBackup $source 'purchase' 'source-entry';$originalBackup=$entry.backup
if((Get-Content -LiteralPath $originalBackup -Raw) -ne 'original fixture'){throw 'original bytes missing'}
[IO.File]::WriteAllText($source,'adopted fixture');Complete-Adoption $entry
$retry=Get-OriginalBackup $source 'purchase' 'source-entry'
if($retry.backup -ne $originalBackup -or (Get-Content -LiteralPath $originalBackup -Raw) -ne 'original fixture'){throw 'retry overwrote original backup'}
$journal=Get-Content -LiteralPath $journalFile -Raw|ConvertFrom-Json
if(@($journal.entries).Count -ne 1 -or $journal.entries[0].path -ne $source -or $journal.entries[0].backup -ne $originalBackup){throw 'journal mapping lost'}
$shell=New-Object -ComObject WScript.Shell;$linkFile=Join-Path $fixture 'synthetic.lnk';$link=$shell.CreateShortcut($linkFile);$link.TargetPath=Join-Path $fixture 'old.exe';$link.Save()
$linkBackup=Get-OriginalBackup $linkFile 'purchase' 'shortcut'
if((Get-Digest $linkBackup.backup) -ne $linkBackup.originalSha256){throw 'link backup digest failed'}
$external=Join-Path $fixture 'outside';New-Item -ItemType Directory -Path $external|Out-Null
[IO.File]::WriteAllText((Join-Path $external 'keep.txt'),'keep')
New-Item -ItemType Junction -Path (Join-Path $fixture 'redirect') -Target $external|Out-Null
$rejected=$false;try{Get-CheckedPath (Join-Path $fixture 'redirect\keep.txt')|Out-Null}catch{$rejected=$true}
if(!$rejected){throw 'redirected source accepted'}
@{ok=$true;backupRetained=$true;nestedModuleCorrect=$true;journalMapping=$true;syntheticLinkBackup=$true;redirectRejected=$true}|ConvertTo-Json -Compress
`;
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,env:{...process.env,WORKBENCH_TEST_ROOT:f.root,WORKBENCH_SHORTCUT_SCRIPT:path.resolve('scripts/adopt-workbench-shortcuts.ps1')}});
  assert.equal(JSON.parse(result.trim()).ok,true);
});
