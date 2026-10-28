const operations = new Set(['status','tasks.list','tasks.create','tasks.get','tasks.input','tasks.control','reviews.approve','reviews.reject','schedules.list','schedules.create','schedules.update','schedules.delete','settings.get','settings.save','permissions.get','permissions.save','connection.get','connection.check','connection.plan','connection.save','attachments.upload','artifacts.open']);

/** The host supplies authenticated identity; the renderer never supplies an actor. */
export function createAgentApi(invoke = globalThis.window?.launcher?.agentRequest) {
  return {
    async request(operation, payload = {}) {
      if (!operations.has(operation)) throw new Error('未支持的工作台操作');
      if (typeof invoke !== 'function') throw Object.assign(new Error('当前窗口尚未连接 Agent 服务，请检查公司主机连接。'), {code:'AGENT_BRIDGE_UNAVAILABLE'});
      const result = await invoke({operation, payload});
      if (result?.ok === false) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : result.message || '本次操作未完成'), {code:result.code || 'AGENT_REQUEST_FAILED'});
      return result?.ok === true && Object.hasOwn(result, 'data') ? result.data : result;
    }
  };
}

export const taskStates = Object.freeze({queued:'等待执行',running:'执行中',waiting_input:'需要补充',waiting_review:'待复核',committing:'正在提交',unknown:'核对提交状态',paused:'已暂停',completed:'已完成',failed:'未完成',cancelled:'已停止'});
export const moduleLabels = Object.freeze({warehouse:'云仓',exporter:'订单导出',purchase:'采购',sales:'销售',overview:'经营总览'});

export function betaServerUrl(value) {
  let url;try{url=new URL(String(value).trim());}catch{throw new Error('请填写有效的公司主机地址');}
  if(url.protocol!=='https:' || url.port!=='9443')throw new Error('测试版公司主机地址必须使用 HTTPS 和 9443 端口，请向管理员获取测试版地址。');
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/')throw new Error('请填写完整的公司主机地址，不包含账号、路径或查询参数。');
  return url.origin;
}

export function scheduleCron(frequency, time, custom = '') {
  if (frequency === 'custom') return custom.trim();
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('请选择有效的执行时间');
  const suffix = {daily:'* * *',weekdays:'* * 1-5',weekly:'* * 1',monthly:'1 * *'}[frequency];
  if (!suffix) throw new Error('请选择执行频率');
  return `${Number(match[2])} ${Number(match[1])} ${suffix}`;
}

export function reviewBinding(detail) {
  const review = detail?.review;
  if (!review?.id || !detail?.task?.id || review.resultVersion == null || review.revision == null) return null;
  if (detail.result?.version !== review.resultVersion) return null;
  return {taskId:detail.task.id,reviewId:review.id,resultVersion:review.resultVersion,revision:review.revision};
}
