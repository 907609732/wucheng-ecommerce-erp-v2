import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {inside} from './common.mjs';

/** Only call on an owned, unactivated backup/recovery candidate, never a live source. */
export function sealBackupDatabase(file){
  const db=new DatabaseSync(file);
  try{
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(checkpoint?.busy)throw Error('备份候选库仍被占用，不能封存');
    const mode=db.prepare('PRAGMA journal_mode=DELETE').get();
    if(String(mode.journal_mode).toLowerCase()!=='delete')throw Error('备份候选库日志模式未收敛');
  }finally{db.close();}
  for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(file+suffix))throw Error('备份候选库仍有日志文件，未生成完成清单');
}

/** Reading a WAL-mode database may create SHM even with readOnly:true. Inspect a copy. */
export function readBackupDatabase(file,read){
  const temporaryRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryRoot,'erp-backup-inspect-')),copy=path.join(directory,'snapshot.sqlite');
  let db;
  try{fs.copyFileSync(file,copy,fs.constants.COPYFILE_EXCL);db=new DatabaseSync(copy,{readOnly:true});return read(db);}
  finally{
    db?.close();
    const resolved=fs.realpathSync(directory);if(!inside(temporaryRoot,resolved))throw Error('备份核验临时目录不在预期范围');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
