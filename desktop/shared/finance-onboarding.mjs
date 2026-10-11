import { randomUUID, createHash } from 'node:crypto';

const clean = (value, limit = 200) => String(value ?? '').trim().slice(0, limit);
const fingerprint = identity => createHash('sha256').update(JSON.stringify({
  name: clean(identity.name), account: clean(identity.account), shopId: clean(identity.shopId),
  entity: clean(identity.entity), taxId: clean(identity.taxId, 40), entityType: clean(identity.entityType), taxpayer: clean(identity.taxpayer)
})).digest('hex');

/** 暂存添加会话；完成登录和确认前不创建账本、不下载账单。 */
export class FinanceShopOnboarding {
  constructor({ browser, call, analyze, onboardingUrl = '' }) {
    this.browser = browser;
    this.call = call;
    this.analyze = analyze;
    this.onboardingUrl = onboardingUrl;
    this.pending = new Map();
  }

  async begin(month) {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('请选择有效账期');
    // 打开失败尚未向 UI 返回 token；下一次添加负责重试该孤立临时分区的清理。
    for (const draft of this.pending.values()) if (draft.beginFailed) await this.cancel(draft.token);
    if (this.pending.size) throw new Error('已有添加店铺流程，请先完成或取消');
    const token = randomUUID();
    const draft = { token, month, inspection: null, confirming: false };
    this.pending.set(token, draft);
    try {
      this.browser.open({ id: token, name: '添加店铺 · 请登录千牛', billUrl: this.onboardingUrl }, month, '', { draft: true });
      return { token, month, state: 'needs_login', message: '已打开千牛，请本人完成登录。登录后自动读取可见店铺信息。' };
    } catch (error) {
      draft.cleanupOnly = true;
      draft.beginFailed = true;
      try { await this.cleanup(draft); }
      catch (cleanupError) { throw new Error(`${error.message}；临时会话清理未完成，请重试取消：${cleanupError.message}`); }
      throw error;
    }
  }

  async inspect(token) {
    const draft = this.pending.get(String(token));
    if (!draft) throw new Error('添加会话已结束，请重新添加店铺');
    if (draft.cleaning || draft.cleanupOnly) throw new Error('临时会话清理未完成，请重试取消');
    if (!this.browser.isOpen(draft.token)) {
      if (draft.confirming) { const error = new Error('登录窗口已关闭，请重新添加店铺'); error.code = 'FINANCE_WINDOW_CLOSED'; throw error; }
      await this.cancel(draft.token);
      return { token: draft.token, state: 'cancelled', message: '登录窗口已关闭，未添加店铺。' };
    }
    let snapshot;
    try { snapshot = await this.browser.readIdentity(draft.token); }
    catch (error) {
      if (error.code !== 'FINANCE_WINDOW_CLOSED' || draft.confirming) throw error;
      await this.cancel(draft.token);
      return { token: draft.token, state: 'cancelled', message: '登录窗口已关闭，未添加店铺。' };
    }
    if (this.pending.get(draft.token) !== draft) return { token: draft.token, state: 'cancelled', message: '添加已取消，未保存店铺。' };
    const result = this.analyze(snapshot);
    // 白名单字段；绝不把页面全文或 Cookie 返回给主窗口。
    const identity = Object.fromEntries(['name', 'account', 'shopId', 'entity', 'taxId', 'entityType', 'taxpayer'].map(key => [key, clean(result.identity?.[key], key === 'taxId' ? 40 : 200)]));
    const inspection = {
      token: draft.token, state: result.state, message: clean(result.message, 400), identity,
      fingerprint: result.state === 'needs_confirmation' ? fingerprint(identity) : '',
      sources: Array.isArray(result.sources) ? result.sources.filter(source => source && typeof source === 'object' && Object.hasOwn(identity, source.field)).slice(0, 12).map(source => ({ field: source.field, source: clean(source.source, 40), label: clean(source.label, 40) })) : [],
      missing: Array.isArray(result.missing) ? result.missing.filter(key => Object.hasOwn(identity, key)).slice(0, 12) : []
    };
    draft.inspection = inspection;
    draft.identityVersion = snapshot.identityVersion;
    return inspection;
  }

  async confirm(token, input = {}) {
    const draft = this.pending.get(String(token));
    if (!draft) throw new Error('添加会话已结束，请重新添加店铺');
    if (draft.confirming) throw new Error('正在保存店铺，请勿重复确认');
    if (draft.cleaning || draft.cleanupOnly) throw new Error('临时会话清理未完成，请重试取消');
    const prior = draft.inspection;
    const priorVersion = draft.identityVersion;
    if (!prior || prior.state !== 'needs_confirmation' || !input.fingerprint || input.fingerprint !== prior.fingerprint) throw new Error('请重新核对登录信息，等待读取完成后再确认');
    const changed = () => { const error = new Error('登录账号或店铺信息已变化，请重新核对后确认'); error.code = 'FINANCE_IDENTITY_CHANGED'; return error; };
    const guard = () => {
      if (this.pending.get(draft.token) !== draft) throw new Error('添加已取消，未保存店铺');
      this.browser.assertIdentityVersion(draft.token, priorVersion);
    };
    const validateIdentity = async () => {
      guard();
      const snapshot = await this.browser.readIdentity(draft.token);
      guard();
      const result = this.analyze(snapshot);
      if (snapshot.identityVersion !== priorVersion || result.state !== 'needs_confirmation' || fingerprint(result.identity || {}) !== input.fingerprint) throw changed();
    };
    draft.confirming = true;
    try {
      const current = await this.inspect(draft.token);
      if (current.state !== 'needs_confirmation' || current.fingerprint !== input.fingerprint || draft.identityVersion !== priorVersion) throw changed();
      guard();
      // 只保存已经呈现给用户的快照；重读只作校验，不悄悄换成新主体/税号。
      const identity = prior.identity;
      if (!identity.account && !identity.shopId) throw new Error('尚未读取到登录账号或店铺ID，请先完成登录');
      const name = identity.name || clean(input.name);
      if (!name) throw new Error('后台未显示店铺名称，请补充店铺名称');
      const shops = await this.call('shops');
      await validateIdentity();
      const existing = shops.find(shop => identity.shopId && shop.platformShopId
        ? identity.shopId === shop.platformShopId
        : shop.name === name && identity.account && shop.account === identity.account);
      if (existing) {
        await this.browser.discardDraft(draft.token);
        this.pending.delete(draft.token);
        return { shop: existing, existing: true, message: '该店铺已添加，已切换至现有店铺；原设置和账单未覆盖。' };
      }
      guard();
      draft.rollbackKey = randomUUID();
      const shop = await this.call('createLoginShop', {
        id: draft.token, name, account: identity.account, platformShopId: identity.shopId,
        entity: identity.entity, taxId: identity.taxId,
        entityType: identity.entityType, taxpayer: identity.taxpayer,
        startMonth: draft.month, schedule: false, cycle: '', billUrl: '', categoryMap: {}, excludeSubtypes: []
      }, draft.rollbackKey);
      if (shop.id !== draft.token) throw new Error('新建店铺标识不符，未绑定登录会话');
      draft.createdShop = shop;
      await validateIdentity();
      let sessionPersisted = true;
      try {
        await this.browser.attachShop(shop, draft.month, { identityVersion: priorVersion, validateIdentity });
      } catch (error) {
        if (['FINANCE_IDENTITY_CHANGED', 'FINANCE_WINDOW_CLOSED'].includes(error.code)) throw error;
        // 写盘本身失败可保留已保存的店铺，但必须再次证明不是账号/导航/关闭竞争。
        await validateIdentity();
        sessionPersisted = false;
      }
      await validateIdentity();
      guard();
      this.browser.finalizeShop(draft.token, { identityVersion: priorVersion });
      // 与浏览器最终提交同一同步段结束本次回滚能力，不能降回草稿。
      draft.createdShop = null;
      delete draft.rollbackKey;
      this.pending.delete(draft.token);
      return { shop, existing: false, sessionPersisted, message: sessionPersisted
        ? '店铺已添加。登录会话已保留，未读取到的信息可稍后在店铺设置补充。'
        : '店铺已添加，但登录会话写盘失败，重启后可能需要重新登录。原账本已保存，无需重复添加。' };
    } catch (error) {
      if (draft.createdShop || error.code === 'FINANCE_WINDOW_CLOSED') {
        draft.cleanupOnly = true;
        try { await this.cleanup(draft); }
        catch (cleanupError) { throw new Error(`${error.message}；临时店铺或会话清理未完成，请重试取消：${cleanupError.message}`); }
      }
      throw error;
    } finally { draft.confirming = false; }
  }

  async cleanup(draft) {
    // 回滚能力仅由本次创建返回；既存店从不进入这个分支。
    if (draft.createdShop) {
      let rollbackError;
      try { await this.call('rollbackLoginShop', draft.token, draft.rollbackKey); draft.createdShop = null; }
      catch (error) { rollbackError = error; }
      // 即使店铺已有数据不能撤回，也不能保留已失配的临时登录会话。
      await this.browser.discardDraft(draft.token);
      if (rollbackError) throw rollbackError;
    } else await this.browser.discardDraft(draft.token);
    this.pending.delete(draft.token);
  }

  async cancel(token) {
    const draft = this.pending.get(String(token));
    if (!draft) return { cancelled: true };
    if (draft.confirming) throw new Error('店铺正在保存，请稍后再操作');
    if (draft.cleaning) throw new Error('正在清理临时会话，请稍后重试');
    draft.cleaning = true;
    draft.cleanupOnly = true;
    try {
      await this.cleanup(draft);
      return { cancelled: true };
    } finally { draft.cleaning = false; }
  }
}
