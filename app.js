import { createClient } from '@supabase/supabase-js';

// ============================================================
// 个人账簿：前端交互与本地数据管理
// 当前版本没有后端，账目和主题设置均保存在浏览器 localStorage 中。
// ============================================================
// Supabase 项目地址和公钥由 Vite 环境变量提供。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('缺少 Supabase 环境变量，请检查 .env.local');
}

const supabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);
// localStorage 的键名。版本号便于以后改变账目结构时进行数据迁移。
const STORAGE_KEY = 'personal-ledger.entries.v1';
// 保存浅色/深色主题偏好的键名。
const THEME_KEY = 'personal-ledger.theme';
// 各账目标签在明细列表中显示的简写图标。
const icons = { 饮食:'餐', 交通:'行', 住房:'家', 衣装:'衣', 爱好:'趣', 游玩:'游', 工资:'薪', 其他:'记' };
// 将数值格式化成人民币金额，例如 1200 → “¥1,200.00”。
const money = value => `¥${Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
// 将 Date 转为 YYYY-MM-DD；使用本地时间可避免 UTC 日期偏移。
const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
// 获取今天的本地日期字符串。
const today = () => localDate(new Date());

// 页面加载时读取账目，之后所有渲染都以 entries 为数据源。
let entries = [];
// 快速统计默认查看本月，也可以是 week、year 或 custom。
let statsPeriod = 'month';
// 当前 Supabase 登录用户；未登录时为 null。
let currentUser = null;
// 用于忽略过期的异步会话同步结果，并合并并发的迁移操作。
let authSyncToken = 0;
let migrationPromise = null;
// 每个账户在一次页面会话中最多询问一次本地数据迁移。
const migrationCheckedUsers = new Set();

// ==================== Supabase 用户认证 ====================

/** 把 Supabase 常见英文错误转换为易理解的中文提示。 */
function authErrorMessage(error) {
  const message = error?.message || '操作失败，请稍后重试';
  const translations = [
    ['Invalid login credentials', '邮箱或密码错误'],
    ['Email not confirmed', '邮箱尚未验证，请先查收验证邮件'],
    ['User already registered', '该邮箱已经注册'],
    ['Password should be at least', '密码长度不符合要求'],
    ['Unable to validate email address', '邮箱格式不正确'],
    ['Email rate limit exceeded', '邮件发送过于频繁，请稍后再试']
  ];
  const matched = translations.find(([keyword]) => message.includes(keyword));
  return matched ? matched[1] : message;
}

/** 在认证卡片底部显示普通、成功或错误消息。 */
function setAuthMessage(message = '', type = '') {
  const element = document.querySelector('#authMessage');
  element.textContent = message;
  element.className = ('auth-message ' + type).trim();
}

/** 提交期间禁用按钮，避免重复注册或登录。 */
function setAuthSubmitting(form, submitting, pendingText = '') {
  const button = form.querySelector('button[type="submit"]');
  if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
  button.disabled = submitting;
  button.textContent = submitting ? pendingText : button.dataset.defaultText;
}

/** 切换登录与注册表单。 */
function setAuthMode(mode) {
  const registering = mode === 'register';
  document.querySelector('#loginForm').hidden = registering;
  document.querySelector('#registerForm').hidden = !registering;
  document.querySelectorAll('[data-auth-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.authMode === mode);
  });
  setAuthMessage();
}

/** 根据 Supabase 会话显示认证页或账簿页，并更新个人资料。 */
function applyAuthSession(session) {
  currentUser = session?.user || null;
  const signedIn = Boolean(currentUser);
  document.querySelector('#authView').hidden = signedIn;
  document.querySelector('#appView').hidden = !signedIn;
  if (!signedIn) return;

  const username = currentUser.user_metadata?.username?.trim()
    || currentUser.email?.split('@')[0]
    || '记账人';
  document.querySelector('#profileName').textContent = username;
  document.querySelector('#profileEmail').textContent = currentUser.email || '';
  document.querySelector('#profileAvatar').textContent = username.slice(0, 1);
}

/** 注册邮箱账户；用户名保存到 Supabase Auth 的 user_metadata。 */
async function signUp(email, password, username) {
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { username } }
  });
  if (error) throw error;
  return data;
}

/** 使用邮箱和密码登录。 */
async function signIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/** 注销当前 Supabase 会话。 */
async function signOut() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw error;
}

// ==================== 数据读取与通用工具 ====================

/**
 * 读取旧版 localStorage 账目，仅用于一次性迁移。
 * 迁移完成后，页面运行时只使用 Supabase 数据。
 */
function loadLocalEntries(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

/** 把数据库字段转换为当前页面渲染使用的字段名。 */
function mapDatabaseEntry(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amount: Number(row.amount),
    date: row.entry_date,
    tag: row.tag || '其他',
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 从 Supabase 读取当前用户的全部账目，并刷新页面。 */
async function loadEntriesFromSupabase() {
  if (!currentUser) {
    entries = [];
    render();
    return;
  }

  const requestedUserId = currentUser.id;
  const { data, error } = await supabaseClient
    .from('entries')
    .select('id,user_id,type,amount,entry_date,tag,note,created_at,updated_at')
    .eq('user_id', requestedUserId)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  // 请求期间如果切换了账户，不允许旧账户结果覆盖新页面。
  if (currentUser?.id !== requestedUserId) return;
  entries = (data || []).map(mapDatabaseEntry);
  render();
}

/** 在 Supabase 中新增一笔账目。user_id 始终取当前登录用户。 */
async function createEntry(entry) {
  if (!currentUser) throw new Error('请先登录');
  const { data, error } = await supabaseClient
    .from('entries')
    .insert({
      user_id: currentUser.id,
      type: entry.type,
      amount: entry.amount,
      entry_date: entry.date,
      tag: entry.tag || null,
      note: entry.note || null
    })
    .select('id,user_id,type,amount,entry_date,tag,note,created_at,updated_at')
    .single();
  if (error) throw error;
  return mapDatabaseEntry(data);
}

/** 删除指定账目；RLS 和 user_id 条件共同限制数据归属。 */
async function deleteEntry(id) {
  if (!currentUser) throw new Error('请先登录');
  const { error } = await supabaseClient
    .from('entries')
    .delete()
    .eq('id', id)
    .eq('user_id', currentUser.id);
  if (error) throw error;
}

/**
 * 更新指定账目。当前还没有编辑界面，但数据层已经具备 Update 能力。
 * 只发送允许修改的业务字段，避免客户端改变 id 和 user_id。
 */
async function updateEntry(id, changes) {
  if (!currentUser) throw new Error('请先登录');
  const update = { updated_at: new Date().toISOString() };
  if ('type' in changes) update.type = changes.type;
  if ('amount' in changes) update.amount = changes.amount;
  if ('date' in changes) update.entry_date = changes.date;
  if ('tag' in changes) update.tag = changes.tag || null;
  if ('note' in changes) update.note = changes.note || null;

  const { data, error } = await supabaseClient
    .from('entries')
    .update(update)
    .eq('id', id)
    .eq('user_id', currentUser.id)
    .select('id,user_id,type,amount,entry_date,tag,note,created_at,updated_at')
    .single();
  if (error) throw error;
  return mapDatabaseEntry(data);
}

/**
 * 检测旧版 localStorage 数据并在用户确认后批量迁移。
 * 任一数据无效或上传失败都会保留全部本地数据；只有成功后才清除。
 */
async function migrateLocalEntries() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const localEntries = loadLocalEntries();
    if (!localEntries.length || !currentUser) return 0;
    if (migrationCheckedUsers.has(currentUser.id)) return 0;
    migrationCheckedUsers.add(currentUser.id);

    const accepted = confirm(
      '检测到 ' + localEntries.length + ' 笔本地账目。是否迁移到当前登录账户？\n\n' +
      '全部上传成功后，本地旧数据才会被清除。'
    );
    if (!accepted) return 0;

    const invalid = localEntries.some(item =>
      !['income', 'expense'].includes(item.type)
      || !Number.isFinite(Number(item.amount))
      || Number(item.amount) <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)
    );
    if (invalid) throw new Error('本地账目中存在无效数据，已取消迁移并保留原数据');

    const rows = localEntries.map(item => ({
      user_id: currentUser.id,
      type: item.type,
      amount: Number(item.amount),
      entry_date: item.date,
      tag: item.tag || null,
      note: item.note?.trim() || null
    }));
    const { error } = await supabaseClient.from('entries').insert(rows);
    if (error) throw error;

    localStorage.removeItem(STORAGE_KEY);
    showToast('已迁移 ' + rows.length + ' 笔本地账目');
    return rows.length;
  })();

  try {
    return await migrationPromise;
  } finally {
    migrationPromise = null;
  }
}

/** 登录状态变化后迁移旧数据并加载当前账户账目。 */
async function syncAuthSession(session) {
  const token = ++authSyncToken;
  applyAuthSession(session);
  if (!currentUser) {
    entries = [];
    render();
    return;
  }

  try {
    await migrateLocalEntries();
    if (token !== authSyncToken) return;
    await loadEntriesFromSupabase();
  } catch (error) {
    console.error(error);
    if (token !== authSyncToken) return;
    entries = [];
    render();
    showToast('账目同步失败：' + (error.message || '请稍后重试'));
  }
}
/**
 * 转义用户输入中的 HTML 特殊字符。
 * 标签和备注会进入 innerHTML，转义可防止它们被作为 HTML/脚本执行。
 */
function escapeHTML(value=''){ return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
/** 汇总指定账目数组，返回收入合计和支出合计。 */
function summarize(list){ return list.reduce((acc,item)=>{ acc[item.type]+=Number(item.amount); return acc; },{income:0,expense:0}); }
/** 判断账目日期是否在区间内；空的起止日期表示不限制该方向。 */
function inRange(item,start,end){ return (!start || item.date>=start) && (!end || item.date<=end); }
/** 计算本周、本月或本年的开始日期，以及作为结束日期的今天。 */
function periodRange(period){
  const now=new Date(); let start=new Date(now), end=new Date(now);
  // getDay() 中周日为 0；换算后周一为 0，以便定位本周周一。
  if(period==='week'){ const day=(now.getDay()+6)%7; start.setDate(now.getDate()-day); }
  if(period==='month') start=new Date(now.getFullYear(),now.getMonth(),1);
  if(period==='year') start=new Date(now.getFullYear(),0,1);
  return [localDate(start),localDate(end)];
}
// ==================== 账目列表与首页渲染 ====================

/** 把单条账目转为列表 HTML；data-delete 保存待删除账目的 id。 */
function transactionHTML(item){
  const sign=item.type==='income'?'+':'−';
  return `<article class="transaction"><span class="tag-icon">${icons[item.tag]||'记'}</span><div><h3>${escapeHTML(item.tag)}${item.note?` · ${escapeHTML(item.note)}`:''}</h3><p>${escapeHTML(item.date)}</p></div><strong class="${item.type}">${sign}${money(item.amount)}</strong><button class="delete-button" data-delete="${item.id}" aria-label="删除账目">×</button></article>`;
}
/** 渲染账目数组；没有数据时显示统一的空状态。 */
function renderList(target,list){ target.innerHTML=list.length?list.map(transactionHTML).join(''):'<div class="empty">还没有符合条件的账目</div>'; }
/** 新增或删除后调用此总入口，同步更新首页、查询和统计。 */
function render(){
  // 日期倒序；同一天再按 id（创建时间）倒序。
  entries.sort((a,b)=>b.date.localeCompare(a.date)||(b.createdAt || '').localeCompare(a.createdAt || ''));
  const [start,end]=periodRange('month'); const month=entries.filter(e=>inRange(e,start,end)); const total=summarize(month);
  document.querySelector('#monthIncome').textContent=money(total.income); document.querySelector('#monthExpense').textContent=money(total.expense); document.querySelector('#monthBalance').textContent=money(total.income-total.expense);
  renderList(document.querySelector('#recentList'),entries.slice(0,5));
  renderFiltered(); renderStats(); populateTags();
}
// ==================== 明细筛选与快速统计 ====================

/** 从已有账目提取并去重标签，动态生成筛选选项。 */
function populateTags(){
  const select=document.querySelector('#filterTag'); const selected=select.value; const tags=[...new Set(entries.map(e=>e.tag))];
  select.innerHTML='<option value="">全部标签</option>'+tags.map(t=>`<option>${escapeHTML(t)}</option>`).join(''); select.value=selected;
}
/** 读取日期与标签条件，筛选 entries 后刷新查询列表。 */
function renderFiltered(){ const start=document.querySelector('#startDate').value,end=document.querySelector('#endDate').value,tag=document.querySelector('#filterTag').value; renderList(document.querySelector('#queryList'),entries.filter(e=>inRange(e,start,end)&&(!tag||e.tag===tag))); }
/** 根据当前周期刷新收入、支出和按标签汇总结果。 */
function renderStats(){
  // 自定义周期读取输入框，其他周期由 periodRange() 计算。
  let range=statsPeriod==='custom'?[document.querySelector('#statsStart').value,document.querySelector('#statsEnd').value]:periodRange(statsPeriod);
  const list=entries.filter(e=>inRange(e,...range)), total=summarize(list); document.querySelector('#statsIncome').textContent=money(total.income); document.querySelector('#statsExpense').textContent=money(total.expense);
  // 按标签累加金额；max 用来计算各比例条相对于最大值的宽度。
  const groups={}; list.forEach(e=>groups[e.tag]=(groups[e.tag]||0)+Number(e.amount)); const max=Math.max(1,...Object.values(groups));
  document.querySelector('#categoryStats').innerHTML=Object.keys(groups).length?Object.entries(groups).sort((a,b)=>b[1]-a[1]).map(([tag,value])=>`<div class="category-row"><div><span>${escapeHTML(tag)}</span><b>${money(value)}</b></div><div class="bar"><i style="width:${value/max*100}%"></i></div></div>`).join(''):'<div class="empty">该时段暂无数据</div>';
}
// ==================== 导航、主题、弹窗与提示 ====================

/** 切换主页面，并同步标题、导航状态及添加按钮可见性。 */
function navigate(page){
  document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.dataset.page===page)); document.querySelectorAll('.bottom-nav button').forEach(el=>el.classList.toggle('active',el.dataset.nav===page));
  const titles={ledger:'钱从哪里来，又到哪里去？',query:'每一笔，都清清楚楚。',profile:'我的账簿'}; document.querySelector('#pageTitle').textContent=titles[page]; document.querySelector('#addButton').hidden=page!=='ledger'; window.scrollTo({top:0,behavior:'smooth'});
}
/** 应用主题、同步开关和浏览器主题色，并保存用户选择。 */
function setTheme(dark){ document.body.classList.toggle('dark',dark); document.querySelector('#darkMode').checked=dark; localStorage.setItem(THEME_KEY,dark?'dark':'light'); document.querySelector('meta[name="theme-color"]').content=dark?'#161916':'#f6f3ed'; }
/** 显示 1.8 秒的提示；连续触发时重新开始计时。 */
function showToast(message){ const el=document.querySelector('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>el.classList.remove('show'),1800); }
/** 打开新增弹窗，默认选择今天，并在动画后聚焦金额框。 */
function openModal(){ document.querySelector('#entryDate').value=today(); document.querySelector('#entryModal').hidden=false; setTimeout(()=>document.querySelector('#amount').focus(),100); }
/** 关闭新增账目弹窗。 */
function closeModal(){ document.querySelector('#entryModal').hidden=true; }

// ==================== 用户操作与事件绑定 ====================

/** 使用事件委托处理点击，动态生成的删除按钮也能被识别。 */
document.addEventListener('click',async event=>{
  // data-nav 同时用于底部导航和首页“查看全部”。
  const nav=event.target.closest('[data-nav]'); if(nav) navigate(nav.dataset.nav);
  if(event.target.closest('#addButton')) openModal(); if(event.target.closest('[data-close-modal]')) closeModal();
  // 删除前确认，成功后保存数据并刷新界面。
  const del=event.target.closest('[data-delete]');
  if(del && confirm('确定删除这笔账目吗？')) {
    try {
      await deleteEntry(del.dataset.delete);
      await loadEntriesFromSupabase();
      showToast('账目已删除');
    } catch(error) {
      console.error(error);
      showToast('删除失败：' + (error.message || '请稍后重试'));
    }
  }
  // 切换“明细查询”和“快速统计”面板。
  const mode=event.target.closest('[data-query-mode]'); if(mode){ document.querySelectorAll('[data-query-mode]').forEach(b=>b.classList.toggle('active',b===mode)); const stats=mode.dataset.queryMode==='stats'; document.querySelector('#detailPanel').hidden=stats; document.querySelector('#statsPanel').hidden=!stats; renderStats(); }
  // 切换统计周期；只有 custom 显示自定义日期框。
  const period=event.target.closest('[data-period]'); if(period){ statsPeriod=period.dataset.period; document.querySelectorAll('[data-period]').forEach(b=>b.classList.toggle('active',b===period)); document.querySelector('#customRange').hidden=statsPeriod!=='custom'; renderStats(); }
});
/**
 * 提交新增账目：阻止刷新、校验金额、保存数据，再清空表单并刷新。
 * Date.now() 在当前本地原型中暂作为唯一 id。
 */
document.querySelector('#entryForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const amount = Number(document.querySelector('#amount').value);
  if(!amount || amount <= 0) {
    showToast('请输入大于0的有效金额');
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = '保存中…';
  try {
    await createEntry({
      type: new FormData(form).get('type'),
      amount,
      date: document.querySelector('#entryDate').value,
      tag: document.querySelector('#entryTag').value,
      note: document.querySelector('#note').value.trim()
    });
    await loadEntriesFromSupabase();
    form.reset();
    closeModal();
    showToast('账目已保存');
  } catch(error) {
    console.error(error);
    showToast('保存失败：' + (error.message || '请稍后重试'));
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '保存账目';
  }
});

// 登录/注册页签切换。
document.querySelectorAll('[data-auth-mode]').forEach(button => {
  button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
});

// 登录表单提交。
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setAuthSubmitting(form, true, '登录中…');
  setAuthMessage();
  try {
    const email = document.querySelector('#loginEmail').value.trim();
    const password = document.querySelector('#loginPassword').value;
    const { session } = await signIn(email, password);
    await syncAuthSession(session);
    form.reset();
  } catch (error) {
    setAuthMessage(authErrorMessage(error), 'error');
  } finally {
    setAuthSubmitting(form, false);
  }
});

// 注册表单提交。启用邮箱确认时 session 为空，需要先验证邮件。
document.querySelector('#registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setAuthSubmitting(form, true, '注册中…');
  setAuthMessage();
  try {
    const username = document.querySelector('#registerUsername').value.trim();
    const email = document.querySelector('#registerEmail').value.trim();
    const password = document.querySelector('#registerPassword').value;
    const { session } = await signUp(email, password, username);
    form.reset();
    if (session) {
      await syncAuthSession(session);
    } else {
      setAuthMessage('注册成功，请前往邮箱完成验证后再登录。', 'success');
    }
  } catch (error) {
    setAuthMessage(authErrorMessage(error), 'error');
  } finally {
    setAuthSubmitting(form, false);
  }
});
// 提交查询表单时按当前条件重新筛选。
document.querySelector('#filterForm').addEventListener('submit',event=>{event.preventDefault();renderFiltered();});
// 自定义日期改变时立即更新统计。
document.querySelectorAll('#statsStart,#statsEnd').forEach(el=>el.addEventListener('change',renderStats));
// “我的”页面和顶部快捷按钮都可以切换主题。
document.querySelector('#darkMode').addEventListener('change',event=>setTheme(event.target.checked)); document.querySelector('#themeShortcut').addEventListener('click',()=>setTheme(!document.body.classList.contains('dark'))); document.querySelector('#authThemeShortcut').addEventListener('click',()=>setTheme(!document.body.classList.contains('dark')));
// 修改密码留待后续实现；退出登录已经连接 Supabase Auth。
document.querySelector('#changePassword').addEventListener('click',()=>showToast('修改密码功能将在下一步实现'));
document.querySelector('#logout').addEventListener('click',async()=>{
  try {
    await signOut();
    navigate('ledger');
    setAuthMode('login');
    setAuthMessage('已安全退出登录。', 'success');
  } catch(error) {
    showToast(authErrorMessage(error));
  }
});
// ==================== 页面初始化 ====================

// 恢复主题和表单日期，并从 Supabase 恢复上次登录会话。
async function initializeApp() {
  setTheme(localStorage.getItem(THEME_KEY)==='dark');
  document.querySelector('#entryDate').value=today();
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) setAuthMessage(authErrorMessage(error), 'error');
  await syncAuthSession(data?.session || null);
}

// 登录、退出或邮箱验证回跳时，让页面与最新会话保持一致。
supabaseClient.auth.onAuthStateChange((_event, session) => {
  // 避免在 Supabase Auth 回调内部等待其他 Supabase 请求。
  setTimeout(() => syncAuthSession(session), 0);
});

initializeApp();
