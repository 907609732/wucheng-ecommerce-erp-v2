// Keep historical failures while releasing only the exact, verified background job.
import {agentDigest} from './approval.mjs';

const successful=new Set(['completed','done','succeeded']);
const recoverable=new Set(['OCR_JOB_INCOMPLETE','BACKGROUND_PROCESSING','BACKGROUND_NEEDS_ACTION','BACKGROUND_QUERY_FAILED','EXPORTER_HOST_ACTION_REQUIRED','EXPORTER_JOB_WAIT_TIMEOUT','EXPORTER_JOB_INCOMPLETE']);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=500;

function issueModule(issue){
  if(typeof issue.module==='string')return issue.module;
  // Earlier persisted results did not tag issues with their adapter. Only known
  // protocol namespaces can recover that identity; unqualified issues stay open.
  if(issue.code==='OCR_JOB_INCOMPLETE'&&issue.id==='purchase:ocr:'+issue.jobId)return 'purchase';
  if(typeof issue.code==='string'&&issue.code.startsWith('EXPORTER_'))return 'exporter';
  if(typeof issue.queryCapability==='string'&&/^(sales|overview)\.cainiao-job$/.test(issue.queryCapability))return issue.queryCapability.split('.')[0];
  return null;
}

export function reconcileJobIssues(previous,output,{module,capabilityId,now}){
  const issues=Array.isArray(output.issues)?output.issues:[],completed=new Map();
  for(const evidence of output.evidence||[]){
    if(!id(evidence?.jobId)||evidence.module&&evidence.module!==module||!successful.has(evidence.status))continue;
    if(issues.some(issue=>issue.blocking===true&&(!issue.jobId||issue.jobId===evidence.jobId)))continue;
    const job=(output.blocks||[]).find(block=>block?.type==='job'&&block.jobId===evidence.jobId&&block.status===evidence.status);
    // Explicit completeness is emitted by OCR/exporter. Download adapters emit
    // matching job+evidence only after their source/verification checks succeed.
    if(evidence.complete!==true&&(!job||evidence.complete===false))continue;
    completed.set(evidence.jobId,{jobId:evidence.jobId,module,capabilityId,status:evidence.status,evidenceDigest:agentDigest(evidence),at:now});
  }
  return [
    ...(previous||[]).map(issue=>{
      const resolution=id(issue.jobId)&&issueModule(issue)===module&&recoverable.has(issue.code)&&issue.blocking===true?completed.get(issue.jobId):null;
      return resolution?{...issue,module,blocking:false,originalBlocking:true,resolved:true,resolution}:issue;
    }),
    ...issues.map(issue=>({...issue,module}))
  ];
}
