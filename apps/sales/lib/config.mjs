export const SHOPS = [{id:'offline',platform:'线下',name:'线下销售',receipts:'手工登记',manual:true},{id:'dropship',platform:'代发',name:'供货代发',receipts:'手工登记',manual:true}];
export const KINDS = { sale:'销售应收', refund:'销售退款', settlement:'平台净结算', receipt:'实际收款', expense:'单店费用', platform_flow:'平台账户动账', transfer:'内部转账', withdrawal:'提现', recharge:'充值', deposit:'保证金' };
export const DATASETS = { operations:'运营', settlement:'结算', receipt:'收款', expense:'单店费用' };
export const DEFINITIONS = '支付金额含买家运费；退款按退款发生日；订单按支付订单数。流量与广告归因保留来源定义。';
export const EXCLUSIONS = '净收入未扣商品成本、共用顺丰、云仓、分摊费用、人工、外包、工资和房租。';
export const CURRENCIES = ['CNY', 'RUB', 'USD', 'EUR'];
