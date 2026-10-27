// address-parse is bundled locally (MIT); no address leaves this computer.
export function parseAddress(text,parser=globalThis.AddressParse){
 const original=String(text??'').trim();if(!original)return {recipient:'',phone:'',address:''};
 if(!parser?.parse)throw Error('地址识别组件未加载，请刷新页面');
 const clean=original.replace(/(?:收货人(?:姓名)?|联系人|姓名|联系电话|联系手机|手机号(?:码)?|电话|手机|收货地址|详细地址|地址)\s*[：:]\s*/g,' ').replace(/[，,;；\r\n]+/g,' ');
 const result=parser.parse(clean,true)[0]||{};
 const province=(result.province||'').replace(/市$/,''),city=(result.city||'').replace(/市$/,'');
 const regions=province&&province===city?[result.city,result.area]:[result.province,result.city,result.area];
 return {recipient:result.name||'',phone:result.mobile||result.phone||'',address:[...regions,result.details].filter(Boolean).join('')||clean};
}

// 运单号 → 物流公司，按常见前缀识别；识别不出返回空字符串，由用户手动填写。
const carriers=[
 [/^SF\d{10,}$/i,'顺丰速运'],
 [/^YT\d{10,}$/i,'圆通速递'],
 [/^ZT\d{10,}$/i,'中通快递'],
 [/^YD\d{10,}$/i,'韵达快递'],
 [/^ST\d{10,}$/i,'申通快递'],
 [/^JD\d{10,}$/i,'京东物流'],
 [/^JT\d{10,}$/i,'极兔速递'],
 [/^DPK\d{8,}$/i,'德邦快递'],
 [/^(EA|EB|EK|ET)\d{9}[A-Z]{2}$/i,'中国邮政 EMS'],
];
export const carrierOptions=['申通快递','圆通快递','中通快递','韵达快递','顺丰快递','京东快递','其他'];
export function normalizeCarrier(value){
 const text=String(value??'').trim();if(!text)return '';
 const rules=[[/申通|^STO$/i,'申通快递'],[/圆通|^YTO$/i,'圆通快递'],[/中通|^ZTO$/i,'中通快递'],[/韵达|^YUNDA$/i,'韵达快递'],[/顺丰|^SF(?:EXPRESS)?$/i,'顺丰快递'],[/京东|^JD(?:LOGISTICS)?$/i,'京东快递']];
 const hits=rules.filter(([re])=>re.test(text));return hits.length===1?hits[0][1]:'其他';
}
export function detectCarrier(trackingNo){
 const s=String(trackingNo??'').trim();
 if(!s)return '';
 const hit=carriers.find(([re])=>re.test(s));
 return hit?normalizeCarrier(hit[1]):'';
}
