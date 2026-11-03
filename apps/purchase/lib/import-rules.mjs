import {detectMapping} from './importer.mjs';
import {importRules} from '../public/import-rules.mjs';
export function platformMapping(table,platform){
 if(!Object.hasOwn(importRules,platform))throw Error('请先选择采购平台，再上传文件');
 const h=table.headers.map(v=>String(v).trim());
 const taobao=['订单提交时间','型号款式','商品金额','实付金额'].every(x=>h.includes(x));
 const ali=h.includes('买家会员名')&&h.includes('货品标题')&&h.some(x=>/实付款/.test(x));
 const xianyu=['登录账号昵称','登录用户ID','卖家昵称','闲鱼币抵扣'].every(x=>h.includes(x));
 const pdd=['订单ID','商品名','价格','实付','店名','用户名','登录用户ID','快递状态'].every(x=>h.includes(x));
 if(pdd&&platform!=='拼多多')throw Error('文件是拼多多购买订单格式，请切换到拼多多后重新上传');
 if(xianyu&&platform!=='闲鱼')throw Error('文件是闲鱼购买订单格式，请切换到闲鱼后重新上传');
 if(taobao&&platform!=='淘宝')throw Error('文件是淘宝购买订单格式，请切换到淘宝后重新上传');
 if(ali&&platform!=='1688')throw Error('文件是1688采购订单格式，请切换到1688后重新上传');
 const mapping=detectMapping(h);
 if(platform==='拼多多')for(const [key,header] of Object.entries({account:'用户名',title:'商品名',supplier:'店名',recipient:'收货人名',phone:'收货电话'}))if(mapping[key]==null&&h.includes(header))mapping[key]=String(h.indexOf(header));
 if(pdd&&mapping.unitPrice==null)mapping.unitPrice=String(h.indexOf('价格'));
 if(platform==='闲鱼'&&h.includes('登录账号昵称'))mapping.account=String(h.indexOf('登录账号昵称'));
 if(taobao)mapping.unitPrice=String(h.indexOf('商品金额'));
 // Platform is chosen by the user, never silently overridden by a spreadsheet cell.
 const sourcePlatform=mapping.platform;
 if(sourcePlatform!=null&&table.rows.some(r=>String(r.cells[Number(sourcePlatform)]??'').trim()&&String(r.cells[Number(sourcePlatform)]).trim()!==platform))throw Error('表内采购平台与所选平台不一致，请分平台导入');
 delete mapping.platform;
 return mapping;
}
