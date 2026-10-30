// Public business contracts mirror agent-actions and the owning domain validators.
// Identity, approvals, filesystem paths and internal commit data never belong in model input.
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const text=(description,maxLength=200,minLength=1)=>({type:'string',minLength,maxLength,description});
const enumeration=(values,description)=>({type:'string',enum:values,description});
const id=text('真实查询结果中的记录标识；不能填写本机路径',200);
const shopId=text('已登记的真实店铺ID；先通过sales.shops查询，不能用店名代替');
const shopFilter={...text('真实店铺ID或all；all表示全部店铺'),default:'all'};
const reason={...text('本次修改、删除、匹配或作废的真实业务依据',500),pattern:'\\S'};
const month={type:'string',pattern:'^20[0-9]{2}-(0[1-9]|1[0-2])$',description:'自然月份，格式YYYY-MM，例如2026-09'};
const year={type:'string',pattern:'^20[0-9]{2}$',description:'年份字符串，格式YYYY，例如2026'};
const date={type:'string',pattern:'^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',description:'业务日期YYYY-MM-DD；日历有效性仍由账本核对'};
const grain={...enumeration(['day','month','year'],'统计粒度：日、月、年；必须与period格式一致'),default:'month'};
const money=(description='金额，单位为元；使用最多两位小数的十进制字符串，禁止浮点分与科学计数法',signed=true)=>({type:'string',pattern:signed?'^-?[0-9]+(?:\\.[0-9]{1,2})?$':'^[0-9]+(?:\\.[0-9]{1,2})?$',maxLength:20,description});
const currency={...enumeration(['CNY','RUB','USD','EUR'],'原币代码；不同币种保留真实原币，不擅自换算'),default:'CNY'};
const version={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'最近一次读取的记录version；版本变化时必须重新读取'};
const revision={type:'string',pattern:'^[a-f0-9]{64}$',description:'对应预览接口返回的SHA-256修订指纹，原样传回；不得自行生成'};
const count={type:['integer','null'],minimum:0,maximum:Number.MAX_SAFE_INTEGER,description:'非负整数笔数或件数；未取得的数据用null，不补零'};
const cents=(description,sign='any')=>({type:['integer','null'],minimum:sign==='positive'?0:-Number.MAX_SAFE_INTEGER,maximum:sign==='negative'?0:Number.MAX_SAFE_INTEGER,description});
const flag={enum:[true,false,'0','1'],description:'已核实的布尔标记；兼容原业务表单0/1字符串'};
const ledgerKinds=['sale','refund','settlement','receipt','expense','platform_flow','transfer','withdrawal','recharge','deposit'];
const datasets=['operations','settlement','receipt','expense'];
const recordId=object({id},['id']);
const monthInput=object({month},['month']);
const backupName={type:'string',minLength:1,maxLength:160,pattern:'^[A-Za-z0-9_-][A-Za-z0-9_.-]*$',description:'sales.backups或sales.backup返回的备份名称；只能是名称，不接受目录路径'};
const fileRef=object({id:{type:'string',pattern:'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$',description:'sales.file-stage返回的原件ID，仅可用于同一人员、同一任务'}},['id']);
const extensionPattern=extensions=>extensions.map(extension=>[...extension].map(c=>/[a-z]/.test(c)?`[${c}${c.toUpperCase()}]`:c).join('')).join('|');
function inlineFile(extensions=['csv','tsv','xlsx','xls','zip','pdf','png','jpg','jpeg','webp']){
 return object({filename:{type:'string',minLength:1,maxLength:255,pattern:'^[^/:\\\\\\x00-\\x1f]+\\.(?:'+extensionPattern(extensions)+')$',description:'原始文件名和扩展名；保留官方名称，不接受绝对或相对路径'},
  dataBase64:{type:'string',minLength:4,maxLength:34952536,pattern:'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',description:'完整原件的标准Base64，不含data:前缀；解码后最多25MiB'},
  sha256:{type:'string',pattern:'^[a-f0-9]{64}$',description:'原件字节的SHA-256小写十六进制；由可信文件读取计算'}},['filename','dataBase64','sha256']);
}
const managedFile=extensions=>({description:'优先填写同任务暂存原件{id}；兼容传入filename、dataBase64、sha256完整原件',oneOf:[fileRef,inlineFile(extensions)]});
function periodInput(properties={},required=['period']){
 return {...object({period:{type:'string',description:'与grain一致：日YYYY-MM-DD、月YYYY-MM、年YYYY'},grain,...properties},required),oneOf:[
  {properties:{period:month,grain:{const:'month'}}},
  {properties:{period:date,grain:{const:'day'}},required:['grain']},
  {properties:{period:year,grain:{const:'year'}},required:['grain']}
 ]};
}
const movementFilters={shop_id:shopId,month,from:date,to:date,q:text('主订单号或部分编号；淘宝也匹配子订单号',100,0),direction:enumeration(['income','expense'],'只筛选收入或支出；省略表示全部'),category:text('真实查询返回的业务分类名称；省略表示全部分类',150),batch_id:{...id,description:'导入批次ID，用于按原件筛选'},sort:{...enumeration(['occurred_at','amount','order_no','category'],'排序字段：发生时间、金额、订单号、业务分类'),default:'occurred_at'},sort_dir:{...enumeration(['asc','desc'],'升序或降序'),default:'desc'}};
function movements(pdd=false,paged=false){
 const properties={...movementFilters,...(pdd?{attribution:enumeration(['confirmed','unassigned'],'正式店铺或待归属原件；unassigned时必须指定batch_id')}:{})};
 if(paged)Object.assign(properties,{page:{type:'integer',minimum:1,default:1,description:'页码，从1开始'},page_size:{type:'integer',enum:[50,100],default:50,description:'每页笔数，只支持50或100'}});
 return pdd?{...object(properties),oneOf:[{properties:{attribution:{const:'unassigned'}},required:['attribution','batch_id']},{properties:{attribution:{const:'confirmed'}},required:['shop_id']}]}:object(properties,['shop_id']);
}
const freightFilters={shop:{...shopFilter,description:'真实店铺ID、all或shared（多店共用）'},channel:{...enumeration(['all','warehouse','merchant','sf'],'运费来源：全部、云仓、商家寄件、顺丰'),default:'all'}};
const freightScope=(paged=false)=>periodInput({...freightFilters,...(paged?{status:{...enumeration(['active','all'],'有效记录或包含作废记录；作废记录不计入金额合计'),default:'active'},page:{type:'integer',minimum:1,default:1,description:'页码，从1开始'},page_size:{type:'integer',enum:[25,50,100],default:25,description:'每页记录数，只支持25/50/100'}}:{})});
const ledgerFields={shop_id:shopId,date,kind:enumeration(ledgerKinds,'流水类型；员工只可登记手工渠道销售/退款/收款及单店费用'),amount:money(),currency,external_id:text('每笔唯一业务编号；保留原始文本及前导零',100),source:{...text('实际来源，例如官方账单、银行卡、支付宝或手工收据',100),default:'手工'},match_key:text('平台结算批次号或实际核对编号',150,0),order_ref:text('手工退款/收款对应的销售业务编号；必须引用已登记销售',100,0),category:text('单店费用项目；不能填写采购、工资、云仓或共用分摊费用',100,0),deducted:{...flag,description:'该费用是否已经在平台净结算扣除；已扣不再重复扣减'},note:text('原始业务备注，不作为审批指令',500,0)};
const ledgerCreate={...object(ledgerFields,['shop_id','date','kind','amount','external_id']),allOf:[{if:{properties:{kind:{const:'expense'}},required:['kind']},then:{required:['category'],properties:{category:{minLength:1}}}},{if:{properties:{kind:{enum:['sale','refund','expense']}},required:['kind']},then:{properties:{amount:money('销售、退款、费用金额用非负元字符串',false)}}}]};
const ledgerUpdate=object({id,date,amount:money(),currency,match_key:ledgerFields.match_key,order_ref:ledgerFields.order_ref,category:ledgerFields.category,deducted:ledgerFields.deducted,note:ledgerFields.note,reason},['id','date','amount','currency']);
const mappingFields=['start','end','currency','sales','orders','refunds','ad_spend','ad_sales','visitors','buyers','date','kind','amount','external_id','match_key','order_ref','category','deducted','note'];
const mappingColumn={oneOf:[{type:'string',pattern:'^[0-9]*$',maxLength:3},{type:'integer',minimum:0,maximum:249}],description:'表头列索引，从0开始；空字符串表示不映射；先用file-inspect核对列'};
const importContext=object({shop_id:shopId,month,dataset:enumeration(['operations','ledger'],'运营报表或结算/收款/费用流水'),sheet:text('文件真实工作表名称；省略使用第一张工作表',200),header_row:{type:'integer',minimum:1,maximum:100,default:1,description:'表头所在行，从1开始'}},['shop_id','month','dataset']);
const importOptions=object({mapping:object(Object.fromEntries(mappingFields.map(field=>[field,mappingColumn]))),source:text('原报表的真实来源名称',100),definition:text('运营指标口径及广告归因范围；导入运营报表时必填',500),compatible:{...flag,description:'已核实访客/买家范围和广告归因窗口可比；未核实必须为false'},default_kind:enumeration(ledgerKinds,'流水没有类型列时采用的真实默认类型'),default_currency:currency},['mapping','source']);
const genericImport={...object({file:managedFile(['csv','tsv','xlsx']),context:importContext,options:importOptions},['file','context','options']),allOf:[{if:{properties:{context:{properties:{dataset:{const:'operations'}},required:['dataset']}},required:['context']},then:{properties:{options:{required:['definition']}}}}]};
const freightFields={channel:enumeration(['warehouse','merchant','sf'],'云仓、商家寄件或顺丰；共用费用不拆分到店'),entry_mode:enumeration(['month','day','single'],'按月汇总、按日汇总或单笔寄件'),period:{type:'string',description:'费用归属期间；month填写YYYY-MM，day/single填写YYYY-MM-DD'},shop_id:{...text('商家寄件必须填真实店铺ID；云仓省略或填shared；顺丰可归店或共用',200,0)},shipping:money('快递运费，非负元字符串',false),packing:money('打包费，仅云仓可填，非负元字符串',false),materials:money('耗材费，仅云仓可填，非负元字符串',false),storage:money('仓储费，仅云仓可填，非负元字符串',false),other:money('其他费用或赔付抵扣，元字符串；负数只用于有依据的抵扣'),other_note:text('其他费用或赔付抵扣用途；other非零时必须填写',500,0),pieces:count,bill_no:text('官方账单编号，保留文本与前导零',100,0),tracking_no:text('快递运单编号，保留完整文本',100,0),note:text('运费业务说明或原件对应关系',500,0),files:{type:'array',maxItems:5,items:managedFile(['png','jpg','jpeg','webp','pdf','xlsx','xls','csv']),description:'原始凭证，最多5份；同任务file-stage ID或完整原件'}};
function freightWrite(update=false){
 return {...object({...freightFields,...(update?{id,version,remove_attachments:{type:'array',uniqueItems:true,maxItems:5,items:id,description:'需移除的现有附件ID；仅移除关联，不销毁原件历史'}}:{})},['channel','entry_mode','period','shipping',...(update?['id','version']:[])]),allOf:[
  {if:{properties:{entry_mode:{const:'month'}},required:['entry_mode']},then:{properties:{period:month}},else:{properties:{period:date}}},
  {if:{properties:{channel:{const:'merchant'}},required:['channel']},then:{required:['shop_id'],properties:{shop_id:{minLength:1,not:{const:'shared'}}}}},
  {if:{properties:{channel:{const:'warehouse'}},required:['channel']},then:{properties:{shop_id:{enum:['','shared']}}}},
  {if:{properties:{other:{not:{pattern:'^-?0(?:\\.0{1,2})?$'}}},required:['other']},then:{required:['other_note'],properties:{other_note:{minLength:1,pattern:'\\S'}}}}
 ]};
}
const definitions=[];
const query=(name,title,description,inputSchema=object())=>definitions.push({name,title,description,inputSchema,kind:'query',requiresReview:false});
const prepare=(name,title,description,inputSchema=object(),requiresReview=true)=>definitions.push({name,title,description,inputSchema,kind:'prepare',requiresReview});

query('shops','查询店铺列表','读取销售台真实店铺ID、名称、平台及手工渠道标记。');
query('task-center','查看月度任务','读取指定月份的角色化任务、资料准备条件及员工交接版本。',monthInput);
query('manual-summary','查看手工渠道应收','读取线下与代发店铺的跨月应收及实际收款摘要。',object({month,shop:shopFilter},['month']));
query('sources','查看店铺数据覆盖','读取指定月份各店原件来源及已核对状态，缺失数据不按零处理。',monthInput);
query('history-coverage','查看历史覆盖进度','读取2025年起各月数据覆盖数量和锁定状态。');
query('report','查看经营月报','读取按真实原币和数据覆盖生成的日/月/年经营与对账报告；所有已登录人员。',periodInput({shop:shopFilter,empty_trend:enumeration(['skip'],'仅在无经营数据时跳过趋势计算')}));
query('reconciliation','查看结算收款匹配','读取指定店铺截至月末的结算、到账、剩余未匹配及候选关系；所有已登录人员。',object({month,shop:shopFilter},['month']));
query('ledger','查询业务流水','读取指定月份范围的账本流水；员工只读取允许的手工与单店费用记录。',object({month,shop:shopFilter},['month']));
query('imports','查看导入批次','读取最近200个实际导入批次、归属和原件摘要，不隐含翻页或自动采集。');
query('original','下载导入原件','以真实导入批次ID下载对应原始文件，返回受控文件标识。',recordId);
query('file-inspect','检查报表列名','读取CSV/TSV/XLSX的工作表、表头及前5行，供导入前建立真实字段映射。',object({file:managedFile(['csv','tsv','xlsx']),sheet:text('真实工作表名称；省略采用第一张',200),header_row:{type:'integer',minimum:1,maximum:100,default:1,description:'表头所在行，从1开始'}},['file']));
for(const [platform,label]of [['taobao','淘宝'],['pdd','拼多多']]){
 query(platform+'-funds','查看'+label+'资金汇总','读取所选店铺和期间官方账户流水收支，不当作销售额或利润。',periodInput({shop_id:shopId},['period','shop_id']));
 query(platform+'-statement','查看'+label+'年度月表','读取单店年度官方账单月表、文件范围和参考核对状态；日期覆盖不等同人工核对。',object({year,shop_id:shopId},['year','shop_id']));
 query(platform+'-movements','查询'+label+'逐笔流水','按店铺、期间、原件、收支及订单号查询真实逐笔流水，支持固定分页。',movements(platform==='pdd',true));
 query(platform+'-movement','查看'+label+'流水原文','以真实流水ID和所属店铺查询原始备注及来源行号，防止跨店误读。',platform==='pdd'?{...object({id,shop_id:shopId,attribution:enumeration(['confirmed','unassigned'],'正式店铺或待归属原件'),batch_id:id},['id']),oneOf:[{properties:{attribution:{const:'unassigned'}},required:['attribution','batch_id']},{properties:{attribution:{const:'confirmed'}},required:['shop_id']}]}:object({id,shop_id:shopId},['id','shop_id']));
 query(platform+'-export','导出'+label+'筛选流水','导出全部符合筛选条件的逐笔流水，保持订单号文本，不限当前页面。',movements(platform==='pdd'));
}
query('pdd-unassigned','查看拼多多待归属账单','读取尚未确认所属店铺的原件；这些记录不计入正式店铺汇总。');
query('freight-report','查看运费汇总','按费用归属期间统计云仓、商家寄件和顺丰；共用费用单列，不再次扣资金对账。',freightScope());
query('freight-records','查询运费明细','读取筛选期间的运费记录与有效或作废状态，使用25/50/100条固定分页。',freightScope(true));
query('freight-record','查看单笔运费','读取实际运费记录、当前版本、原件关联及移除历史。',recordId);
query('freight-attachment','下载运费原件','按真实运费附件ID下载原件，并返回可核验的文件摘要。',recordId);
query('freight-export','导出运费台账','导出全部符合期间、店铺及渠道筛选的运费明细，原件标识保留。',periodInput({...freightFilters,status:enumeration(['active','all'],'有效记录或包含作废记录，作废不计汇总')}));
query('close-preview','检查月份锁定预览','读取本月现状、缺口与最新revision；锁定前必须重新核对。',monthInput);
query('close-history','查看锁定修订历史','读取最近100条锁定与明确解锁记录，保留原始修订依据。');
query('audit','查看业务审计','读取最近200条真实业务审计记录；所有已登录人员可查看。');
query('jobs','查看月报生成任务','读取最近100个月报生成任务；生成草稿不表示已经取得完整数据。');
query('job-report','下载已生成月报','以真实任务ID下载已生成月报；下载历史文件不证明当前资料完整。',recordId);
query('report-history','查看历史月报状态','读取归属纠正等变更前保留的历史报表状态，供追溯使用。');
query('export','导出经营与对账Excel','按期间及店铺导出经营与资金账本，缺失标记保留；所有已登录人员。',periodInput({shop:shopFilter}));
query('template','下载业务导入模板','下载运营或资金流水CSV列模板；仍需映射实际原件字段。',object({type:enumeration(['operations','ledger'],'运营或资金流水模板')},['type']));
query('backups','查看一致性备份','读取已存在的本机备份名称、创建时间与用途，不提供任意路径访问。');
query('backup-verify','验证备份完整性','核验已登记备份中数据库与原件摘要，不恢复、不覆盖正式账本。',object({name:backupName},['name']));
query('rates','查看已保存汇率','读取账本保留的日期、币种、官方参考汇率及原始来源摘要。');
query('skill','读取云仓运费操作指引','读取随销售台发布的云仓运费导入技能及支持范围，不触发下载或入账。');
query('cainiao-status','查看菜鸟连接状态','查询菜鸟云仓连接及可用账户状态，不确认平台结算。');
query('cainiao-jobs','查看菜鸟账单任务','查询已启动的云仓逐月账单下载任务及实际执行状态。');
query('cainiao-job','查看菜鸟任务详情','按真实jobId读取单次下载任务的进度和错误信息。',object({jobId:id},['jobId']));
query('cainiao-preview','预览云仓月账费用','核对任务指定月份的官方费用、赔付抵扣及将要登记的运费。',object({jobId:id,month},['jobId','month']));
query('cainiao-file','下载菜鸟账单原件','按下载任务返回的fileId读取已登记官方原件，不接受本机路径。',object({fileId:id},['fileId']));

prepare('shop-create','登记真实店铺','准备创建已确认平台与名称的店铺；预演与复核后才正式写入。',object({platform:enumeration(['淘宝','拼多多','京东','闲鱼','抖店','Ozon','线下','代发'],'真实业务平台'),name:{...text('已确认的完整店铺名称',80),pattern:'\\S'}},['platform','name']));
prepare('shop-delete','删除无记录店铺','仅准备删除无业务记录、原件及锁定历史的店铺；必须准确复核店铺名称。',object({id,name:text('查询返回的完整店铺名称，必须完全一致',80)},['id','name']));
prepare('ledger-create','登记业务流水','准备新增手工销售、退款、收款或单店费用；金额为元字符串，收款不重复计收入。',ledgerCreate);
prepare('ledger-update','更正手工流水','准备更正非导入流水；店铺、类型、来源和原业务编号保持原记录，关联关系由账本校验。',ledgerUpdate);
prepare('ledger-delete','删除手工流水','准备删除允许删除的手工流水并保留原因；导入记录必须走批次撤销。',object({id,reason},['id','reason']));
prepare('match-create','核对结算与实际收款','准备同店铺结算与实际到账的分配；分次、合并及跨币种必须有实际核对依据。',object({left_id:{...id,description:'平台净结算流水ID'},right_id:{...id,description:'实际收款流水ID'},left_amount:money('分配的结算金额，结算原币元字符串'),right_amount:money('分配的到账金额，收款原币元字符串'),reason},['left_id','right_id','left_amount','right_amount','reason']));
prepare('match-delete','撤销资金匹配','准备撤销一条已登记的结算收款分配，必须保留实际修订依据。',object({id,reason},['id','reason']));
prepare('coverage','登记数据核对结果','按店铺和月份准备完整度核对；只有真实整月证据才能标full，资金核对所有已登录人员。',object({shop_id:shopId,month,dataset:enumeration(datasets,'经营、平台结算、实际收款或单店费用'),status:enumeration(['missing','partial','full'],'未取得、部分待核对或整月已核对；真实零也需要证据'),evidence:reason},['shop_id','month','dataset','status','evidence']));
prepare('import','导入实际业务报表','以原件、目标月份及明确列映射预演通用导入，校验和去重通过后复核入账。',genericImport);
const taobaoFile=inlineFile(['csv']);taobaoFile.properties.filename={...taobaoFile.properties.filename,pattern:'^交易货款_(20[0-9]{2})(0[1-9]|1[0-2])_\\1\\2\\.csv$',description:'必须保留官方同月文件名：交易货款_YYYYMM_YYYYMM.csv'};
prepare('taobao-import','导入淘宝官方货款','预演淘宝单月官方交易货款CSV；保留账期、子订单、退款与原件，不当作支付销售额。',object({shop_id:shopId,file:{description:'同任务暂存原件{id}或保留官方中文文件名的完整CSV',oneOf:[fileRef,taobaoFile]}},['shop_id','file']));
prepare('pdd-import','导入拼多多官方账单','预演官方账务ZIP及尾部笔数金额；明确店铺，来源未确认时用__unassigned__仅留存。',object({shop_id:{...shopId,description:'已登记拼多多店铺ID；尚未确认所属店铺时填__unassigned__'},file:managedFile(['zip'])},['shop_id','file']));
prepare('import-rollback','撤销已导入批次','准备撤销指定导入批次并保留原件与审计；已有匹配或锁定月份不能直接撤销。',object({id,reason},['id','reason']));
prepare('batch-attribution','确认账单所属店铺','准备确认或取消整批拼多多账单归属；锁定月份和重复流水仍由账本阻止。',{...object({id,status:enumeration(['confirmed','unassigned'],'确认所属店铺或移入待归属区'),shop_id:shopId,reason},['id','status','reason']),allOf:[{if:{properties:{status:{const:'confirmed'}},required:['status']},then:{required:['shop_id']}}]});
prepare('pdd-reference','登记平台截图对照','准备拼多多平台截至日参考；金额使用整数分，参考不生成资金流水也不自动完成核对。',object({shop_id:shopId,month,cutoff:{type:'string',pattern:'^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]) 23:59:59$',description:'本月平台参考截至时间，格式YYYY-MM-DD 23:59:59'},income:cents('平台参考收入，单位分，非负；未取得用null','positive'),expense:cents('平台参考支出，单位分，非正；未取得用null','negative'),income_count:count,expense_count:count,opening_balance:cents('平台参考期初余额，单位分；未取得用null'),closing_balance:cents('平台参考期末余额，单位分；未取得用null'),file:managedFile(['png','jpg','jpeg','webp']),evidence_name:text('没有图片时填写人工参考来源名称',200),note:text('平台截图依据及范围说明',500,0)},['shop_id','month','cutoff']));
prepare('freight-create','登记运费及赔付抵扣','准备登记真实运费及凭证；只有云仓可填附加费，赔付以other负数登记并说明用途。',freightWrite());
prepare('freight-update','更正运费记录','准备按最近version更正运费和附件；保留移除历史，禁止覆盖已锁定或已作废记录。',freightWrite(true));
prepare('freight-void','作废运费记录','准备将运费标记作废并保留真实原因和原件，版本过期时拒绝操作。',object({id,version,reason},['id','version','reason']));
prepare('month-lock','确认并锁定月份','使用最新月份预览revision准备锁定已结束月份；缺失标记保留，所有后续改动受锁定保护。',object({month,revision},['month','revision']));
prepare('month-unlock','明确解锁历史月份','准备按实际修订原因解锁月份，原锁定快照和历史继续保留。',object({month,reason},['month','reason']));
prepare('rates-refresh','补齐官方参考汇率','按本月外币实际业务日期预演补齐参考汇率；不将参考汇率冒充最终实际到账。',monthInput);
prepare('job-create','检查并生成月报','准备检查指定月份已保存资料并生成月报草稿；有缺口不表示已采集或已完整核对。',object({period:month},['period']));
prepare('staff-handoff','提交资料等待老板','员工使用任务摘要staffRevision准备提交本月已就绪资料；提交不等于老板资金审核完成。',object({month,revision:{...revision,description:'本月任务摘要的staffRevision，原样传回；资料变化必须重新读取'}},['month','revision']));
prepare('backup','创建并验证备份','创建一致性备份并核对完整性，返回受控ZIP下载；不修改正式财务业务数据。',object(),false);
prepare('restore-copy','恢复备份为独立副本','准备将已验证备份恢复到新的独立副本，绝不覆盖正在使用的正式账本。',object({name:backupName},['name']));
prepare('file-stage','暂存任务原件','校验原始文件字节和SHA-256并保存为同人员同任务原件；不入账、不改变财务数据。',object({file:inlineFile()},['file']),false);
prepare('cainiao-connect','连接菜鸟云仓','打开或复用本机菜鸟账单连接，仅建立下载环境，不入账或确认结算。',object(),false);
prepare('cainiao-disconnect','断开菜鸟连接','停止复用菜鸟账单连接，不清除其他浏览器账号或历史账单。',object(),false);
prepare('cainiao-download-start','逐月下载菜鸟账单','按真实账户和月份范围下载官方云仓账单，留存原件；下载不表示已入账。',object({account:text('连接状态返回的真实账户标识，不接受密码或cookie',100),from:month,to:{...month,description:'结束月份（含）；省略时仅处理from月份'},cutoff:{...date,description:'包含当前月时必须明确业务数据截止日，属于当前月且不能晚于北京时间昨天'},cutoffs:{...object(),patternProperties:{'^20[0-9]{2}-(0[1-9]|1[0-2])$':date},description:'按月份明确截止日；当前月键优先于cutoff，日期上限仍由实际业务校验'},force:{type:'boolean',default:false,description:'是否重新下载已有原件；不自动覆盖已入账费用'}},['account','from']),false);
for(const [name,title,description]of [['cainiao-download-stop','停止菜鸟下载','停止指定真实账单下载任务，保留已经下载的官方原件。'],['cainiao-download-resume','继续菜鸟下载','继续指定可恢复的逐月账单下载任务，不重复确认资金结算。']])prepare(name,title,description,object({jobId:id},['jobId']),false);
prepare('cainiao-posting','复核云仓运费入账','对指定任务月份的官方账单费用及赔付抵扣预演，中央复核后登记销售台运费。',object({jobId:id,month},['jobId','month']));

query('personnel-state','核对本人销售领域身份','读取当前真实登录人员的领域绑定及可明确选择的历史人员；不按姓名推断身份。',object());
query('cainiao-archive-preview','检查总览交接原件','按本任务销售交接标识重新校验原件、范围、分类、重复及锁定状态，不创建采集任务。',object({handoffId:revision},['handoffId']));
prepare('cainiao-archive-posting','复核总览原件运费入账','仅对已重新暂存并验证的本任务总览原件准备运费入账，保留原件关系并由实际人员复核。',object({handoffId:revision},['handoffId']));
const archivedSource=object({fileId:id,report:enumeration(['transactions','fees','warehouse'],'归档文件的已核实导出角色'),filename:text('原件名',255),sha256:revision,bytes:{type:'integer',minimum:1,maximum:52428800},from:date,cutoff:date,expected:object({count:{type:['integer','null'],minimum:0},amountCents:{type:['integer','null']}},['count','amountCents']),verification:object({verified:{const:true}},['verified'])},['fileId','report','filename','sha256','bytes','from','cutoff','expected','verification']);
prepare('cainiao-archive-adopt','内部可信原件接收','仅供主机可信桥重新暂存总览产物；不对模型暴露来源清单或原件传输协议。',object({manifestDigest:revision,manifest:object({version:{const:1},jobId:id,month,account:text('来源账户',200),basis:{const:'业务时间'},from:date,cutoff:date,files:{type:'array',minItems:2,maxItems:20,items:archivedSource}},['version','jobId','month','account','basis','from','cutoff','files']),files:{type:'array',minItems:2,maxItems:20,items:object({id,artifactId:id,filename:text('原件名',255),sha256:revision,sourceModule:{const:'overview'},sourceCapabilityId:{const:'overview.cainiao-file'},report:enumeration(['transactions','fees','warehouse'],'实际来源角色')},['id','artifactId','filename','sha256','sourceModule','sourceCapabilityId','report'])}},['manifestDigest','manifest','files']),false);
prepare('personnel-link','本人确认销售领域身份','仅由当前真实人员确认选中的领域人员ID或新建稳定身份；重名必须明确选择，中央复核后保存，只记录业务身份归属。',object({domainPersonId:{...id,description:'personnel-state返回的候选ID或newPersonId，不接受姓名代替'},displayName:text('本人明确确认的姓名；历史姓名不明时不能由模型猜测',80),reason,revision},['domainPersonId','displayName','reason','revision']));
export const salesCapabilityDefinitions=Object.freeze(definitions.map(definition=>Object.freeze(definition)));
const schemas=new Map(salesCapabilityDefinitions.map(definition=>['sales.'+definition.name,definition.inputSchema]));
export function schemaFor(capabilityId){const schema=schemas.get(capabilityId.startsWith('sales.')?capabilityId:'sales.'+capabilityId);if(!schema)throw Error('销售能力缺少明确输入Schema：'+capabilityId);return schema;}
