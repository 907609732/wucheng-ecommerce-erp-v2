/** Files owned exclusively by the optional Windows warehouse extension. */
export function deferredWarehouseFile(rel){
  return rel.startsWith('core/')||rel.startsWith('desktop/renderer/')||
    /^desktop\/(?:main\.mjs|preload\.cjs|updater\.mjs|packaged-smoke\.mjs|prepare-build\.mjs)$/.test(rel)||
    /^desktop\/workbench\/warehouse-/.test(rel)||
    /^desktop\/shared\/(?:inventory-store|monthly-sales-store)\.mjs$/.test(rel)||
    rel==='desktop/modules/cloud-control.mjs';
}
