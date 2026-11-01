/**
 * 四个业务模块的统一基线（fixed baseline）。
 *
 * 主进程、渲染界面和测试都只从这里读取模块清单，不再各自维护一份。
 * 需要调整入口、名称或分组时只改这一处，避免四个软件项目的底层入口再次分叉。
 */
export const BUSINESS_MODULES = Object.freeze([
  Object.freeze({id:'warehouse', label:'菜鸟云仓同步', short:'云仓', surface:'window', summary:'同步云仓库存，查看库存与销售变化。'}),
  Object.freeze({id:'overview', label:'经营收支总览', short:'经营', surface:'embedded', summary:'汇总销售、采购及各项费用，查看整体收支与待补数据。'}),
  Object.freeze({id:'sales', label:'销售台', short:'销售', surface:'embedded', summary:'销售账单、运营数据与运费费用。'}),
  Object.freeze({id:'purchase', label:'采购台', short:'采购', surface:'embedded', summary:'采购记账、历史订单导入与支出核对。'})
]);

/** 一键打开时的固定顺序：先预热内嵌模块，最后打开独立的云仓窗口。 */
export const BUSINESS_MODULE_IDS = Object.freeze(BUSINESS_MODULES.map(module => module.id));

/** 能在工作台内嵌显示的模块。 */
export const EMBEDDED_MODULE_IDS = Object.freeze(BUSINESS_MODULES.filter(module => module.surface === 'embedded').map(module => module.id));

/** 工作台标签页的固定顺序。 */
export const TAB_MODULE_IDS = Object.freeze(['overview', 'purchase', 'sales']);

export function businessModule(id){
  return BUSINESS_MODULES.find(module => module.id === id) || null;
}
