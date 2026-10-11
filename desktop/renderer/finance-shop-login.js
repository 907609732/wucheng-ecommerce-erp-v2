(() => {
  const $ = id => document.getElementById(id);
  window.createFinanceShopLogin = ({ api, getMonth, onSaved, onStatus }) => {
    const dialog = $('financeShopLoginDialog');
    let token = '', inspection = null, timer = null, reading = false, confirming = false;
    function stop() { clearTimeout(timer); timer = null; token = ''; inspection = null; }
    function updateConfirm() {
      $('financeShopLoginConfirm').disabled = confirming || inspection?.state !== 'needs_confirmation' || !$('finLoginName').value.trim();
    }
    function schedule() {
      clearTimeout(timer);
      if (token && dialog.open && !confirming) timer = setTimeout(() => void read(), 1800);
    }
    function render(result) {
      const previous = inspection;
      inspection = result;
      $('financeShopLoginStatus').textContent = result.message;
      $('financeShopLoginInfo').classList.toggle('hidden', result.state !== 'needs_confirmation');
      const identity = result.identity || {};
      const same = previous?.identity?.account === identity.account && previous?.identity?.shopId === identity.shopId;
      if (identity.name || !same) $('finLoginName').value = identity.name || '';
      $('finLoginName').readOnly = Boolean(identity.name);
      $('finLoginAccount').textContent = identity.account || '后台未提供';
      $('finLoginPlatformId').textContent = identity.shopId || '后台未提供';
      $('finLoginEntity').textContent = `主体名称：${identity.entity || '后台未提供，可稍后设置'}`;
      $('finLoginTaxId').textContent = `税号：${identity.taxId || '后台未提供，可稍后设置'}`;
      updateConfirm();
    }
    async function read() {
      if (!token || reading || confirming) return;
      const current = token; reading = true;
      $('financeShopLoginRefresh').disabled = true;
      try {
        const result = await api.inspectFinanceShopLogin(current);
        if (token !== current) return;
        if (result.state === 'cancelled') { stop(); dialog.close(); onStatus(result.message); return; }
        $('financeShopLoginError').textContent = '';
        render(result);
      } catch (error) {
        if (token === current) {
          inspection = null; updateConfirm();
          $('financeShopLoginError').textContent = `读取未完成：${error.message}。可继续登录或点击重新读取。`;
        }
      } finally {
        reading = false;
        $('financeShopLoginRefresh').disabled = confirming;
        schedule();
      }
    }
    async function cancel() {
      if (confirming) return;
      if (!token) { dialog.close(); return; }
      const current = token;
      $('financeShopLoginCancel').disabled = true;
      try {
        await api.cancelFinanceShopLogin(current);
        if (token === current) { stop(); dialog.close(); onStatus('已取消添加，未保存店铺或账单。'); }
      } catch (error) { $('financeShopLoginError').textContent = error.message; }
      finally { $('financeShopLoginCancel').disabled = false; }
    }
    $('finLoginName').oninput = updateConfirm;
    $('financeShopLoginRefresh').onclick = () => void read();
    $('financeShopLoginCancel').onclick = () => void cancel();
    dialog.addEventListener('cancel', event => { event.preventDefault(); void cancel(); });
    dialog.addEventListener('close', () => { if (token && !confirming) void cancel(); });
    $('financeShopLoginForm').onsubmit = async event => {
      event.preventDefault();
      if (!token || confirming || inspection?.state !== 'needs_confirmation' || !$('finLoginName').value.trim()) return;
      const current = token, fingerprint = inspection.fingerprint;
      confirming = true; clearTimeout(timer); updateConfirm();
      $('financeShopLoginCancel').disabled = $('financeShopLoginRefresh').disabled = true;
      try {
        const result = await api.confirmFinanceShopLogin(current, { fingerprint, name: $('finLoginName').value.trim() });
        stop(); dialog.close();
        try { await onSaved(result); } catch (error) { onStatus(`店铺已添加，但界面刷新失败：${error.message}，请点击刷新。`); }
      } catch (error) {
        inspection = null; $('financeShopLoginError').textContent = error.message;
      } finally {
        confirming = false;
        $('financeShopLoginCancel').disabled = $('financeShopLoginRefresh').disabled = false;
        updateConfirm(); schedule();
      }
    };
    return {
      async open() {
        if (token) { if (!dialog.open) dialog.showModal(); return; }
        const started = await api.beginFinanceShopLogin(getMonth());
        token = started.token; inspection = null;
        $('financeShopLoginError').textContent = '';
        $('financeShopLoginInfo').classList.add('hidden');
        $('finLoginName').value = ''; $('financeShopLoginConfirm').disabled = true;
        $('financeShopLoginStatus').textContent = started.message;
        dialog.showModal(); onStatus('已打开千牛登录，登录后读取店铺信息。');
        schedule();
      }
    };
  };
})();
