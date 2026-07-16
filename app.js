const STORAGE_KEY = 'personal-ledger.entries.v1';
const THEME_KEY = 'personal-ledger.theme';
const icons = { 饮食:'餐', 交通:'行', 住房:'家', 衣装:'衣', 爱好:'趣', 游玩:'游', 工资:'薪', 其他:'记' };
const money = value => `¥${Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const today = () => localDate(new Date());

let entries = loadEntries();
let statsPeriod = 'month';

function loadEntries(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveEntries(){ localStorage.setItem(STORAGE_KEY,JSON.stringify(entries)); }
function escapeHTML(value=''){ return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function summarize(list){ return list.reduce((acc,item)=>{ acc[item.type]+=Number(item.amount); return acc; },{income:0,expense:0}); }
function inRange(item,start,end){ return (!start || item.date>=start) && (!end || item.date<=end); }
function periodRange(period){
  const now=new Date(); let start=new Date(now), end=new Date(now);
  if(period==='week'){ const day=(now.getDay()+6)%7; start.setDate(now.getDate()-day); }
  if(period==='month') start=new Date(now.getFullYear(),now.getMonth(),1);
  if(period==='year') start=new Date(now.getFullYear(),0,1);
  return [localDate(start),localDate(end)];
}
function transactionHTML(item){
  const sign=item.type==='income'?'+':'−';
  return `<article class="transaction"><span class="tag-icon">${icons[item.tag]||'记'}</span><div><h3>${escapeHTML(item.tag)}${item.note?` · ${escapeHTML(item.note)}`:''}</h3><p>${escapeHTML(item.date)}</p></div><strong class="${item.type}">${sign}${money(item.amount)}</strong><button class="delete-button" data-delete="${item.id}" aria-label="删除账目">×</button></article>`;
}
function renderList(target,list){ target.innerHTML=list.length?list.map(transactionHTML).join(''):'<div class="empty">还没有符合条件的账目</div>'; }
function render(){
  entries.sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);
  const [start,end]=periodRange('month'); const month=entries.filter(e=>inRange(e,start,end)); const total=summarize(month);
  document.querySelector('#monthIncome').textContent=money(total.income); document.querySelector('#monthExpense').textContent=money(total.expense); document.querySelector('#monthBalance').textContent=money(total.income-total.expense);
  renderList(document.querySelector('#recentList'),entries.slice(0,5));
  renderFiltered(); renderStats(); populateTags();
}
function populateTags(){
  const select=document.querySelector('#filterTag'); const selected=select.value; const tags=[...new Set(entries.map(e=>e.tag))];
  select.innerHTML='<option value="">全部标签</option>'+tags.map(t=>`<option>${escapeHTML(t)}</option>`).join(''); select.value=selected;
}
function renderFiltered(){ const start=document.querySelector('#startDate').value,end=document.querySelector('#endDate').value,tag=document.querySelector('#filterTag').value; renderList(document.querySelector('#queryList'),entries.filter(e=>inRange(e,start,end)&&(!tag||e.tag===tag))); }
function renderStats(){
  let range=statsPeriod==='custom'?[document.querySelector('#statsStart').value,document.querySelector('#statsEnd').value]:periodRange(statsPeriod);
  const list=entries.filter(e=>inRange(e,...range)), total=summarize(list); document.querySelector('#statsIncome').textContent=money(total.income); document.querySelector('#statsExpense').textContent=money(total.expense);
  const groups={}; list.forEach(e=>groups[e.tag]=(groups[e.tag]||0)+Number(e.amount)); const max=Math.max(1,...Object.values(groups));
  document.querySelector('#categoryStats').innerHTML=Object.keys(groups).length?Object.entries(groups).sort((a,b)=>b[1]-a[1]).map(([tag,value])=>`<div class="category-row"><div><span>${escapeHTML(tag)}</span><b>${money(value)}</b></div><div class="bar"><i style="width:${value/max*100}%"></i></div></div>`).join(''):'<div class="empty">该时段暂无数据</div>';
}
function navigate(page){
  document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.dataset.page===page)); document.querySelectorAll('.bottom-nav button').forEach(el=>el.classList.toggle('active',el.dataset.nav===page));
  const titles={ledger:'钱从哪里来，又到哪里去？',query:'每一笔，都清清楚楚。',profile:'我的账簿'}; document.querySelector('#pageTitle').textContent=titles[page]; document.querySelector('#addButton').hidden=page!=='ledger'; window.scrollTo({top:0,behavior:'smooth'});
}
function setTheme(dark){ document.body.classList.toggle('dark',dark); document.querySelector('#darkMode').checked=dark; localStorage.setItem(THEME_KEY,dark?'dark':'light'); document.querySelector('meta[name="theme-color"]').content=dark?'#161916':'#f6f3ed'; }
function showToast(message){ const el=document.querySelector('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>el.classList.remove('show'),1800); }
function openModal(){ document.querySelector('#entryDate').value=today(); document.querySelector('#entryModal').hidden=false; setTimeout(()=>document.querySelector('#amount').focus(),100); }
function closeModal(){ document.querySelector('#entryModal').hidden=true; }

document.addEventListener('click',event=>{
  const nav=event.target.closest('[data-nav]'); if(nav) navigate(nav.dataset.nav);
  if(event.target.closest('#addButton')) openModal(); if(event.target.closest('[data-close-modal]')) closeModal();
  const del=event.target.closest('[data-delete]'); if(del&&confirm('确定删除这笔账目吗？')){ entries=entries.filter(e=>String(e.id)!==del.dataset.delete); saveEntries(); render(); showToast('账目已删除'); }
  const mode=event.target.closest('[data-query-mode]'); if(mode){ document.querySelectorAll('[data-query-mode]').forEach(b=>b.classList.toggle('active',b===mode)); const stats=mode.dataset.queryMode==='stats'; document.querySelector('#detailPanel').hidden=stats; document.querySelector('#statsPanel').hidden=!stats; renderStats(); }
  const period=event.target.closest('[data-period]'); if(period){ statsPeriod=period.dataset.period; document.querySelectorAll('[data-period]').forEach(b=>b.classList.toggle('active',b===period)); document.querySelector('#customRange').hidden=statsPeriod!=='custom'; renderStats(); }
});
document.querySelector('#entryForm').addEventListener('submit',event=>{ event.preventDefault(); const amount=Number(document.querySelector('#amount').value); if(!amount||amount<=0)return; entries.push({id:Date.now(),userId:'local-user',type:new FormData(event.currentTarget).get('type'),amount,date:document.querySelector('#entryDate').value,tag:document.querySelector('#entryTag').value,note:document.querySelector('#note').value.trim()}); saveEntries(); event.currentTarget.reset(); closeModal(); render(); showToast('账目已保存'); });
document.querySelector('#filterForm').addEventListener('submit',event=>{event.preventDefault();renderFiltered();});
document.querySelectorAll('#statsStart,#statsEnd').forEach(el=>el.addEventListener('change',renderStats));
document.querySelector('#darkMode').addEventListener('change',event=>setTheme(event.target.checked)); document.querySelector('#themeShortcut').addEventListener('click',()=>setTheme(!document.body.classList.contains('dark')));
document.querySelector('#changePassword').addEventListener('click',()=>showToast('需连接账户服务后使用')); document.querySelector('#logout').addEventListener('click',()=>showToast('当前为本地体验模式'));
setTheme(localStorage.getItem(THEME_KEY)==='dark'); document.querySelector('#entryDate').value=today(); render();
