/**
 * 千牛取账编排：观察 → 决策 → 动作，直到每个账单类型都收到可校验的文件，或明确转人工。
 *
 * 硬规则：
 * - 同店、同账期、同账单类型防重复；失败项单独重试。
 * - 所有店铺的取账任务全局串行，避免争用鼠标、窗口或同一登录会话。
 * - 每次取账、切店、请求导出前都核对店铺；不能确认立即停止，绝不串店。
 * - 登录失效、验证码、页面不匹配 → 停止重试，转“待人工处理”。
 * - 网络/排队/超时 → 有上限的退避重试。
 * - 打开页面或点击导出都不算成功，只有通过校验的下载文件才算。
 */
import { BILL_KINDS, completeness, extractShardHints, planShards } from './finance-bills.mjs';
import { detectState, findExportCenterEntry, parseExportRows, planStep, verifyShopIdentity } from './finance-page.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_KINDS = ['income', 'expense', 'tax'];
const envMs = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; };

/** 需要人工接管的状态：停止自动重试，等待用户处理后继续。 */
export const MANUAL_STATES = new Set(['needs_login', 'needs_captcha', 'needs_shop_review', 'needs_manual']);
/** 可自动退避重试的状态。 */
export const RETRY_STATES = new Set(['timeout', 'query_failed']);

export function overallState(items) {
  const states = items.map(item => item.state);
  if (states.includes('cancelled')) return 'cancelled';
  if (states.some(state => MANUAL_STATES.has(state))) return 'needs_review';
  if (states.some(state => state === 'failed')) return 'failed';
  if (items.length && states.every(state => state === 'empty')) return 'empty';
  if (items.length && states.every(state => ['received', 'empty'].includes(state))) return 'received';
  return 'partial';
}

export class FinanceRpa {
  /**
   * @param {object} options
   * @param {(operation:string, ...args:any[])=>Promise<any>} options.call 账本调用（在 worker 中执行）
   * @param {object} options.browser createFinanceBrowser 的返回值
   * @param {(line:string, level?:string)=>void} [options.log]
   */
  constructor({ call, browser, log = () => {}, exportTimeoutMs, pollIntervalMs }) {
    this.call = call;
    this.browser = browser;
    this.log = log;
    this.chain = Promise.resolve();
    this.cancelled = new Set();
    this.running = new Map();
    // 同步下载等待时间与导出中心轮询间隔；可用环境变量在不改代码的情况下调整。
    this.exportTimeoutMs = exportTimeoutMs || envMs('FINANCE_EXPORT_TIMEOUT_MS', 45000);
    this.pollIntervalMs = pollIntervalMs || envMs('FINANCE_POLL_INTERVAL_MS', 3000);
  }

  /** 全局串行执行：同一时刻只有一个店铺的取账任务在动。 */
  serialize(task) {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  cancel(shopId) { this.cancelled.add(shopId); this.browser.cancelIntent(shopId); }

  isRunning(shopId) { return this.running.has(shopId); }

  progress(payload) {
    try { this.log(`${payload.shopName || payload.shopId} · ${payload.month} · ${payload.message}`, payload.level || 'info'); } catch { /* 日志失败不影响任务 */ }
  }

  async #snapshot(shop, month, jobId) {
    return this.browser.snapshot(shop.id);
  }

  /** 等待页面可判定：直到能识别出登录/验证码/正常状态，或超时。 */
  /**
   * 等待页面进入可用状态。
   * 必须同时满足「地址已经是本店账单页」：上一次取账可能把窗口留在了导出记录等子页面，
   * 重新取账时重载还没提交，光看文本长度和元素数量会把旧页面误判成就绪，
   * 接着店铺核对就会在错误的页面上失败。
   */
  async #waitReady(shop, month, jobId, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    const wanted = this.#wantedLocation(shop);
    let last = null;
    let foreign = null;
    while (Date.now() < deadline) {
      if (this.cancelled.has(shop.id)) return { state: 'cancelled', message: '任务已取消' };
      const snapshot = await this.#snapshot(shop, month, jobId);
      const detected = detectState(snapshot);
      last = { snapshot, detected };
      if (detected.state !== 'ok') return { state: detected.state, message: detected.message, snapshot, detected };
      if (!this.#isBillPage(snapshot, wanted)) {
        foreign = snapshot.url || '';
        await sleep(1200);
        continue;
      }
      if (snapshot.text && snapshot.text.length > 60 && snapshot.entries.length > 3) return { state: 'ok', snapshot, detected };
      await sleep(1200);
    }
    if (foreign !== null) {
      return { state: 'needs_manual', message: `店铺窗口停留在其它页面（${foreign || '未知地址'}），未能回到账单页；请人工切回账单页后继续`, snapshot: last?.snapshot, detected: last?.detected };
    }
    return { state: 'timeout', message: '页面长时间没有可用内容，可能是网络较慢或页面结构变化', snapshot: last?.snapshot, detected: last?.detected };
  }

  /** 期望的账单页地址（忽略查询串与锚点）。 */
  #wantedLocation(shop) {
    try { const url = new URL(this.browser.targetUrl(shop)); return { origin: url.origin, pathname: url.pathname }; }
    catch { return null; }
  }

  /** 当前页面是否就是本店账单页。地址读不到时按“是”处理，避免把正常页面误判成异常。 */
  #isBillPage(snapshot, wanted) {
    if (!wanted || !snapshot?.url) return true;
    try { const current = new URL(snapshot.url); return current.origin === wanted.origin && current.pathname === wanted.pathname; }
    catch { return true; }
  }

  /** 执行 planner 给出的动作，并返回动作是否真正生效。 */
  async #apply(shop, action) {
    if (!action) return { ok: false, reason: 'no_action' };
    const result = await this.browser.act(shop.id, action);
    if (!result.ok) return result;
    await sleep(action.op === 'setMonth' || action.op === 'setValue' ? 600 : 900);
    return result;
  }

  /** 在一个账单类型里循环推进，直到收到文件、需要人工、或达到步数上限。 */
  async #collectKind({ shop, month, jobId, batchId, kind, maxSteps = 24, onProgress }) {
    const done = [];
    const received = [];
    const attempt = {
      queryRequested: false, requested: false, selectedCategory: '', selectedSubtype: '', categoryLabel: '',
      planned: [], retries: 0, dismissed: [], dismissCount: 0, setMonthCount: 0, exportRetries: 0, shardHints: []
    };
    // 期望清单在“账单页上发现的子类型”为准，取完后页面可能已跳到导出中心，不能再用那时的页面推断。
    const expectedOf = () => (attempt.planned.length ? attempt.planned : (attempt.categoryLabel ? [attempt.categoryLabel] : [BILL_KINDS[kind]]));
    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelled.has(shop.id)) return { state: 'cancelled', message: '任务已取消', received, expected: expectedOf(), shardHints: attempt.shardHints };
      const snapshot = await this.#snapshot(shop, month, jobId);
      const plan = planStep(snapshot, {
        month, account: shop.account, kind, overrides: shop.categoryMap || {},
        excludeSubtypes: shop.excludeSubtypes || [],
        doneSubtypes: done, requestedExport: attempt.requested,
        selectedCategory: attempt.selectedCategory, selectedSubtype: attempt.selectedSubtype, queryRequested: attempt.queryRequested,
        dismissedPopups: attempt.dismissed
      });
      onProgress?.(plan.state, plan.message);
      if (plan.evidence?.shardHints?.length) attempt.shardHints = plan.evidence.shardHints;
      if (plan.evidence?.subtypes?.length) attempt.planned = [...plan.evidence.subtypes];
      if (plan.evidence?.categories?.discovered?.length) attempt.categoryLabel = plan.evidence.categories.discovered.find(item => item.kind === kind)?.label || attempt.categoryLabel;
      if (plan.state === 'needs_login' || plan.state === 'needs_captcha' || plan.state === 'needs_shop_review' || plan.state === 'needs_manual' || plan.state === 'query_failed') {
        return { state: plan.state, message: plan.message, received, expected: expectedOf(), shardHints: attempt.shardHints, evidence: plan.evidence };
      }
      if (plan.state === 'empty') {
        return { state: 'empty', message: `「${BILL_KINDS[kind]}」页面明确提示无数据，已记录为空账单（不按零入账）`, received, expected: expectedOf(), shardHints: attempt.shardHints };
      }
      if (plan.state === 'awaiting_export') {
        return { state: 'needs_manual', message: plan.message, received, expected: expectedOf(), shardHints: attempt.shardHints };
      }
      if (plan.state === 'pick_category') {
        const result = await this.#apply(shop, plan.action);
        if (!result.ok) return { state: 'needs_manual', message: `切换账单分类失败：${result.message || result.reason}`, received, expected: expectedOf(), shardHints: attempt.shardHints };
        attempt.selectedCategory = plan.action.expect?.text || attempt.selectedCategory;
        attempt.categoryLabel = plan.action.expect?.text || attempt.categoryLabel;
        attempt.selectedSubtype = '';
        attempt.queryRequested = false;
        continue;
      }
      if (plan.state === 'pick_subtype') {
        const result = await this.#apply(shop, plan.action);
        if (!result.ok) return { state: 'needs_manual', message: `切换账单子类型失败：${result.message || result.reason}`, received, expected: expectedOf(), shardHints: attempt.shardHints };
        attempt.selectedSubtype = plan.action.expect?.text || attempt.selectedSubtype;
        attempt.queryRequested = false;
        continue;
      }
      if (plan.state === 'dismiss_popup') {
        // 页面公告/消息浮层只关有限次：关不掉就照常继续，不能在这里死循环。
        attempt.dismissCount += 1;
        if (attempt.dismissCount > 3) {
          attempt.dismissed.push(`skip:${attempt.dismissCount}`);
          continue;
        }
        const result = await this.#apply(shop, plan.action);
        onProgress?.('dismiss_popup', result.ok ? '已关闭页面提示层' : '关闭提示层未生效，继续执行');
        attempt.dismissed.push(plan.evidence?.dismissKey || `popup-${attempt.dismissCount}`);
        continue;
      }
      if (plan.state === 'set_month') {
        attempt.setMonthCount += 1;
        // 账期控件可能是受控组件，写值不一定生效；试几次还不对就转人工，避免死循环。
        if (attempt.setMonthCount > 3) {
          return { state: 'needs_manual', message: `账期控件（${plan.evidence?.format === 'date' ? '日期范围' : '月份'}）自动填写未生效，请人工把账期设置为 ${month} 后继续`, received, expected: expectedOf(), shardHints: attempt.shardHints };
        }
        const result = await this.#apply(shop, plan.action);
        if (!result.ok) return { state: 'needs_manual', message: `设置账期失败：${result.message || result.reason}`, received, expected: expectedOf(), shardHints: attempt.shardHints };
        attempt.queryRequested = false;
        continue;
      }
      if (plan.state === 'query') {
        const result = await this.#apply(shop, plan.action);
        attempt.queryRequested = true;
        if (!result.ok) { attempt.retries += 1; if (attempt.retries > 3) return { state: 'needs_manual', message: '点击查询多次未生效，请人工核对页面', received, expected: expectedOf(), shardHints: attempt.shardHints }; }
        continue;
      }
      if (plan.state === 'request_export') {
        const pending = this.browser.expectDownload(shop.id, { shopId: shop.id, month, kind, batchId, intentAt: new Date().toISOString() }, { timeoutMs: this.exportTimeoutMs });
        const result = await this.#apply(shop, plan.action);
        if (!result.ok) {
          this.browser.cancelIntent(shop.id);
          pending.catch(() => {});
          return { state: 'needs_manual', message: `点击导出入口失败：${result.message || result.reason}`, received, expected: expectedOf(), shardHints: attempt.shardHints };
        }
        attempt.requested = true;
        const unitLabel = attempt.selectedSubtype || attempt.categoryLabel || BILL_KINDS[kind];
        // 收到一个文件后统一结算：登记分片，并判断该账单类型是否还有未取的子类型。
        const finishUnit = file => {
          received.push({ ...file, kind, subtype: unitLabel });
          if (!done.includes(unitLabel)) done.push(unitLabel);
          attempt.requested = false;
          onProgress?.('received', `已收到文件 ${file.name}`);
          const expected = expectedOf();
          if (expected.some(label => !done.includes(label))) return null;
          return { state: 'received', message: '该账单类型已收到全部已发现子类型', received, expected };
        };
        try {
          const settled = finishUnit(await pending);
          if (settled) return settled;
          continue;
        } catch (error) {
          attempt.requested = false;
          // 点了导出却没等到文件：先判断是不是这一次点击没生效，按上限重试一次，
          // 再考虑“导出中心”这条异步路径，避免把偶发的点击丢失当成平台不支持下载。
          if (attempt.exportRetries < 1) {
            attempt.exportRetries += 1;
            onProgress?.('awaiting_export', `未在时限内收到下载（${error.message}），按上限重试一次导出`);
            continue;
          }
          const center = findExportCenterEntry(await this.#snapshot(shop, month, jobId));
          if (center.ok) {
            const fromCenter = await this.#downloadFromCenter({ shop, month, jobId, kind, center });
            if (fromCenter.state === 'received') {
              const settled = finishUnit(fromCenter.file);
              if (settled) return settled;
              // 导出中心是异步流程，取完一个子类型后必须回到账单页再继续，否则会丢掉店铺身份。
              if (this.browser.ensure(shop, month, jobId)) await sleep(1500);
              continue;
            }
            return { state: fromCenter.state, message: fromCenter.message, received, expected: expectedOf(), shardHints: attempt.shardHints };
          }
          return { state: 'needs_manual', message: `已请求导出但未收到文件：${error.message}。请在店铺窗口确认导出方式（同步下载或导出中心），必要时人工下载后导入`, received, expected: expectedOf(), shardHints: attempt.shardHints };
        }
      }
      return { state: 'needs_manual', message: `遇到未预期的页面状态「${plan.state}」：${plan.message}`, received, expected: expectedOf(), shardHints: attempt.shardHints };
    }
    return { state: 'needs_manual', message: '推进步骤超过上限，页面可能已变化，请人工核对后继续', received, expected: expectedOf(), shardHints: attempt.shardHints };
  }

  /** 异步导出中心：按“账期 + 类型”关联当前任务，不点旧任务。 */
  async #downloadFromCenter({ shop, month, jobId, kind, center }) {
    const clickCenter = await this.#apply(shop, { op: 'click', selector: center.entry.selector, expect: { text: center.entry.text, id: center.entry.id } });
    if (!clickCenter.ok) return { state: 'needs_manual', message: '无法打开导出中心，请人工在店铺窗口导出' };
    const targetLabel = BILL_KINDS[kind];
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.cancelled.has(shop.id)) return { state: 'cancelled', message: '任务已取消' };
      await sleep(this.pollIntervalMs);
      const snapshot = await this.#snapshot(shop, month, jobId);
      const rows = parseExportRows(snapshot);
      const matched = rows.find(row => row.months === month && row.download && (row.rowText.includes(targetLabel) || row.rowText.includes(month)));
      if (matched) {
        const pending = this.browser.expectDownload(shop.id, { shopId: shop.id, month, kind, batchId: null, from: 'export-center', intentAt: new Date().toISOString() }, { timeoutMs: 60000 });
        // 把动作绑定到“具体那一行 + 行内仍含目标账期”：多条导出记录的选择器往往完全一样，
        // 只按选择器点会判为歧义，而按“第一个”点又会下错任务。
        const clicked = await this.#apply(shop, {
          op: 'click', row: matched.download.row, selector: matched.download.selector,
          expect: { text: matched.download.text, id: matched.download.id }, rowText: month
        });
        if (!clicked.ok) { this.browser.cancelIntent(shop.id); pending.catch(() => {}); continue; }
        try { const file = await pending; return { state: 'received', file }; }
        catch (error) { return { state: 'needs_manual', message: `导出中心下载失败：${error.message}`, }; }
      }
      const stillGenerating = /生成中|排队中|处理中|等待中|导出中/.test(snapshot.text || '');
      if (!stillGenerating && attempt > 4) return { state: 'needs_manual', message: `导出中心没有匹配 ${month} 的可用文件，请人工核对（不下载旧任务）` };
    }
    return { state: 'needs_manual', message: '导出中心等待超时，请人工确认导出结果后继续' };
  }

  /**
   * 执行一次取账。
   * @param {object} params
   * @param {object} params.shop 财务店铺
   * @param {string} params.month 账期 YYYY-MM
   * @param {string[]} [params.kinds]
   * @param {boolean} [params.reuseJob] 继续已有的待人工任务
   */
  async run({ shop, month, kinds = DEFAULT_KINDS, reuseJob = false }) {
    if (this.running.has(shop.id)) return { shopId: shop.id, month, state: 'running', message: '该店铺已有执行或排队中的任务', kinds: [] };
    this.cancelled.delete(shop.id);
    // 在加入全局队列前占位，避免等待其他店铺时被重复提交。
    this.running.set(shop.id, { jobId: null, month, queued: true });
    return this.serialize(async () => {
      let jobId = null;
      const summary = { shopId: shop.id, shopName: shop.name, month, jobId, kinds: [], state: 'running', message: '' };
      try {
        if (this.cancelled.has(shop.id)) return { ...summary, state: 'cancelled', message: '排队任务已取消' };
        jobId = reuseJob ? await this.call('openJob', shop.id, month) : await this.call('newJob', shop.id, month);
        summary.jobId = jobId;
        this.running.set(shop.id, { jobId, month, startedAt: Date.now() });
        if (this.cancelled.has(shop.id)) {
          summary.state = 'cancelled'; summary.message = '任务已取消';
          await this.call('finishJob', jobId, 'cancelled', summary.message);
          return summary;
        }
        this.browser.open(shop, month, jobId);
        const ready = await this.#waitReady(shop, month, jobId);
        if (ready.state !== 'ok') {
          await this.call('finishJob', jobId, ready.state, ready.message || '页面未能进入可识别状态');
          summary.state = ready.state === 'cancelled' ? 'cancelled' : (MANUAL_STATES.has(ready.state) ? 'needs_review' : 'failed');
          summary.message = ready.message || '页面未能进入可识别状态';
          return summary;
        }

        const identity = verifyShopIdentity(ready.snapshot, shop.account);
        if (identity.matched !== true) {
          const state = identity.matched === false ? 'needs_shop_review' : 'needs_manual';
          await this.call('finishJob', jobId, state, identity.reason);
          summary.state = 'needs_review'; summary.message = identity.reason;
          return summary;
        }

        const limits = ready.detected?.limits || [];
        const recordCount = ready.detected?.recordCount ?? null;
        if (limits.length || recordCount !== null) {
          await this.call('updateJob', jobId, { note: { limits, recordCount } });
          // 平台自己在页面上给过“建议缩小查询时间范围后再导出”，先认出来再决定怎么拆。
          const shard = planShards({ recordCount, limits, dimensions: [], hints: extractShardHints(ready.snapshot?.text || ''), month });
          if (shard.needsManual) {
            await this.call('updateJob', jobId, { note: { limits, recordCount, shard } });
            this.progress({ ...summary, state: 'needs_manual', message: shard.reason, level: 'error' });
          }
        }

        for (const kind of kinds) {
          // 上一个账单类型可能停在了导出记录页，开始新类型前必须真的回到账单页并重新核对店铺。
          if (this.browser.ensure(shop, month, jobId)) {
            const back = await this.#waitReady(shop, month, jobId, 20000);
            if (back.state !== 'ok') {
              const state = back.state === 'timeout' ? 'needs_manual' : back.state;
              summary.state = state === 'cancelled' ? 'cancelled' : (MANUAL_STATES.has(state) ? 'needs_review' : 'failed');
              summary.message = back.message || '未能回到账单页';
              await this.call('finishJob', jobId, state, summary.message);
              return summary;
            }
          }
          const batchId = await this.call('openBatch', jobId, shop.id, month, kind, { expected: [] });
          const result = await this.#collectKind({ shop, month, jobId, batchId, kind, onProgress: (state, message) => this.progress({ ...summary, state, message }) });
          const received = [];
          const storageErrors = [];
          for (const file of result.received || []) {
            try {
              const staged = await this.call('addPart', batchId, {
                file: file.file, name: file.name, shopId: shop.id, month, kind,
                subtype: file.subtype || '', sourceTask: jobId, intentAt: file.intentAt || '',
                bytes: file.bytes, sha256: file.sha256, downloadedAt: file.receivedAt
              });
              received.push(file);
              if (staged?.duplicate) this.progress({ ...summary, state: 'received', message: `文件与已保存版本相同，未重复入账：${file.name}` });
            } catch (error) {
              storageErrors.push(`${file.name || '文件'}：${error.message}`);
              this.progress({ ...summary, state: 'failed', message: `文件已保留但入库失败：${error.message}`, level: 'error' });
            }
          }
          if (storageErrors.length) {
            result.state = 'failed';
            result.message = `文件保存失败，批次未完成：${storageErrors.join('；')}`;
          }
          // 期望清单以取账时在账单页发现的子类型为准（此时窗口可能已跳到导出中心）。
          const expected = result.expected?.length ? result.expected : [BILL_KINDS[kind]];
          const receivedLabels = received.map(item => item.subtype).filter(Boolean);
          const check = completeness({ kind: BILL_KINDS[kind], discoveredSubtypes: expected, receivedSubtypes: receivedLabels.length ? receivedLabels : (received.length ? [BILL_KINDS[kind]] : []) });
          await this.call('closeBatch', batchId, {
            expected: check.expected, missing: check.missing,
            state: result.state === 'received' ? (check.complete ? 'complete' : 'partial') : (result.state === 'empty' ? 'empty' : 'incomplete'),
            message: result.state === 'received' ? (check.complete ? '已收到该类型全部已发现子类型' : `还缺：${check.missing.join('、')}`) : result.message
          });
          summary.kinds.push({ kind, label: BILL_KINDS[kind], state: result.state === 'received' && !check.complete ? 'partial' : result.state, message: result.message, received: received.length, expected: check.expected, missing: check.missing });
          if (MANUAL_STATES.has(result.state) || ['failed', 'cancelled'].includes(result.state)) break;
        }

        summary.state = overallState(summary.kinds.map(item => ({ state: item.state === 'partial' ? 'needs_manual' : item.state })));
        // 失败时把每个类型的真实原因带进任务消息，否则界面上只剩一句“需要人工”无法定位。
        summary.message = summary.kinds.map(item => item.state === 'received'
          ? `${item.label}：已收到`
          : `${item.label}：${item.state}${item.message ? `（${item.message}）` : ''}`).join('；');
        const finalState = ['received', 'needs_review', 'empty', 'cancelled'].includes(summary.state) ? summary.state : 'failed';
        await this.call('finishJob', jobId, finalState, summary.message);
        return summary;
      } catch (error) {
        if (jobId) await this.call('finishJob', jobId, 'failed', `取账异常：${String(error?.message || error).slice(0, 300)}`).catch(() => {});
        summary.state = 'failed';
        summary.message = `取账异常：${String(error?.message || error).slice(0, 300)}`;
        return summary;
      } finally {
        this.running.delete(shop.id);
      }
    });
  }

  /** 单独重试失败项：只跑指定账单类型，不重复已完成的分片。 */
  async retry({ shop, month, kinds }) {
    const plan = await this.call('retryPlan', shop.id, month);
    const targets = (kinds && kinds.length ? kinds : plan.kinds || []).filter(kind => DEFAULT_KINDS.includes(kind));
    if (!targets.length) return { shopId: shop.id, month, state: 'nothing', message: '没有需要重试的账单类型', kinds: [] };
    return this.run({ shop, month, kinds: targets, reuseJob: true });
  }
}
