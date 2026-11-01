import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {SHOPS,DATASETS} from './config.mjs';
import {id,now,month,beijing,shiftMonth,monthsBetween,fail} from './util.mjs';
import {exportWorkbook} from './export.mjs';


export function sourceStatus(s,m) {
  return s.shops().map(shop=>({ ...shop,status:shop.manual?'manual':['淘宝','拼多多'].includes(shop.platform)?'access_blocked':shop.platform==='抖店'?'month_unverified':'unverified',message:shop.manual?'在销售台登记并核对完整月份':shop.platform==='淘宝'?'浏览器站点安全策略拦截；尚未取得报表':shop.platform==='拼多多'?'后台自动访问受限；官方货款账务 ZIP 已支持店铺归属、完整度及逐笔核对':shop.platform==='抖店'?'本人曾完成登录并核实店名；尚未验证完整月导出':'尚未验证账号、报表字段和导出流程',datasets:Object.keys(DATASETS).map(dataset=>({dataset,...(s.get('SELECT status,evidence FROM coverage WHERE shop_id=? AND month=? AND dataset=?',shop.id,m,dataset)||{status:'missing',evidence:'尚未取得'})}))}));
}
