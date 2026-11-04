// Explicitly reviewed business data only. New tables require an intentional policy update.
export const DATA_VERSION_POLICY = Object.freeze({
 purchase:{database:'purchases.sqlite',tables:['orders','imports','audit','settings','order_supplements','order_fingerprint_compat','order_origins','order_attachments','month_confirmations','month_events','image_assets','order_images','integration_transfers','integration_accounts','integration_order_sources','integration_events','addresses','purchase_staff','purchase_staff_events','supplier_profiles','supplier_shop_links','supplier_profile_history','monthly_tasks','monthly_task_events','purchase_task_assignments','purchase_task_assignment_events'],settings:['account-backfill-report'],folders:['originals','attachments','images'],files:{imports:['file_path'],order_attachments:['file_path','thumb_path'],image_assets:['file_path','thumb_path']}},
 sales:{database:'sales.sqlite',tables:['shops','settings','imports','operations','ledger','matches','coverage','rates','month_locks','month_history','audit','batch_attributions','platform_references','freight_records','freight_attachments','freight_requests','sales_staff_handoffs','sales_domain_people','sales_actor_people'],settings:['deletedShopIds'],folders:['originals'],files:{imports:['original_path'],freight_attachments:['original_path']}},
 overview:{database:'overview.sqlite',tables:['bills','payments','imports','coverage','overrides','snapshots','audit','payroll_sheet_requests'],settings:[],folders:['originals'],files:{imports:['path']}}
});
export const quoteIdentifier=value=>'"'+String(value).replaceAll('"','""')+'"';
export function embeddedBusinessFiles(module,table,row){
 if(module!=='overview'||table!=='payments')return [];
 const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
 return (JSON.parse(row.payload).evidence||[]).map(e=>{
  if(!/^[a-f0-9-]{36}$/.test(e.id)||!extensions[e.mime]||!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isSafeInteger(e.bytes)||e.bytes<=0)throw Error('Invalid payment evidence metadata');
  return {path:'originals/payment-'+e.id+'.'+extensions[e.mime],sha256:e.sha256,bytes:e.bytes};
 });
}
// Review sessions are runtime capabilities, not recoverable business data.
export function businessRowCondition(module,table,alias){
 if(module==='sales'&&table==='imports')return `${alias}.status IN ('committed','rolled_back')`;
 if(module==='sales'&&table==='batch_attributions')return `EXISTS(SELECT 1 FROM imports WHERE imports.id=${alias}.import_id AND imports.status IN ('committed','rolled_back'))`;
 if(module==='purchase'&&table==='integration_transfers')return `${alias}.state IN ('committed','rolled_back')`;
 if(module==='purchase'&&table==='integration_events')return `${alias}.action IN ('commit.verified','commit.post-verified','rollback')`;
 return '';
}
const transientKeys=new Set(['token','accessToken','access_token','refreshToken','refresh_token','password','secret','secret_hash','session','sessionId','session_id','reviewSession','review_session','receipt','csrf','cookie','authorization','integrationKey','workbenchKey']);
function publicJson(value){
 if(Array.isArray(value))return value.map(publicJson);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!transientKeys.has(key)).map(([key,item])=>[key,publicJson(item)]));
 return value;
}
export function sanitizeBusinessRow(module,table,row){
 const output={...row};
 if(module==='purchase'&&table==='integration_transfers')for(const key of ['review_json','review_session','receipt','expires_at'])if(key in output)output[key]=null;
 for(const [key,value]of Object.entries(output))if(typeof value==='string'&&(/(?:_json|payload|details|metadata|snapshot|original|context_json|preview_json|result|response)$/.test(key)||key==='items')){try{output[key]=JSON.stringify(publicJson(JSON.parse(value)));}catch{}}
 return output;
}
export const PRIMARY_BUSINESS_TABLES=Object.freeze({
 purchase:['orders','settings','addresses','supplier_profiles','supplier_shop_links','purchase_staff','monthly_tasks','purchase_task_assignments','month_confirmations','integration_accounts'],
 sales:['shops','settings','operations','ledger','matches','coverage','rates','month_locks','platform_references','freight_records','sales_staff_handoffs','sales_domain_people','sales_actor_people','batch_attributions'],
 overview:['bills','payments','coverage','overrides','snapshots']
});
const helperTables=new Set(['audit','order_fingerprint_compat','month_events','monthly_task_events','purchase_task_assignment_events','purchase_staff_events','supplier_profile_history','integration_events','freight_requests','payroll_sheet_requests']);
export const isBusinessMutation=(_module,table)=>!helperTables.has(table);
export const isRecoverableBusinessRow=(_module,table,row)=>table!=='audit'||!/(?:^|\.)(?:stage|preview|failed)(?:\.|$)/i.test(row.action||'');
