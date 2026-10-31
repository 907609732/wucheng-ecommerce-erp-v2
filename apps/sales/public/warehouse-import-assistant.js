import {loadingMarkup} from './loading-screen.mjs';
const skillFiles=['SKILL.md','references/browser.md','references/import.md'];
const skillBase=new URL('./skills/cainiao-freight-import/',import.meta.url);
export const freightImportPlatforms=[{id:'warehouse',label:'菜鸟云仓',available:true},{id:'merchant',label:'商家寄件',available:false},{id:'sf',label:'顺丰快递',available:false}];
export function warehouseImportPrompt({month,scope='missing'}={}){
  const selected=/^20\d{2}-(0[1-9]|1[0-2])$/.test(month||'')?month:null;
  return `请使用 $cainiao-freight-import，执行菜鸟云仓运费导入当前工作台的销售台。若没有安装此 Skill，请直接读取下面附带的 SKILL.md 和两个 references 文件并按其执行，无需先安装。\n${scope==='month'&&selected?'本次仅处理 '+selected+'。':'本次补齐当前可查询的缺失月份，并更新已有未结月。'}\n\n请按以下固定步骤执行：\n1. 检查本地浏览器和文件处理能力，读取当前工作台配置，发现当前工作台的销售台服务与 dataDir，先核实正式/Beta环境及目标账本；不得从Beta自动切到正式台，正式导入核实不是演示库；不另建账本，不硬编码用户名、端口或凭据。\n2. 优先使用 ego-browser 操作已登录的云仓对账页面，按业务时间逐月下载交易账单、货品信息、计费明细，保留官方原件和实际截止日。\n3. 按整数分核对月份、币种、页面合计及交易账单与费用明细净额，保留赔付负数；云仓统一归多店共用，不分摊店铺。\n4. 查重并列出新增、更新、跳过和待处理月份。相同账单跳过，未结月更新原记录并保留旧附件历史；锁定、未知费用项或来源重叠时保留原件并说明原因，不自行解锁或覆盖。\n5. 写入前备份本次目标销售台账本和原附件，通过现有运费 API 执行已核实范围内的导入，不修改程序、原有资金流水、对账或其他模块。\n6. 逐月回读金额、分类、版本、截止日和附件哈希，在真实界面核验；确认原有数据与审计保留，不把点击或下载任务完成当作导入成功。\n7. 报告新增、更新、跳过、待处理月份、净额、截止日、原件和备份位置。需要登录验证时由我处理。\n\n下面附有完整 Skill 和参考文件，请先读取，再执行。`;
}

export async function openWarehouseImportAssistant({$,esc,dialog,toast,state,boot}){
  const month=/^20\d{2}-\d{2}$/.test(state.period)?state.period:boot.month;
  dialog('开始导入运费',`<div data-freight-ui class="freight-import-assistant"><style>.freight-import-platforms{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.freight-import-platforms button{white-space:normal;text-align:left}.freight-import-platforms small{display:block}.freight-import-platforms [aria-pressed="true"]{background:var(--green);border-color:var(--green);color:white}.freight-import-assistant .actions{flex-wrap:wrap}.freight-import-assistant textarea{width:100%;max-width:100%;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere}.freight-import-assistant [hidden]{display:none!important}@media(max-width:600px){.freight-import-platforms{grid-template-columns:1fr}}</style><p class="section-note">先选账单平台，再把提示词和 Skill 发给能操作本地浏览器、文件的 AI。</p><div class="freight-import-platforms" role="group" aria-label="选择运费平台">${freightImportPlatforms.map(p=>`<button type="button" class="button" data-freight-platform="${p.id}" aria-pressed="false">${esc(p.label)}<small>${p.available?'已开通':'待开通'}</small></button>`).join('')}</div><p id="warehouse-ai-status" class="section-note" role="status" hidden></p><div id="warehouse-ai-ready" hidden><p class="section-note">打开已登录的云仓账单页 → 复制内容交给 AI → 回到运费查看结果。</p><label class="field">本次导入范围<select id="warehouse-ai-scope"><option value="missing">补齐缺失月份并更新未结月</option><option value="month">仅处理 ${esc(month)}</option></select></label><label class="field">AI 提示词与完整 Skill<textarea id="warehouse-ai-packet" rows="10" readonly aria-label="AI提示词和完整Skill"></textarea></label><p class="section-note">Skill：cainiao-freight-import · 含浏览器操作与账单导入说明</p><div class="actions"><button type="button" class="button primary" id="warehouse-ai-copy" disabled>复制提示词和 Skill</button><a class="button" id="warehouse-ai-download" href="${esc(new URL('./skills/cainiao-freight-import.zip',import.meta.url).href)}" download="cainiao-freight-import.zip">下载 Skill</a></div><p class="section-note">选择平台和复制内容不会执行导入或修改账本。</p></div><p class="error" role="alert" id="warehouse-ai-error"></p><button type="button" class="button" id="warehouse-ai-retry" hidden>重新读取 Skill</button></div>`);
  const packet=$('#warehouse-ai-packet'),button=$('#warehouse-ai-copy'),error=$('#warehouse-ai-error'),scope=$('#warehouse-ai-scope'),ready=$('#warehouse-ai-ready'),status=$('#warehouse-ai-status'),retry=$('#warehouse-ai-retry');
  let generation=0,selectedId='',files=null;
  const alive=()=>packet.isConnected&&packet.closest('dialog')?.open;
  const update=()=>{packet.value=warehouseImportPrompt({month,scope:scope.value})+'\n\n'+files.map(file=>'===== '+file.name+' =====\n'+file.text).join('\n\n');button.textContent='复制提示词和 Skill';};
  scope.onchange=()=>{if(files&&selectedId==='warehouse')update();};
  button.onclick=async()=>{if(selectedId!=='warehouse'||ready.hidden||button.disabled)return;try{await navigator.clipboard.writeText(packet.value);if(alive()&&selectedId==='warehouse'){button.textContent='已复制，发给 AI 即可';toast('已复制提示词和完整 Skill');}}catch{if(alive()&&selectedId==='warehouse'){packet.focus();packet.select();error.textContent='自动复制未完成，完整内容已选中，请按 Ctrl+C 复制。';}}};
  const choose=async id=>{
    const request=++generation,selected=freightImportPlatforms.find(p=>p.id===id);selectedId=id;ready.hidden=true;button.disabled=true;packet.value='';error.textContent='';retry.hidden=true;status.innerHTML='';status.hidden=!selected;
    document.querySelectorAll('[data-freight-platform]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.freightPlatform===id)));
    if(!selected)return;
    if(!selected.available){status.textContent=selected.label+'待开通，暂不提供导入提示词或 Skill。';return;}
    status.innerHTML=loadingMarkup({variant:'inline',brand:'五成电子商务工作台',subtitle:'云仓运费导入',status:'正在读取菜鸟云仓 Skill…',logo:'./loading-logo.png'});
    try{
      const loaded=files||await Promise.all(skillFiles.map(async name=>{const response=await fetch(new URL(name,skillBase));if(!response.ok)throw Error('Skill 文件读取失败，请重试。');return {name,text:await response.text()};}));
      if(request!==generation||!alive())return;
      files=loaded;update();status.hidden=true;status.innerHTML='';ready.hidden=false;button.disabled=false;
    }catch(e){if(request===generation&&alive()){status.hidden=true;status.innerHTML='';error.textContent=e.message;retry.hidden=false;}}
  };
  document.querySelectorAll('[data-freight-platform]').forEach(b=>b.onclick=()=>choose(b.dataset.freightPlatform));
  retry.onclick=()=>choose('warehouse');
}
