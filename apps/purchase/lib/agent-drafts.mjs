// These are proposed order values only. Editing sends new task input and requires
// a fresh prepare/review; it never changes a saved order or its approval in place.
export const orderDraftFields=['platform','account','orderNo','date','paidAt','supplier','status','amountCents','refundCents','shippingCents','note','recipient','phone','address','logisticsCompany','trackingNo'];
export const orderDraftBlock=(order,id='purchase-order-draft')=>({type:'table',id,title:'待复核采购单草稿',rowKey:'draftKey',editableFields:[...orderDraftFields],rows:[{...order,draftKey:'order'}]});
