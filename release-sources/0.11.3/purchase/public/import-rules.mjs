export const importRules={
 '京东':{title:'京东购买订单',description:'保留买家账号、订单号、全部商品明细和整单实付；历史订单通过两次核对后入账。',account:'待补充'},
 '1688':{title:'1688 采购订单',description:'读取买家会员名、货品标题、单价和单位；同一订单的实付款只计一次。',account:'默认账号'},
 '淘宝':{title:'淘宝购买订单',description:'读取订单提交时间、型号款式和商品数量；已适配的购买订单表将商品金额作为单价，整单实付只计一次。',account:'待补充'},
 '闲鱼':{title:'闲鱼购买订单',description:'读取登录账号昵称、卖家昵称、商品和实付款；拆分明确的收货人、手机和地址。实付款含运费，不重复加计；原表缺少单价时保留为空。',account:'待补充'},
 '拼多多':{title:'拼多多购买订单',description:'读取用户名、商品名、价格（单价）、店名、收货信息和运单号，按整单实付入账。“拼过几次”仅在同时有已签收和有效收货时间时归为已完成，并保留依据。',account:'待补充'},
 '微信':{title:'微信采购订单',description:'使用通用模板整理微信采购，填写供应商、商品、数量及实付金额；没有订单号时使用自定编号，整单实付只计一次。',account:'默认账号'},
 '其他':{title:'其他来源采购表',description:'使用通用字段规则，核对日期、商品数量及金额含义，无法识别的列需手动对应。',account:'默认账号'}
};

// Compatibility only: old orders and their month locks remain editable without offering this as a platform.
export const isStoredPlatform=platform=>Object.hasOwn(importRules,platform)||platform==='手工';
