export function newOrderNumber(platform,date,uuid=globalThis.crypto.randomUUID()){
 const prefix=platform==='微信'?'WX':'MAN';
 return `${prefix}-${String(date).replaceAll('-','')}-${uuid.replaceAll('-','')}`;
}
