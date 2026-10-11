import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseBusinessWorkbook, selectBusinessData, exportBusinessWorkbook } from './business-workbook.mjs';
import { createSheetSnapshot, applySheetChanges, exportSheetSnapshot } from './business-sheet.mjs';
import { collectDingTalk, scalar, columnName, recordMonth, projectDingTalk } from './business-dingtalk.mjs';

export class BusinessStore {
  constructor(databasePath, directory) {
    this.directory = directory;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(databasePath, { timeout: 10000 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS business_versions (id TEXT PRIMARY KEY, year INTEGER NOT NULL,
        file_hash TEXT NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
        data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_active (year INTEGER PRIMARY KEY, version_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_assets (id TEXT PRIMARY KEY, extension TEXT NOT NULL, content BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS business_versions_year ON business_versions(year);
      CREATE TABLE IF NOT EXISTS business_edits (version_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, changes_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_dingtalk_assets (resource_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  versions() {
    return this.db.prepare(`SELECT v.id, v.year, v.filename, v.created_at AS createdAt,
      CASE WHEN a.version_id = v.id THEN 1 ELSE 0 END AS active
      FROM business_versions v LEFT JOIN business_active a ON a.year = v.year
      WHERE v.status = 'committed' ORDER BY v.created_at DESC`).all().map(r => ({ ...r }));
  }
  read(filters = {}) {
    const years = this.db.prepare('SELECT year FROM business_active ORDER BY year DESC').all().map(r => r.year);
    const year = Number(filters.year || years[0]);
    const row = this.db.prepare(`SELECT v.* FROM business_versions v JOIN business_active a ON a.version_id=v.id WHERE a.year=?`).get(year);
    if (!row) return { available: false, years, monthly: [], finance: [], purchases: [], labor: [], images: [], notices: [], reconciliation: [], summary: {} };
    return { ...selectBusinessData(JSON.parse(row.data_json), filters), available: true, years, versionId: row.id, filename: row.filename, createdAt: row.created_at };
  }
  preview(filePath) {
    const parsed = parseBusinessWorkbook(filePath), { data, assets, buffer } = parsed;
    const existing = this.db.prepare("SELECT id FROM business_versions WHERE year=? AND file_hash=? AND status='committed'").get(data.year, data.hash);
    if (existing) return { duplicate: true, existingVersionId: existing.id, year: data.year, message: '相同文件已导入；如需切换，请在历史版本中恢复。' };
    const current = this.read({ year: data.year });
    const diff = {};
    for (const key of ['monthly', 'finance', 'purchases', 'labor']) {
      const stable = r => JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k => [k, r[k] ?? null])));
      const before = new Map((current[key] || []).map(r => [r.id, stable(r)]));
      diff[key] = { before: before.size, after: data[key].length, added: data[key].filter(r => !before.has(r.id)).length,
        changed: data[key].filter(r => before.has(r.id) && before.get(r.id) !== stable(r)).length,
        removed: [...before.keys()].filter(id => !data[key].some(r => r.id === id)).length };
    }
    const id = randomUUID(), source = path.join(this.directory, `${id}.xlsx`);
    fs.writeFileSync(source, buffer, { flag: 'wx' });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO business_versions VALUES (?,?,?,?,?,?,?)').run(id, data.year, data.hash, path.basename(filePath), new Date().toISOString(), 'pending', JSON.stringify(data));
      const insert = this.db.prepare('INSERT OR IGNORE INTO business_assets VALUES (?,?,?)');
      for (const a of assets) insert.run(a.id, a.extension, a.data);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); fs.rmSync(source, { force: true }); throw error; }
    const view = selectBusinessData(data);
    return { token: id, year: data.year, replacing: current.available, previousVersionId: current.versionId || null, diff,
      imageCount: data.images.length, uniqueImages: new Set(data.images.map(r => r.assetId)).size,
      summary: view.summary, issues: view.notices, reconciliation: view.reconciliation };
  }
  commit(token, expectedVersionId = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT * FROM business_versions WHERE id=? AND status='pending'").get(String(token));
      if (!row) throw new Error('预览已失效，请重新选择文件');
      const current = this.db.prepare('SELECT version_id FROM business_active WHERE year=?').get(row.year)?.version_id || null;
      if (current !== expectedVersionId) throw new Error('年度数据已被更新，请重新预览');
      this.db.prepare("UPDATE business_versions SET status='committed' WHERE id=?").run(row.id);
      this.db.prepare('INSERT INTO business_active VALUES (?,?) ON CONFLICT(year) DO UPDATE SET version_id=excluded.version_id').run(row.year, row.id);
      this.db.exec('COMMIT');
      return { year: row.year, versionId: row.id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cancel(token) {
    const row = this.db.prepare("SELECT id FROM business_versions WHERE id=? AND status='pending'").get(String(token));
    if (!row) return;
    this.db.prepare('DELETE FROM business_versions WHERE id=?').run(row.id);
    fs.rmSync(path.join(this.directory, `${row.id}.xlsx`), { force: true });
  }
  restore(id) {
    const row = this.db.prepare("SELECT year,id FROM business_versions WHERE id=? AND status='committed'").get(String(id));
    if (!row) throw new Error('历史版本不存在');
    this.db.prepare('INSERT INTO business_active VALUES (?,?) ON CONFLICT(year) DO UPDATE SET version_id=excluded.version_id').run(row.year, row.id);
    return { year: row.year, versionId: row.id };
  }
  async sheetSnapshot(year) {
    const view = this.read({ year });
    if (!view.available) return { available: false, sheets: [] };
    const row = this.db.prepare('SELECT data_json FROM business_versions WHERE id=?').get(view.versionId);
    const data = JSON.parse(row.data_json);
    if (data.dingtalkTables) return { ...dingTalkSnapshot(data), available: true, versionId: view.versionId, filename: view.filename };
    const assets = [...new Set(data.images.map(i => i.assetId))].map(id => this.asset(id));
    const snapshot = await createSheetSnapshot(data, this.original(view.versionId).data, assets);
    return { ...snapshot, available: true, versionId: view.versionId, filename: view.filename };
  }
  async exportSheets(year) {
    const snapshot = await this.sheetSnapshot(year);
    if (!snapshot.available) throw new Error('尚未导入经营数据');
    const ids = [...new Set(snapshot.sheets.flatMap(s => s.images).map(i => i.assetId))];
    return exportSheetSnapshot(snapshot, ids.map(id => this.asset(id)));
  }
  async saveCells(payload) {
    const before = await this.sheetSnapshot(payload?.year);
    if (before.cloud) throw new Error('请在钉钉修改数据，再点击同步钉钉；Excel 来源仍可在软件中编辑');
    if (!before.available || before.versionId !== payload?.versionId) throw new Error('数据版本已变化，请重新读取后修改');
    const next = applySheetChanges(before, payload.changes);
    const ids = [...new Set(next.sheets.flatMap(s => s.images).map(i => i.assetId))];
    const buffer = await exportSheetSnapshot(next, ids.map(id => this.asset(id)));
    const parsed = parseBusinessWorkbook(buffer);
    if (parsed.data.year !== before.year) throw new Error('不能通过单元格编辑更改整个年度，请导入新的年度文件');
    if (parsed.data.images.length !== before.sheets.reduce((n, s) => n + s.images.length, 0)) throw new Error('凭证图片数量不一致，未保存修改');
    const id = randomUUID(), filename = before.filename.replace(/(?:（编辑版）)?\.xlsx$/i, '（编辑版）.xlsx');
    const file = path.join(this.directory, `${id}.xlsx`);
    fs.writeFileSync(file, buffer, { flag: 'wx' });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const active = this.db.prepare('SELECT version_id FROM business_active WHERE year=?').get(before.year)?.version_id;
      if (active !== before.versionId) throw new Error('数据版本已变化，请重新读取后修改');
      this.db.prepare('INSERT INTO business_versions VALUES (?,?,?,?,?,?,?)').run(id, before.year, parsed.data.hash, filename, new Date().toISOString(), 'committed', JSON.stringify(parsed.data));
      this.db.prepare('INSERT INTO business_edits VALUES (?,?,?)').run(id, before.versionId, JSON.stringify(next.changes));
      this.db.prepare('UPDATE business_active SET version_id=? WHERE year=?').run(id, before.year);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); fs.rmSync(file, { force: true }); throw error; }
    return { year: before.year, versionId: id, edited: next.changes.length, recalculated: next.recalculated.length };
  }
  asset(id) {
    if (!/^[a-f0-9]{64}$/.test(String(id))) throw new Error('图片编号无效');
    const a = this.db.prepare('SELECT extension,content FROM business_assets WHERE id=?').get(id);
    if (!a) throw new Error('图片不存在');
    return { id, extension: a.extension, data: Buffer.from(a.content) };
  }
  original(versionId) {
    const row = this.db.prepare("SELECT filename FROM business_versions WHERE id=? AND status='committed'").get(String(versionId));
    if (!row) throw new Error('原文件不存在');
    return { filename: row.filename, data: fs.readFileSync(path.join(this.directory, `${versionId}.xlsx`)) };
  }
  async export(filters) {
    const data = this.read(filters);
    if (!data.available) throw new Error('尚未导入经营数据');
    if (data.dingtalkTables) {
      const snapshot = dingTalkSnapshot(data, filters?.month);
      return exportSheetSnapshot(snapshot, [...new Set(snapshot.sheets.flatMap(s=>s.images).map(i=>i.assetId))].map(id=>this.asset(id)));
    }
    const assets = [...new Set(data.images.map(r => r.assetId))].map(id => this.asset(id));
    return exportBusinessWorkbook(data, assets);
  }
  async syncDingTalk(progress) { return collectDingTalk(this, progress); }
  async commitDingTalk(data, assets, links) {
    const current = this.db.prepare('SELECT v.* FROM business_versions v JOIN business_active a ON a.version_id=v.id WHERE a.year=?').get(data.year);
    if (current?.file_hash === data.hash) return {year:data.year,versionId:current.id,unchanged:true};
    if (current && !JSON.parse(current.data_json).dingtalkTables) throw new Error(`${data.year} 年已有 Excel 数据，未覆盖；请先备份并选择不同年度来源`);
    const existing=this.db.prepare("SELECT id FROM business_versions WHERE year=? AND file_hash=? AND status='committed'").get(data.year,data.hash);
    if(existing) {this.restore(existing.id);return {year:data.year,versionId:existing.id,unchanged:false,reused:true};}
    const id=randomUUID(), filename=`店铺销售额-${data.year}-钉钉快照.xlsx`, file=path.join(this.directory,`${id}.xlsx`);
    const snapshot=dingTalkSnapshot(data), byId=new Map(assets.map(a=>[a.id,a]));
    const bytes=await exportSheetSnapshot(snapshot,[...new Set(data.images.map(i=>i.assetId))].map(key=>byId.get(key)));
    fs.writeFileSync(file,bytes,{flag:'wx'});
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const latest=this.db.prepare('SELECT version_id FROM business_active WHERE year=?').get(data.year)?.version_id;
      if (latest !== current?.id) throw new Error('同步期间年度版本发生变化，请重新同步');
      const insert=this.db.prepare('INSERT OR IGNORE INTO business_assets VALUES (?,?,?)');
      for(const asset of assets) insert.run(asset.id,asset.extension,asset.data);
      const cache=this.db.prepare('INSERT INTO business_dingtalk_assets VALUES (?,?) ON CONFLICT(resource_id) DO UPDATE SET asset_id=excluded.asset_id');
      for(const link of links) cache.run(link.resourceId,link.assetId);
      this.db.prepare('INSERT INTO business_versions VALUES (?,?,?,?,?,?,?)').run(id,data.year,data.hash,filename,new Date().toISOString(),'committed',JSON.stringify(data));
      this.db.prepare('INSERT INTO business_active VALUES (?,?) ON CONFLICT(year) DO UPDATE SET version_id=excluded.version_id').run(data.year,id);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');fs.rmSync(file,{force:true});throw error;}
    return {year:data.year,versionId:id,unchanged:false};
  }
}

export function dingTalkSnapshot(data, month='') {
  const selected=data.dingtalkTables.map(t=>({...t,records:t.records.filter(r=>!month||recordMonth(r,t.fields)===month)}));
  const selectedImages=data.images.filter(i=>!month||i.month===month);
  const nativeData=projectDingTalk(selected,data.year,selectedImages);
  return {year:data.year,raw:true,cloud:true,nativeData,sheets:selected.map(table=>{
    const cells=[], records=table.records.filter(r=>!month || String(scalar(r.cells[table.fields.find(f=>f.type==='date' || f.fieldName==='日期')?.fieldId])||'').replace('年','-').startsWith(month));
    for(const [i,field] of table.fields.entries()) cells.push({sheet:table.name,cell:`${columnName(i)}1`,value:field.fieldName});
    const images=[];
    for(const [r,record] of records.entries()) for(const [c,field] of table.fields.entries()) {
      const cell=`${columnName(c)}${r+2}`;
      if(field.type==='attachment') {
        images.push(...data.images.filter(i=>i.recordId===record.recordId && i.fieldId===field.fieldId && i.sheet===table.name).map(i=>({...i,cell})));
      } else cells.push({sheet:table.name,cell,value:scalar(record.cells[field.fieldId]),format:'General',sourceFormula:field.config?.formula||null});
    }
    return {name:table.name,scope:table.scope,ref:`A1:${columnName(table.fields.length-1)}${Math.max(2,records.length+1)}`,cells,images,merges:[],cols:[],fields:table.fields,widths:table.widths,records:records.map((r,index)=>({id:r.recordId,row:index+2}))};
  })};
}
