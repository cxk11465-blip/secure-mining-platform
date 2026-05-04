const app = document.querySelector('#app');

let state = {
  user: null,
  csrfToken: null,
  view: 'dashboard',
  authMode: 'login',
  dashboard: null,
  admin: null,
  pendingPurchase: null,
  pendingWithdrawalApproval: null,
  selectedUser: null,
  proofPreview: null,
  rechargeMode: 'cold_wallet',
  adminFilters: { userQuery: '', userStatus: 'all', depositQuery: '', withdrawalQuery: '' },
  busy: false,
  message: '',
  messageType: ''
};

const money = (value) => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (value) => value ? new Date(value).toLocaleString('zh-CN') : '-';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const normalizeExpiryInput = (value) => {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length === 6) return `${digits.slice(0, 2)}/${digits.slice(4)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}`;
};

async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      ...(state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {}),
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    },
    ...options,
    body: options.body ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function statusTag(status) {
  const text = { pending: '待审核', approved: '已通过', rejected: '已拒绝', active: '正常', frozen: '冻结', banned: '封禁', disabled: '禁用' }[status] || status;
  return `<span class="status ${esc(status)}">${esc(text)}</span>`;
}

function depositStatus(item) {
  if (item.channel === 'credit_card') {
    if (item.status === 'approved') return '<span class="status approved">充值成功</span>';
    if (item.status === 'rejected') return '<span class="status rejected">您的银行卡被拒绝了。请联系您的发卡行。</span>';
    return '<span class="status pending">充值提交成功，审核中</span>';
  }
  return statusTag(item.status);
}

function channelLabel(channel) {
  return {
    cold_wallet: 'USDT 冷钱包',
    credit_card: '信用卡'
  }[channel] || channel || '-';
}

function depositDetail(item) {
  if (item.channel === 'cold_wallet') {
    const receipt = item.details?.receiptUrl ? ` · <button class="link-button" data-proof="${esc(item.details.receiptUrl)}">查看截图</button>` : '';
    return `TxID: ${esc(item.details?.txHash || '-')}${receipt}`;
  }
  if (item.channel === 'credit_card') return `尾号 ${item.details?.cardLast4 || '-'} · ${item.details?.expiry || '-'}`;
  return '-';
}

function payoutDetail(item) {
  if (item.status !== 'approved') return '-';
  const tx = item.payout?.payoutTxHash || '-';
  const receipt = item.payout?.receiptUrl ? ` · <button class="link-button" data-proof="${esc(item.payout.receiptUrl)}">查看到账凭证</button>` : '';
  return `付款TxID: ${esc(tx)}${receipt}`;
}

function openProofPreview(url) {
  state.proofPreview = url;
  render();
}

function closeProofPreview() {
  state.proofPreview = null;
  render();
}

function setView(view) {
  state.view = view;
  render();
  if (state.user?.role === 'admin') loadAdmin();
  else loadDashboard();
}

async function bootstrap() {
  try {
    const data = await request('/api/auth/me');
    state.user = data.user;
    state.csrfToken = data.csrfToken;
    if (state.user.role === 'admin') await loadAdmin();
    else await loadDashboard();
  } catch {
    renderAuth();
  }
}

async function login(form) {
  state.message = '';
  try {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: {
        username: form.username.value,
        password: form.password.value,
        adminCode: form.adminCode?.value || ''
      }
    });
    state.user = data.user;
    state.csrfToken = data.csrfToken;
    state.view = 'dashboard';
    if (data.user.role === 'admin') await loadAdmin();
    else await loadDashboard();
  } catch (error) {
    state.message = error.message;
    renderAuth();
  }
}

async function register(form) {
  state.message = '';
  if (form.password.value !== form.confirmPassword.value) {
    state.message = '两次输入的密码不一致';
    renderAuth();
    return;
  }
  try {
    await request('/api/auth/register', {
      method: 'POST',
      body: {
        username: form.username.value,
        password: form.password.value
      }
    });
    state.authMode = 'login';
    state.message = '注册成功，请登录';
    renderAuth();
  } catch (error) {
    state.message = error.message;
    renderAuth();
  }
}

async function logout() {
  await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state = { user: null, csrfToken: null, view: 'dashboard', authMode: 'login', dashboard: null, admin: null, pendingPurchase: null, pendingWithdrawalApproval: null, selectedUser: null, proofPreview: null, rechargeMode: 'cold_wallet', adminFilters: { userQuery: '', userStatus: 'all', depositQuery: '', withdrawalQuery: '' }, busy: false, message: '', messageType: '' };
  renderAuth();
}

async function loadDashboard() {
  if (!state.user || state.user.role === 'admin') return;
  state.dashboard = await request('/api/user/dashboard');
  state.user = state.dashboard.user;
  render();
}

async function loadAdmin() {
  if (!state.user || state.user.role !== 'admin') return;
  state.admin = await request('/api/admin/overview');
  render();
}

async function createDeposit(form) {
  state.message = '';
  state.messageType = '';
  try {
    let body;
    if (form.channel.value === 'cold_wallet') {
      body = new FormData();
      body.append('amount', form.amount.value);
      body.append('channel', form.channel.value);
      body.append('txHash', form.txHash.value);
      if (form.receipt.files[0]) body.append('receipt', form.receipt.files[0]);
    } else {
      body = { amount: form.amount.value, channel: form.channel.value };
      body.cardHolder = form.cardHolder.value;
      body.cardNumber = form.cardNumber.value;
      body.expiry = normalizeExpiryInput(form.expiry.value);
      body.cvv = form.cvv.value;
    }
    const data = await request('/api/deposits', { method: 'POST', body });
    state.message = data.deposit?.channel === 'credit_card' ? '充值提交成功，正在等待银行及平台审核。' : '充值申请已提交，等待后台审核。';
    state.messageType = 'success';
    form.reset();
    await loadDashboard();
  } catch (error) {
    state.message = error.message;
    state.messageType = 'error';
    render();
  }
}

async function createWithdrawal(form) {
  state.message = '';
  try {
    await request('/api/withdrawals', { method: 'POST', body: { amount: form.amount.value, walletAddress: form.walletAddress.value } });
    form.reset();
    await loadDashboard();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

function openWithdrawalApproval(id) {
  const withdrawal = state.admin?.withdrawals?.find((item) => item.id === id);
  if (!withdrawal) return;
  state.pendingWithdrawalApproval = withdrawal;
  render();
}

function closeWithdrawalApproval() {
  state.pendingWithdrawalApproval = null;
  render();
}

async function approveWithdrawalWithProof(form) {
  const withdrawal = state.pendingWithdrawalApproval;
  if (!withdrawal) return;
  state.message = '';
  try {
    const body = new FormData();
    body.append('payoutTxHash', form.payoutTxHash.value);
    if (form.payoutReceipt.files[0]) body.append('payoutReceipt', form.payoutReceipt.files[0]);
    await request(`/api/admin/withdrawals/${withdrawal.id}/approve`, { method: 'POST', body });
    state.pendingWithdrawalApproval = null;
    await loadAdmin();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

function openUserDetail(userId) {
  state.selectedUser = state.admin?.users?.find((item) => item.id === userId) || null;
  render();
}

function closeUserDetail() {
  state.selectedUser = null;
  render();
}

async function setUserStatus(userId, status) {
  state.message = '';
  try {
    const label = { active: '恢复正常', frozen: '冻结', banned: '封禁' }[status] || '调整';
    const reason = window.prompt(`${label}账号原因`, status === 'active' ? '审核后恢复正常' : '风控审核');
    if (reason === null) return;
    const note = window.prompt('操作备注（可留空）', '') || '';
    await request(`/api/admin/users/${userId}/status`, { method: 'POST', body: { status, reason, note } });
    await loadAdmin();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

async function resetUserPassword(userId) {
  state.message = '';
  try {
    const data = await request(`/api/admin/users/${userId}/reset-password`, { method: 'POST' });
    state.message = `临时密码：${data.temporaryPassword}`;
    await loadAdmin();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

async function playGame(gameId) {
  state.message = '';
  try {
    await request('/api/games/play', { method: 'POST', body: { gameId } });
    await loadDashboard();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

async function purchaseMiner(planId, quantity = 1) {
  state.message = '';
  try {
    await request('/api/miners/purchase', { method: 'POST', body: { planId, quantity } });
    await loadDashboard();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

function openPurchase(planId) {
  const plan = (state.dashboard?.minerPlans || []).find((item) => item.id === planId);
  if (!plan) return;
  state.pendingPurchase = plan;
  render();
}

function closePurchase() {
  state.pendingPurchase = null;
  render();
}

function confirmPurchase(form) {
  const quantity = Math.floor(Number(form.quantity.value || 1));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
    state.message = '购买数量必须在 1 到 100 之间';
    render();
    return;
  }
  const planId = state.pendingPurchase?.id;
  state.pendingPurchase = null;
  purchaseMiner(planId, quantity);
}

async function claimMiner(minerId) {
  state.message = '';
  try {
    await request(`/api/miners/${minerId}/claim`, { method: 'POST' });
    await loadDashboard();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

async function review(type, id, decision) {
  state.message = '';
  try {
    const base = type === 'deposit' ? 'deposits' : 'withdrawals';
    await request(`/api/admin/${base}/${id}/${decision}`, { method: 'POST' });
    await loadAdmin();
  } catch (error) {
    state.message = error.message;
    render();
  }
}

function renderAuth() {
  const isLogin = state.authMode === 'login';
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-card">
        <h1>稳盈资产管理平台</h1>
        <p>专业账户体系、资金审核、风控管理与审计追踪，保障每一笔投资流程清晰可查。</p>
        <div class="tabs">
          <button class="${isLogin ? 'active' : ''}" data-auth-tab="login">登录</button>
          <button class="${!isLogin ? 'active' : ''}" data-auth-tab="register">注册</button>
        </div>
        <form class="form" id="auth-form">
          <div class="field">
            <label>用户名</label>
            <input name="username" autocomplete="username" required minlength="3" />
          </div>
          <div class="field">
            <label>密码</label>
            <input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="${isLogin ? '1' : '8'}" />
          </div>
          ${isLogin ? `
            <div class="field">
              <label>管理员验证码</label>
              <input name="adminCode" autocomplete="one-time-code" placeholder="普通用户可留空" />
            </div>
          ` : ''}
          ${isLogin ? '' : `
            <div class="field">
              <label>确认密码</label>
              <input name="confirmPassword" type="password" autocomplete="new-password" required minlength="8" />
            </div>
          `}
          <button class="primary" type="submit">${isLogin ? '进入账户中心' : '开通投资账户'}</button>
        </form>
        <div class="notice">账户安全提示：管理端需使用专属验证码登录，所有资金操作均进入后台风控审核与审计记录。</div>
        ${state.message ? `<div class="${state.messageType === 'success' ? 'success-message' : 'error'}">${esc(state.message)}</div>` : ''}
      </section>
    </main>
  `;
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.authMode = button.dataset.authTab;
      state.message = '';
      renderAuth();
    });
  });
  document.querySelector('#auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    isLogin ? login(event.target) : register(event.target);
  });
}

function layout(content) {
  const items = state.user.role === 'admin'
    ? [['dashboard', '审核台'], ['users', '用户与流水'], ['audit', '审计日志']]
    : [['dashboard', '资产总览'], ['miners', '投资产品'], ['games', '权益任务'], ['deposit', '充值申请'], ['withdraw', '提现申请']];
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-title">稳盈资产管理</div>
          <div class="brand-sub">${state.user.role === 'admin' ? '管理后台' : '投资账户中心'}</div>
        </div>
        <nav class="nav">
          ${items.map(([key, label]) => `<button class="${state.view === key ? 'active' : ''}" data-view="${key}">${label}</button>`).join('')}
        </nav>
      </aside>
      <main class="main">
        <div class="topbar">
          <div class="page-title">${esc(items.find(([key]) => key === state.view)?.[1] || '工作台')}</div>
          <div class="user-pill">
            <span>${esc(state.user.username)} · ${state.user.role === 'admin' ? '管理员' : '用户'}</span>
            <button class="ghost" id="logout">退出</button>
          </div>
        </div>
        ${state.message ? `<div class="error">${esc(state.message)}</div>` : ''}
        ${content}
      </main>
    </div>
    ${state.pendingPurchase ? purchaseModal(state.pendingPurchase) : ''}
    ${state.pendingWithdrawalApproval ? withdrawalApprovalModal(state.pendingWithdrawalApproval) : ''}
    ${state.selectedUser ? userDetailModal(state.selectedUser) : ''}
    ${state.proofPreview ? proofPreviewModal(state.proofPreview) : ''}
  `;
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelector('#logout').addEventListener('click', logout);
  const purchaseForm = document.querySelector('#purchase-confirm-form');
  if (purchaseForm) purchaseForm.addEventListener('submit', (event) => { event.preventDefault(); confirmPurchase(event.target); });
  if (purchaseForm) {
    const quantityInput = purchaseForm.quantity;
    const preview = document.querySelector('#purchase-preview');
    const plan = state.pendingPurchase;
    const updatePurchasePreview = () => {
      const quantity = Math.max(1, Math.floor(Number(quantityInput.value || 1)));
      preview.innerHTML = `
        <div>总消耗：${money(plan.cost * quantity)} 能量</div>
        <div>预计总产出：${money(plan.totalOutput * quantity)} 能量</div>
      `;
    };
    quantityInput.addEventListener('input', updatePurchasePreview);
    updatePurchasePreview();
  }
  const closeButton = document.querySelector('[data-close-purchase]');
  if (closeButton) closeButton.addEventListener('click', closePurchase);
  const withdrawalApprovalForm = document.querySelector('#withdrawal-approval-form');
  if (withdrawalApprovalForm) withdrawalApprovalForm.addEventListener('submit', (event) => { event.preventDefault(); approveWithdrawalWithProof(event.target); });
  const closeWithdrawalButton = document.querySelector('[data-close-withdrawal-approval]');
  if (closeWithdrawalButton) closeWithdrawalButton.addEventListener('click', closeWithdrawalApproval);
  const closeUserButton = document.querySelector('[data-close-user-detail]');
  if (closeUserButton) closeUserButton.addEventListener('click', closeUserDetail);
  const closeProofButton = document.querySelector('[data-close-proof]');
  if (closeProofButton) closeProofButton.addEventListener('click', closeProofPreview);
}

function purchaseModal(plan) {
  const maxAffordable = Math.max(1, Math.min(100, Math.floor((state.dashboard?.user?.energy || 0) / plan.cost)));
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">确认购买矿工</div>
        <form id="purchase-confirm-form">
          <div class="modal-body">
            <div class="fee-preview">
              <div>矿工：${esc(plan.name)}</div>
              <div>单个消耗：${money(plan.cost)} 能量</div>
              <div>周期：${esc(plan.durationDays)} 天</div>
              <div>单个预计产出：${money(plan.totalOutput)} 能量</div>
            </div>
            <div class="field">
              <label>购买数量</label>
              <input name="quantity" type="number" min="1" max="${esc(maxAffordable)}" value="1" required />
            </div>
            <div class="fee-preview" id="purchase-preview">
              <div>总消耗：${money(plan.cost)} 能量</div>
              <div>预计总产出：${money(plan.totalOutput)} 能量</div>
            </div>
          </div>
          <div class="modal-actions">
            <button class="ghost" type="button" data-close-purchase>取消</button>
            <button class="primary" type="submit">确认购买</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function withdrawalApprovalModal(withdrawal) {
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">确认付款记录</div>
        <form id="withdrawal-approval-form">
          <div class="modal-body">
            <div class="fee-preview">
              <div>用户：${esc(withdrawal.username)}</div>
              <div>申请金额：${money(withdrawal.amount)}</div>
              <div>手续费：${money(withdrawal.fee ?? withdrawal.amount * 0.05)}</div>
              <div>实际到账：${money(withdrawal.receiveAmount ?? withdrawal.amount * 0.95)}</div>
              <div>网络：${esc(withdrawal.network || 'TRC20')}</div>
              <div>冷钱包地址：${esc(withdrawal.walletAddress || withdrawal.destination)}</div>
            </div>
            <div class="field"><label>付款 TxID</label><input name="payoutTxHash" placeholder="填写实际付款交易哈希" required minlength="8" maxlength="120" /></div>
            <div class="field"><label>到账凭证截图</label><input name="payoutReceipt" type="file" accept="image/png,image/jpeg,image/webp" required /></div>
          </div>
          <div class="modal-actions">
            <button class="ghost" type="button" data-close-withdrawal-approval>取消</button>
            <button class="primary" type="submit">确认通过</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function userDetailModal(user) {
  const deposits = (state.admin?.deposits || []).filter((item) => item.userId === user.id);
  const withdrawals = (state.admin?.withdrawals || []).filter((item) => item.userId === user.id);
  const miners = (state.admin?.userMiners || []).filter((item) => item.userId === user.id);
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">用户详情</div>
        <div class="modal-body">
          <div class="fee-preview">
            <div>用户名：${esc(user.username)}</div>
            <div>用户ID：${esc(user.id)}</div>
            <div>状态：${statusTag(user.status)}</div>
            <div>能量：${money(user.energy)}，可提现：${money(user.withdrawableEnergy || 0)}，冻结：${money(user.frozen)}</div>
            <div>风控原因：${esc(user.riskReason || '-')}</div>
            <div>风控备注：${esc(user.riskNote || '-')}</div>
            <div>最近处理：${esc(user.statusUpdatedBy || '-')} · ${date(user.statusUpdatedAt)}</div>
            <div>总充值：${money(user.totalRecharge)}，累计到账提现：${money(user.totalWithdrawReceived)}</div>
            <div>矿工：${esc(user.activeMinerCount)} 运行中 / ${esc(user.minerCount)} 总数</div>
            <div>累计领取产出：${money(user.totalMined)}</div>
            <div>游戏辅助奖励：${money(user.totalGameReward)}</div>
            <div>最近登录：${date(user.lastLoginAt)}</div>
          </div>
          <div class="fee-preview">
            <div>充值记录：${deposits.length} 条</div>
            <div>提现记录：${withdrawals.length} 条</div>
            <div>矿工批次：${miners.length} 条</div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="ghost" type="button" data-close-user-detail>关闭</button>
        </div>
      </section>
    </div>
  `;
}

function proofPreviewModal(url) {
  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">凭证截图</div>
        <div class="modal-body">
          <img class="proof-image" src="${esc(url)}" alt="凭证截图" />
        </div>
        <div class="modal-actions">
          <a class="ghost" href="${esc(url)}" target="_blank" rel="noopener">新窗口打开</a>
          <button class="primary" type="button" data-close-proof>关闭</button>
        </div>
      </section>
    </div>
  `;
}

function table(headers, rows, emptyText = '暂无数据') {
  if (!rows.length) return `<div class="empty">${emptyText}</div>`;
  return `
    <table>
      <thead><tr>${headers.map((item) => `<th>${esc(item)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  `;
}

function renderUser() {
  const data = state.dashboard;
  if (!data) return layout('<div class="empty">加载中...</div>');
  if (state.view === 'miners') {
    const planCards = (data.minerPlans || []).map((plan) => `
      <article class="panel game-card">
        <div class="miner-visual"></div>
        <div>
          <div class="game-title">${esc(plan.name)} · ${money(plan.cost)} 能量</div>
          <div class="game-desc">${esc(plan.durationDays)} 天周期，每小时约 ${esc(plan.hourlyOutput)} 能量，总产出 ${money(plan.totalOutput)} 能量。</div>
        </div>
        <button class="primary" data-buy-miner="${esc(plan.id)}" ${data.user.energy < plan.cost ? 'disabled' : ''}>${data.user.energy < plan.cost ? '能量不足' : '购买矿工'}</button>
      </article>
    `).join('');
    const minerRows = (data.userMiners || []).map((miner) => `
      <tr>
        <td>${esc(miner.planName)} x ${esc(miner.quantity || 1)}</td>
        <td>${money(miner.cost)}</td>
        <td>${esc(miner.durationDays)} 天</td>
        <td>${money(miner.claimedEnergy)} / ${money(miner.totalOutput)}</td>
        <td>
          <div class="progress"><span style="width:${Math.min(100, Math.max(0, miner.progress))}%"></span></div>
          <div style="margin-top:6px;color:var(--muted);font-size:12px">${esc(miner.progress)}%</div>
        </td>
        <td>${money(miner.claimable)}</td>
        <td><button class="success" data-claim-miner="${esc(miner.id)}" ${miner.claimable < 0.01 ? 'disabled' : ''}>领取</button></td>
      </tr>
    `);
    return layout(`
      <section class="grid cols-3">${planCards}</section>
      <section class="panel" style="margin-top:16px">
        <div class="panel-head">
          <div class="panel-title">我的矿工</div>
          <div style="color:var(--muted);font-size:13px">当前能量：${money(data.user.energy)}</div>
        </div>
        ${table(['矿工', '消耗', '周期', '已领/总产出', '进度', '可领取', '操作'], minerRows)}
      </section>
      <div class="notice">矿工产出按真实时间线性增长。购买后能量会扣除，领取时由后端计算可领取产出。</div>
    `);
  }
  if (state.view === 'games') {
    const plays = data.gamePlays || [];
    const gameCards = (data.games || []).map((game) => {
      const last = plays.find((item) => item.gameId === game.id);
      const cooldown = game.cooldownMs || data.gameCooldownMs || 0;
      const remaining = last ? Math.max(0, cooldown - (Date.now() - new Date(last.createdAt).getTime())) : 0;
      const disabled = remaining > 0;
      const hours = Math.ceil(remaining / 3600000);
      const rewardText = game.rewardMode === 'flat'
        ? `${game.reward} 能量`
        : `${(game.rewardRate * 100).toFixed(1)}% 运行矿工成本，最高 ${game.maxReward} 能量`;
      return `
        <article class="panel game-card">
          <div class="game-visual"><span></span><span></span><span></span></div>
          <div>
            <div class="game-title">${esc(game.name)}</div>
            <div class="game-desc">${esc(game.description || '')}</div>
            <div class="game-desc">奖励规则：${esc(rewardText)}。冷却：24 小时。</div>
          </div>
          <button class="primary" data-game="${esc(game.id)}" ${disabled ? 'disabled' : ''}>${disabled ? `冷却 ${hours} 小时` : '参与任务'}</button>
        </article>
      `;
    }).join('');
    const playRows = plays.map((item) => `<tr><td>${esc(item.gameName)}</td><td>${money(item.reward)}</td><td>${date(item.createdAt)}</td></tr>`);
    return layout(`
      <section class="grid cols-3">${gameCards}</section>
      <section class="panel" style="margin-top:16px">
        <div class="panel-head"><div class="panel-title">游戏奖励记录</div></div>
        ${table(['游戏', '奖励能量', '时间'], playRows)}
      </section>
      <div class="notice">游戏中心只做辅助活跃奖励，不作为主要产出来源。主要产出来自充值获得能量后购买矿工，并按矿工周期线性增长。</div>
    `);
  }
  if (state.view === 'deposit') {
    const config = data.rechargeConfig || {};
    const isColdWallet = state.rechargeMode === 'cold_wallet';
    return layout(`
      <section class="panel">
        <div class="panel-head"><div class="panel-title">提交充值申请</div></div>
        <div class="panel-body">
          <form class="form" id="deposit-form">
            <div class="field"><label>金额</label><input name="amount" type="number" min="1" step="0.01" required /></div>
            <div class="field">
              <label>充值方式</label>
              <select name="channel" id="recharge-channel">
                <option value="cold_wallet" ${isColdWallet ? 'selected' : ''}>USDT 冷钱包充值</option>
                <option value="credit_card" ${!isColdWallet ? 'selected' : ''}>信用卡充值</option>
              </select>
            </div>
            ${isColdWallet ? `
              <div class="field">
                <label>${esc(config.usdtNetwork || 'TRC20')} 收款地址</label>
                <div class="copy-row">
                  <div class="address-box" id="wallet-address">${esc(config.coldWalletAddress || '')}</div>
                  <button class="ghost" type="button" id="copy-wallet">复制</button>
                </div>
              </div>
              <div class="field"><label>转账哈希 / TxID</label><input name="txHash" placeholder="完成转账后填写交易哈希" required minlength="8" maxlength="120" /></div>
              <div class="field"><label>转账凭证截图</label><input name="receipt" type="file" accept="image/png,image/jpeg,image/webp" required /></div>
              <div class="notice">请确认网络为 ${esc(config.usdtNetwork || 'TRC20')}。后台审核通过后，充值金额会转换为可用能量。</div>
            ` : `
              <div class="field"><label>持卡人姓名</label><input name="cardHolder" autocomplete="cc-name" placeholder="与卡片一致" required minlength="2" maxlength="80" /></div>
              <div class="field"><label>卡号</label><input name="cardNumber" autocomplete="cc-number" inputmode="numeric" placeholder="1234 5678 9012 3456" required minlength="13" maxlength="23" /></div>
              <div class="grid cols-3">
                <div class="field"><label>有效期</label><input name="expiry" autocomplete="cc-exp" inputmode="numeric" placeholder="MM/YY" required maxlength="7" /></div>
                <div class="field"><label>安全码</label><input name="cvv" autocomplete="cc-csc" inputmode="numeric" placeholder="CVV" required minlength="3" maxlength="4" /></div>
                <div class="field"><label>处理方式</label><input value="人工审核" disabled /></div>
              </div>
              <div class="notice">平台不会保存安全码，也不会保存完整卡号，仅保留必要尾号用于订单审核与账务核对。信用卡充值将按合规支付流程处理。</div>
            `}
            <button class="primary" type="submit">提交审核</button>
          </form>
        </div>
      </section>
    `);
  }
  if (state.view === 'withdraw') {
    const feeRate = data.withdrawalFeeRate ?? 0.05;
    const minAmount = data.minWithdrawalAmount ?? 10;
    const dailyLimit = data.dailyWithdrawalLimit ?? 3;
    return layout(`
      <section class="panel">
        <div class="panel-head"><div class="panel-title">提交提现申请</div></div>
        <div class="panel-body">
          <form class="form" id="withdraw-form">
            <div class="field"><label>提现能量</label><input name="amount" type="number" min="${esc(minAmount)}" step="0.01" max="${esc(data.user.withdrawableEnergy || 0)}" required /></div>
            <div class="field"><label>USDT 冷钱包地址（${esc(data.rechargeConfig?.usdtNetwork || 'TRC20')}）</label><input name="walletAddress" placeholder="请输入你的 USDT 冷钱包地址" required minlength="20" maxlength="120" /></div>
            <div class="fee-preview" id="fee-preview">
              <div>提现手续费：${Math.round(feeRate * 100)}%</div>
              <div>预计手续费：0.00</div>
              <div>预计到账：0.00</div>
            </div>
            <button class="primary" type="submit">提交提现</button>
          </form>
          <div class="notice">提现只支持矿工已领取产出。最低 ${money(minAmount)} 能量，每日最多 ${esc(dailyLimit)} 次。提交后会冻结对应可提现能量；审核通过后按 ${Math.round(feeRate * 100)}% 手续费折算付款，管理员会上传付款 TxID 和到账凭证；拒绝后能量全额退回。</div>
        </div>
      </section>
    `);
  }
  const depositRows = data.deposits.map((item) => `<tr><td>${esc(item.id)}</td><td>${money(item.amount)}</td><td>${esc(channelLabel(item.channel))}</td><td>${depositDetail(item)}</td><td>${depositStatus(item)}</td><td>${date(item.createdAt)}</td></tr>`);
  const withdrawalRows = data.withdrawals.map((item) => `<tr><td>${esc(item.id)}</td><td>${money(item.amount)}</td><td>${money(item.fee ?? item.amount * 0.05)}</td><td>${money(item.receiveAmount ?? item.amount * 0.95)}</td><td>${esc(item.walletAddress || item.destination)}</td><td>${payoutDetail(item)}</td><td>${statusTag(item.status)}</td><td>${date(item.createdAt)}</td></tr>`);
  const ledgerRows = data.ledger.map((item) => `<tr><td>${esc(item.type)}</td><td>${money(item.amount)}</td><td>${esc(item.detail)}</td><td>${date(item.createdAt)}</td></tr>`);
  return layout(`
    <section class="grid cols-3">
      <div class="panel stat"><div class="stat-label">可提现能量</div><div class="stat-value">${money(data.user.withdrawableEnergy || 0)}</div></div>
      <div class="panel stat"><div class="stat-label">冻结能量</div><div class="stat-value">${money(data.user.frozen)}</div></div>
      <div class="panel stat"><div class="stat-label">总能量</div><div class="stat-value">${money(data.user.energy)}</div></div>
    </section>
    <section class="grid" style="margin-top:16px">
      <div class="panel"><div class="panel-head"><div class="panel-title">充值记录</div></div>${table(['订单号', '金额', '渠道', '凭证', '状态', '时间'], depositRows)}</div>
      <div class="panel"><div class="panel-head"><div class="panel-title">提现记录</div></div>${table(['订单号', '申请金额', '手续费', '预计到账', '冷钱包地址', '到账记录', '状态', '时间'], withdrawalRows)}</div>
      <div class="panel"><div class="panel-head"><div class="panel-title">资金流水</div></div>${table(['类型', '金额', '说明', '时间'], ledgerRows)}</div>
    </section>
  `);
}

function renderAdmin() {
  const data = state.admin;
  if (!data) return layout('<div class="empty">加载中...</div>');
  if (state.view === 'users') {
    const filters = state.adminFilters || { userQuery: '', userStatus: 'all' };
    const query = (filters.userQuery || '').trim().toLowerCase();
    const filteredUsers = data.users.filter((item) => {
      const matchesQuery = !query || item.username.toLowerCase().includes(query) || item.id.toLowerCase().includes(query);
      const matchesStatus = filters.userStatus === 'all' || item.status === filters.userStatus;
      return matchesQuery && matchesStatus;
    });
    const rows = filteredUsers.map((item) => `
      <tr>
        <td>${esc(item.username)}</td>
        <td>${esc(item.role)}</td>
        <td>${money(item.energy)}</td>
        <td>${money(item.withdrawableEnergy || 0)}</td>
        <td>${money(item.totalRecharge)}</td>
        <td>${money(item.totalWithdrawReceived)}</td>
        <td>${esc(item.activeMinerCount)} / ${esc(item.minerCount)}</td>
        <td>${money(item.totalMined)}</td>
        <td>${statusTag(item.status)}</td>
        <td>${esc(item.riskReason || '-')}</td>
        <td>${date(item.lastLoginAt)}</td>
        <td class="actions">
          <button class="ghost" data-user-detail="${esc(item.id)}">详情</button>
          <button class="success" data-user-status="${esc(item.id)}:active" ${item.status === 'active' ? 'disabled' : ''}>恢复</button>
          <button class="warning" data-user-status="${esc(item.id)}:frozen" ${item.role === 'admin' || item.status === 'frozen' ? 'disabled' : ''}>冻结</button>
          <button class="danger" data-user-status="${esc(item.id)}:banned" ${item.role === 'admin' || item.status === 'banned' ? 'disabled' : ''}>封禁</button>
          <button class="danger" data-reset-password="${esc(item.id)}">重置密码</button>
        </td>
      </tr>
    `);
    const ledgerRows = data.ledger.map((item) => `<tr><td>${esc(item.userId)}</td><td>${esc(item.type)}</td><td>${money(item.amount)}</td><td>${esc(item.detail)}</td><td>${date(item.createdAt)}</td></tr>`);
    return layout(`
      <div class="grid">
        <section class="panel">
          <div class="panel-head"><div class="panel-title">用户列表</div></div>
          <div class="toolbar">
            <input id="user-search" value="${esc(filters.userQuery || '')}" placeholder="搜索用户名或用户ID" />
            <select id="user-status-filter">
              <option value="all" ${filters.userStatus === 'all' ? 'selected' : ''}>全部状态</option>
              <option value="active" ${filters.userStatus === 'active' ? 'selected' : ''}>正常</option>
              <option value="frozen" ${filters.userStatus === 'frozen' ? 'selected' : ''}>冻结</option>
              <option value="banned" ${filters.userStatus === 'banned' ? 'selected' : ''}>封禁</option>
            </select>
            <span>${filteredUsers.length} / ${data.users.length} 个用户</span>
          </div>
          ${table(['用户', '角色', '能量', '可提现', '总充值', '到账提现', '矿工', '累计产出', '状态', '原因', '最近登录', '操作'], rows)}
        </section>
        <section class="panel"><div class="panel-head"><div class="panel-title">最近流水</div></div>${table(['用户ID', '类型', '金额', '说明', '时间'], ledgerRows)}</section>
      </div>
    `);
  }
  if (state.view === 'audit') {
    const rows = data.audit.map((item) => `<tr><td>${esc(item.actorName)}</td><td>${esc(item.action)}</td><td>${esc(item.detail)}</td><td>${date(item.createdAt)}</td></tr>`);
    return layout(`<section class="panel"><div class="panel-head"><div class="panel-title">审计日志</div></div>${table(['操作者', '动作', '详情', '时间'], rows)}</section>`);
  }
  const filters = state.adminFilters || {};
  const depositQuery = (filters.depositQuery || '').trim().toLowerCase();
  const withdrawalQuery = (filters.withdrawalQuery || '').trim().toLowerCase();
  const pendingDeposits = data.deposits.filter((item) => item.status === 'pending').filter((item) => {
    if (!depositQuery) return true;
    return [item.id, item.username, item.details?.txHash, item.details?.cardLast4].some((value) => String(value || '').toLowerCase().includes(depositQuery));
  });
  const pendingWithdrawals = data.withdrawals.filter((item) => item.status === 'pending').filter((item) => {
    if (!withdrawalQuery) return true;
    return [item.id, item.username, item.walletAddress, item.destination].some((value) => String(value || '').toLowerCase().includes(withdrawalQuery));
  });
  const depositRows = pendingDeposits.map((item) => `
    <tr>
      <td>${esc(item.username)}</td><td>${money(item.amount)}</td><td>${esc(channelLabel(item.channel))}</td><td>${depositDetail(item)}</td><td>${date(item.createdAt)}</td>
      <td class="actions"><button class="success" data-review="deposit:${esc(item.id)}:approve">通过</button><button class="danger" data-review="deposit:${esc(item.id)}:reject">拒绝</button></td>
    </tr>
  `);
  const withdrawalRows = pendingWithdrawals.map((item) => `
    <tr>
      <td>${esc(item.username)}</td><td>${money(item.amount)}</td><td>${money(item.fee ?? item.amount * 0.05)}</td><td>${money(item.receiveAmount ?? item.amount * 0.95)}</td><td>${esc(item.walletAddress || item.destination)}</td><td>${date(item.createdAt)}</td>
      <td class="actions"><button class="success" data-approve-withdrawal="${esc(item.id)}">通过</button><button class="danger" data-review="withdrawal:${esc(item.id)}:reject">拒绝</button></td>
    </tr>
  `);
  return layout(`
    <section class="grid cols-3">
      <div class="panel stat"><div class="stat-label">用户数</div><div class="stat-value">${data.users.length}</div></div>
      <div class="panel stat"><div class="stat-label">待审充值</div><div class="stat-value">${pendingDeposits.length}</div></div>
      <div class="panel stat"><div class="stat-label">待审提现</div><div class="stat-value">${pendingWithdrawals.length}</div></div>
    </section>
    <section class="grid" style="margin-top:16px">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">充值审核</div></div>
        <div class="toolbar"><input id="deposit-search" value="${esc(filters.depositQuery || '')}" placeholder="搜索用户名、订单号、TxID、卡尾号" /><span>${pendingDeposits.length} 条待审</span></div>
        ${table(['用户', '金额', '渠道', '凭证', '时间', '操作'], depositRows)}
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">提现审核</div></div>
        <div class="toolbar"><input id="withdrawal-search" value="${esc(filters.withdrawalQuery || '')}" placeholder="搜索用户名、订单号、冷钱包地址" /><span>${pendingWithdrawals.length} 条待审</span></div>
        ${table(['用户', '申请金额', '手续费', '预计到账', '冷钱包地址', '时间', '操作'], withdrawalRows)}
      </div>
    </section>
  `);
}

function render() {
  if (!state.user) return renderAuth();
  state.user.role === 'admin' ? renderAdmin() : renderUser();
  const depositForm = document.querySelector('#deposit-form');
  if (depositForm) depositForm.addEventListener('submit', (event) => { event.preventDefault(); createDeposit(event.target); });
  if (depositForm?.expiry) {
    depositForm.expiry.addEventListener('input', () => {
      depositForm.expiry.value = normalizeExpiryInput(depositForm.expiry.value);
    });
  }
  const withdrawForm = document.querySelector('#withdraw-form');
  if (withdrawForm) withdrawForm.addEventListener('submit', (event) => { event.preventDefault(); createWithdrawal(event.target); });
  if (withdrawForm) {
    const amountInput = withdrawForm.amount;
    const preview = document.querySelector('#fee-preview');
    const updatePreview = () => {
      const amount = Number(amountInput.value || 0);
      const feeRate = state.dashboard?.withdrawalFeeRate ?? 0.05;
      const fee = amount * feeRate;
      const receive = Math.max(0, amount - fee);
      preview.innerHTML = `
        <div>提现手续费：${Math.round(feeRate * 100)}%</div>
        <div>预计手续费：${money(fee)}</div>
        <div>预计到账：${money(receive)}</div>
      `;
    };
    amountInput.addEventListener('input', updatePreview);
    updatePreview();
  }
  document.querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', () => {
      const [type, id, decision] = button.dataset.review.split(':');
      review(type, id, decision);
    });
  });
  document.querySelectorAll('[data-approve-withdrawal]').forEach((button) => {
    button.addEventListener('click', () => openWithdrawalApproval(button.dataset.approveWithdrawal));
  });
  document.querySelectorAll('[data-user-detail]').forEach((button) => {
    button.addEventListener('click', () => openUserDetail(button.dataset.userDetail));
  });
  document.querySelectorAll('[data-user-status]').forEach((button) => {
    button.addEventListener('click', () => {
      const [userId, status] = button.dataset.userStatus.split(':');
      setUserStatus(userId, status);
    });
  });
  const userSearch = document.querySelector('#user-search');
  if (userSearch) {
    userSearch.addEventListener('input', () => {
      state.adminFilters.userQuery = userSearch.value;
      render();
    });
  }
  const userStatusFilter = document.querySelector('#user-status-filter');
  if (userStatusFilter) {
    userStatusFilter.addEventListener('change', () => {
      state.adminFilters.userStatus = userStatusFilter.value;
      render();
    });
  }
  const depositSearch = document.querySelector('#deposit-search');
  if (depositSearch) {
    depositSearch.addEventListener('input', () => {
      state.adminFilters.depositQuery = depositSearch.value;
      render();
    });
  }
  const withdrawalSearch = document.querySelector('#withdrawal-search');
  if (withdrawalSearch) {
    withdrawalSearch.addEventListener('input', () => {
      state.adminFilters.withdrawalQuery = withdrawalSearch.value;
      render();
    });
  }
  document.querySelectorAll('[data-reset-password]').forEach((button) => {
    button.addEventListener('click', () => resetUserPassword(button.dataset.resetPassword));
  });
  document.querySelectorAll('[data-proof]').forEach((button) => {
    button.addEventListener('click', () => openProofPreview(button.dataset.proof));
  });
  document.querySelectorAll('[data-game]').forEach((button) => {
    button.addEventListener('click', () => playGame(button.dataset.game));
  });
  document.querySelectorAll('[data-buy-miner]').forEach((button) => {
    button.addEventListener('click', () => openPurchase(button.dataset.buyMiner));
  });
  document.querySelectorAll('[data-claim-miner]').forEach((button) => {
    button.addEventListener('click', () => claimMiner(button.dataset.claimMiner));
  });
  const rechargeChannel = document.querySelector('#recharge-channel');
  if (rechargeChannel) {
    rechargeChannel.addEventListener('change', () => {
      state.rechargeMode = rechargeChannel.value;
      render();
    });
  }
  const copyWallet = document.querySelector('#copy-wallet');
  if (copyWallet) {
    copyWallet.addEventListener('click', async () => {
      const text = document.querySelector('#wallet-address')?.textContent || '';
      await navigator.clipboard.writeText(text).catch(() => {});
      state.message = '已复制冷钱包地址';
      render();
    });
  }
}

bootstrap();
