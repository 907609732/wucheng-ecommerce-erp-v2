import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 开票独有的店铺登记簿，不读取财务店铺、库存库或财务登录分区。
export class InvoiceShopStore {
  constructor(directory) { this.file = path.join(directory, 'shops.json'); }
  list() {
    if (!fs.existsSync(this.file)) return [];
    const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('开票店铺配置损坏，请检查 shops.json');
    return rows;
  }
  get(id) { const shop = this.list().find(s => s.id === id); if (!shop) throw new Error('开票店铺不存在'); return shop; }
  save(rows) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows, null, 2), { encoding: 'utf8', flag: 'w' });
    fs.renameSync(temp, this.file);
  }
  add(name, platform = 'taobao') {
    const value = String(name || '').trim();
    if (!['taobao', 'pdd'].includes(platform)) throw new Error('不支持的开票平台');
    if (!value || value.length > 60) throw new Error('请输入不超过60字的店铺名称');
    const rows = this.list();
    if (rows.some(s => s.name === value && (s.platform || 'taobao') === platform)) throw new Error('开票店铺已存在');
    const shop = { id: randomUUID(), platform, name: value, account: '', createdAt: new Date().toISOString() };
    this.save([...rows, shop]);
    return shop;
  }
  rename(id, name) {
    const value = String(name || '').trim();
    if (!value || value.length > 60) throw new Error('请输入不超过60字的店铺名称');
    const rows = this.list();
    const shop = rows.find(s => s.id === id);
    if (!shop) throw new Error('开票店铺不存在');
    if (shop.account || shop.identityMode) throw new Error('已确认的开票店铺不可直接改名，请先核对身份');
    if (rows.some(s => s.id !== id && s.name === value && (s.platform || 'taobao') === (shop.platform || 'taobao'))) throw new Error('开票店铺已存在');
    shop.name = value;
    this.save(rows);
    return shop;
  }
  confirm(id, account) {
    const value = String(account || '').trim();
    if (!value || value.length > 100) throw new Error('未识别到登录账号');
    const rows = this.list();
    const shop = rows.find(s => s.id === id);
    if (!shop) throw new Error('开票店铺不存在');
    if (rows.some(s => s.id !== id && s.account === value)) throw new Error('该登录账号已绑定其他开票店铺');
    shop.account = value;
    shop.identityMode = 'cookie';
    this.save(rows);
    return shop;
  }
  confirmHeader(id, headerName) {
    const shops = this.list();
    const target = shops.find((shop) => shop.id === id);
    if (!target) throw new Error('开票店铺不存在');
    if (!headerName || headerName !== target.name) throw new Error('页面右上角的店铺名称与登记店铺不一致');
    target.account = '';
    target.identityMode = 'header';
    target.confirmedAt = new Date().toISOString();
    this.save(shops);
    return target;
  }
  remove(id) { const rows = this.list(); if (!rows.some(s => s.id === id)) throw new Error('开票店铺不存在'); this.save(rows.filter(s => s.id !== id)); }
}
export function invoiceShopLedgerName(shop) {
  return (shop.platform || 'taobao') === 'pdd' ? `拼多多·${shop.name}` : shop.name;
}

export function matchingInvoiceAccount(shop, accounts, headerNames = []) {
  if (shop.identityMode === 'header') {
    const labels = [...new Set(headerNames.map(v => String(v || '').trim()).filter(Boolean))];
    if (labels.length !== 1 || labels[0] !== shop.name) return { ok: false, reason: '页面右上角店铺名称与登记店铺不一致或不可识别，请重新核对' };
    return { ok: true };
  }
  const values = [...new Set(accounts.map(v => String(v || '').trim()).filter(Boolean))];
  if (shop.platform === 'pdd') return { ok: false, reason: '拼多多需确认开票页右上角店铺名' };
  if (!shop.account) return { ok: false, reason: '请先在开票模块登录并确认店铺账号' };
  if (values.length !== 1) return { ok: false, reason: values.length ? '登录账号不唯一，请重新确认' : '未登录千牛，请在开票模块重新登录' };
  if (values[0] !== shop.account) return { ok: false, reason: '当前登录账号与开票店铺绑定账号不一致' };
  return { ok: true };
}
