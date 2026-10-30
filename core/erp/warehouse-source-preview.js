import {loadConfig} from '../config.js';
import {findColumn,readSheetRows,toText,toNumber} from './sheets.js';

/** Read-only verification of the same configured SKU/quantity columns used by
 * importInventoryFile. Historical sending must check rows, not just equal totals. */
export function inventorySourceQuantities(file,warehouseId='cainiao'){
  const config=loadConfig(),rows=readSheetRows(file),headers=rows.length?Object.keys(rows[0]):[];
  const columns=config.inventoryColumns||{},warehouseName=(config.erp?.warehouses||[]).find(w=>w.id===warehouseId)?.name||'';
  const skuColumn=findColumn(headers,columns.sku||[]),nameColumn=findColumn(headers,columns.name||[]);
  const quantityColumn=findColumn(headers,warehouseName?[`${warehouseName}库存`,`${warehouseName}库存数`]:[])||findColumn(headers,columns.quantity||[]);
  if(!quantityColumn)throw Object.assign(Error('原件没有可核对的库存列'),{code:'WAREHOUSE_SOURCE_COLUMNS_INVALID'});
  const seen=new Set();return rows.map(row=>{const sku=toText(skuColumn?row[skuColumn]:'')||toText(nameColumn?row[nameColumn]:'');if(!sku||seen.has(sku))throw Object.assign(Error('原件SKU缺失或重复'),{code:'WAREHOUSE_SOURCE_COLUMNS_INVALID'});seen.add(sku);return [sku,toNumber(row[quantityColumn])];}).sort((a,b)=>a[0].localeCompare(b[0]));
}
