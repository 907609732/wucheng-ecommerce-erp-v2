import Ajv from 'ajv';
import {importRules} from '../public/import-rules.mjs';
import {orderStatuses} from '../public/order-attributes.mjs';
const text=(description,maxLength=200)=>({type:'string',description,maxLength});
const id=text('使用查询结果返回的真实记录ID，不填写名称或主机路径',300);
const date={type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$',description:'业务日期 YYYY-MM-DD'};
const month={type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$',description:'业务月份 YYYY-MM；采购确认按付款月，缺付款日回退下单月'};
const integer=(description,minimum=0,maximum=1e12)=>({type:'integer',minimum,maximum,description});
const money=integer('人民币整数分，100表示1元；不得传元或浮点数');
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const arr=(items,maxItems=100000,minItems=0)=>({type:'array',items,maxItems,minItems});
const platform={type:'string',enum:Object.keys(importRules),description:'真实采购平台；历史手工平台不作为新录入选项'};
const category={type:'string',enum:['goods','fixed_asset','expense'],description:'商品采购/固定资产采购/日常支出'};
const revision=text('上次对应查询返回的revision，变化后须重新查询',300);
const updatedAt=text('原记录updatedAt，必须原样传回以防覆盖他人修改',100);
const bool={type:'boolean'};
const classification=obj({mode:{enum:['single','split']},category,owner:{enum:['company']},parts:arr(obj({category,amountCents:money,refundCents:money},['category','amountCents','refundCents']),3,2)},['mode']);
const shipment=obj({trackingNo:text('运单号',100),logisticsCompany:text('物流公司',200)});
const item=obj({title:text('商品名称',4000),spec:text('规格',4000),sku:text('货号'),qty:{type:'number',exclusiveMinimum:0},unit:text('数量单位',100),unitPriceCents:{anyOf:[money,{type:'null'}]},trackingNo:text('运单号',100),logisticsCompany:text('物流公司'),shipments:arr(shipment,20)},['title','qty']);
const orderFields={platform,account:text('实际采购账号，同号跨账号为不同订单'),orderNo:text('平台订单编号，作为字符串保留长整数与前导零',100),date,paidAt:{anyOf:[date,{const:''}]},supplier:text('供应商或店铺名称'),status:{enum:orderStatuses},amountCents:money,refundCents:money,shippingCents:money,note:text('订单备注',10000),items:arr(item,10000,1),classification,excludedFromSpend:bool,attachmentIds:arr(id,20),recipient:text('收货人',4000),phone:text('联系电话',4000),address:text('收货地址',4000),logisticsCompany:text('物流公司',4000),trackingNo:text('运单号',4000),supplierContact:obj({name:text('联系人'),phone:text('电话',40),address:text('详细地址',4000)})};
const orderRequired=['platform','orderNo','date','supplier','amountCents','items'];
const filter={q:text('订单关键词',4000),platform,account:text('采购账号'),supplier:text('店铺名'),category,status:{enum:orderStatuses},basis:{enum:['paid','created'],description:'paid付款月（缺付款回退下单）；created下单日'},month,from:date,to:date,spend:{enum:['excluded','normal','effective']},note:{enum:['yes','no']},tracking:{enum:['yes','no']},refund:{enum:['yes','no']},carrier:text('物流公司'),minAmount:{type:'number',minimum:0,description:'筛选下限，单位元，与存储整数分不同'},maxAmount:{type:'number',minimum:0,description:'筛选上限，单位元'},preset:{enum:['all','effective','excluded','closed','review','noted','refunded']}};
const refs=arr(obj({id,updatedAt},['id','updatedAt']),100000,1);
const addressFields={id,updatedAt,name:text('联系人/供应商名称'),phone:text('电话',40),address:text('地址',4000),note:text('备注',2000),tags:arr(text('标签',20),20),platform,supplier:text('关联店铺；须与平台同时填写')};
const shop=obj({platform,name:text('店铺名称'),url:text('完整无凭据http/https网址',2000),account:text('账号'),note:text('备注',2000)},['platform']);
export const purchaseSchemas={
 orders:obj({...filter,id}),dashboard:obj({year:integer('公历年份',1900,9999),basis:filter.basis,platform,category,month:integer('月份，1至12',1,12)},['year']),
 sources:obj({}),audit:obj({id,page:integer('页码',1,1000000),pageSize:integer('每页条数',1,100),q:text('审计搜索',4000)}),
 suppliers:obj({id,q:text('供应商关键词'),platform}),addresses:obj({q:text('联系人/地址搜索'),tag:text('标签',20)}),tasks:obj({month},['month']),months:obj({month,platform},['month']),attachments:obj({id},['id']),
 export:obj({...filter,kind:{enum:['orders','classification','monthly','template']},year:integer('年份',1900,9999)}),
 'ocr.text':obj({text:text('从采购凭证粘贴的原文；提取后仍需人工复核',100000),platform},['text']),
 'ocr.status':obj({id},['id']),'import.preview':obj({previewId:id},['previewId']),
 'order.create':obj(orderFields,orderRequired),'order.update':obj({...orderFields,id,updatedAt},[...orderRequired,'id','updatedAt']),
 'orders.attributes':obj({orders:refs,patch:obj({status:orderFields.status,excludedFromSpend:bool,supplier:orderFields.supplier,account:orderFields.account})},['orders','patch']),
 'orders.classification':obj({orders:refs,category},['orders','category']),
 'supplier.save':obj({id,revision:integer('供应商查询返回的版本',1),name:text('供应商名'),contact:text('联系人'),phone:text('电话',40),wechat:text('微信'),note:text('备注',10000),shops:arr(shop,100),addresses:arr(obj({label:text('地址标签',100),name:text('联系人'),phone:text('电话',40),address:text('详细地址',4000),note:text('备注',2000)}),100),products:arr(obj({name:text('产品名称',400),spec:text('规格',1000),sku:text('编号'),unit:text('单位',100),priceCents:{anyOf:[money,{type:'null'}]},note:text('备注',2000)},['name']),500)},['name']),
 'address.save':obj(addressFields,['name']),'address.remove':obj({id,updatedAt},['id','updatedAt']),
 'task.action':obj({month,taskId:id,action:{enum:['assign','start','submit','accept','return']},revision,assigneeId:id,dueOn:date,instructions:text('任务说明',2000),note:text('提交或退回说明',2000),ack:bool,result:{enum:['done','no_activity']}},['month','taskId','action','revision']),
 'task.mark':obj({month,taskId:id,status:{enum:['pending','done','no_activity']},operator:text('经办人',100),note:text('核对说明',2000),ack:bool,revision},['month','taskId','status','operator','revision']),
 'month.confirm':obj({month,platform,revision},['month','platform','revision']),
 'month.cancel':obj({month,platform,version:text('查询返回的确认版本；只有管理员中央审批可解锁',300)},['month','platform','version']),
 'audit.rollback':obj({auditId:integer('审计记录ID',1),scope:{enum:['entry','batch']},versions:arr(obj({auditId:integer('审计ID',1),orderId:id,updatedAt},['auditId','orderId','updatedAt']),100000,1),reason:text('回滚原因',500)},['auditId','scope','versions']),
 'import.commit':obj({previewId:id,indices:arr(integer('预览orders数组从0开始的索引',0,1000000),100000,1)},['previewId','indices']),
 'image.prepare':obj({id},['id']),'image.cache':obj({id,imageId:id},['id','imageId']),'attachment.remove':obj({id},['id'])
};
const ajv=new Ajv({allErrors:true,strict:false});
const validators=new Map(Object.entries(purchaseSchemas).map(([id,s])=>[id,ajv.compile(s)]));
export function validatePurchaseAgentInput(id,input){const validate=validators.get(id);if(!validate||!validate(input))throw Object.assign(Error('采购参数不符合能力说明：'+ajv.errorsText(validate?.errors,{separator:'；'})),{code:'CAPABILITY_INPUT_INVALID',status:400});}
