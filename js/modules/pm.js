/**
 * MBO+AI 项目管理模块 (Project Management)
 * V0.2.0 - 研发项目管理 + HTML 弹窗
 * 功能: 项目列表(卡片), 项目详情(任务看板), 进度跟踪, 人员状态
 * 数据: Supabase projects / project_tasks + localStorage 缓存
 */

if(!window._pmInit){
window._pmInit=true;

// ===== Constants =====
var SUPABASE_PM_TABLE = 'projects';
var SUPABASE_TASK_TABLE = 'project_tasks';
var PM_CACHE_PREFIX = 'hwm_pm_';
// ★ V0.6.4k: 项目类别改为业务语义命名（key 保持不变，历史数据与研发阶段门引擎零影响）
var PM_TYPE_DEFS = [
  {key:'全部', label:'全部项目'},
  {key:'协同', label:'跨部门协作项目'},
  {key:'研发', label:'新产品开发项目'},
  {key:'通用', label:'独立中小型项目'}
];
function pmTypeLabel(key){
  var d = PM_TYPE_DEFS.find(function(t){return t.key===key;});
  return d?d.label:(key||'');
}

// ===== State =====
var _pmCurrent = null;       // {project, tasks}
var _pmView = 'list';        // list / detail / board
var _pmFilter = {type:'全部', search:'', owner:''};
var _pmProjects = [];
var _pmMotionPlayed = false; // ★ V0.6.4La: 入场动效仅在进入模块的首次渲染播放一次

// ===== Data Layer =====
function loadAllProjects(){ return JSON.parse(localStorage.getItem(PM_CACHE_PREFIX+'all')||'[]'); }
function saveAllProjects(arr){ localStorage.setItem(PM_CACHE_PREFIX+'all', JSON.stringify(arr)); }

async function syncProjectsFromCloud(){
  try{
    var resp = await supabase.from(SUPABASE_PM_TABLE).select('*').order('updated_at',{ascending:false});
    if(resp.error){ console.warn('[PM] Cloud sync error:',resp.error.message); return; }
    var cloud = resp.data||[];
    saveAllProjects(cloud);
    return cloud;
  }catch(e){ console.warn('[PM] Cloud sync exception:',e.message); }
}

async function saveProject(p){
  p.updated_at = new Date().toISOString();
  var all = loadAllProjects();
  var idx = all.findIndex(function(x){return x.id===p.id;});
  if(idx>=0) all[idx]=p; else all.push(p);
  saveAllProjects(all);
  try{
    var r = await supabase.from(SUPABASE_PM_TABLE).upsert(p,{onConflict:'id'});
    if(r.error) console.warn('[PM] Save error:',r.error.message);
  }catch(e){ console.warn('[PM] Save exception:',e.message); }
}

async function createProject(data){
  var p = Object.assign({
    type:'研发', level:3, status:'草稿中', progress:0,
    team:[], milestones:[], description:'', english_name:'',
    budget_pool:null, start_date:null, end_date:null,
    created_by: (currentUser&&currentUser.name)||'',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, data);
  if(!p.name){ _showAlert('请输入项目名称'); return null; }
  if(!p.owner) p.owner = (currentUser&&currentUser.name)||'';
  try{
    var r = await supabase.from(SUPABASE_PM_TABLE).insert(p).select();
    if(r.error){ _showAlert('创建失败: '+r.error.message); return null; }
    var np = r.data[0];
    var all = loadAllProjects(); all.unshift(np); saveAllProjects(all);
    showToast('项目已创建');
    _pmProjects = all; renderPMList();
    return np;
  }catch(e){ _showAlert('创建异常: '+e.message); return null; }
}

async function deleteProject(id){
  var ok = await _showConfirm('确认删除此项目？\n\n删除后不可恢复。\n\nConfirm delete? This action cannot be undone.','警告 / Warning');
  if(!ok) return;
  try{
    await supabase.from(SUPABASE_TASK_TABLE).delete().eq('project_id',id);
    // ★ V1.0 RDPM: 清理研发阶段门数据（无数据时为空操作）
    if(typeof rdCleanupProject==='function') await rdCleanupProject(id);
    await supabase.from(SUPABASE_PM_TABLE).delete().eq('id',id);
    var all = loadAllProjects().filter(function(x){return x.id!==id;});
    saveAllProjects(all); _pmProjects = all;
    if(_pmCurrent&&_pmCurrent.project&&_pmCurrent.project.id===id){ _pmCurrent = null; _pmView = 'list'; }
    // ★ V0.6.4L: 详情页删除后切回列表视图（含研发阶段门详情）
    if(typeof _rdCurrent!=='undefined'&&_rdCurrent&&_rdCurrent.project&&_rdCurrent.project.id===id)_rdCurrent=null;
    backToPMList();
    renderPMList();
    showToast('项目已删除');
  }catch(e){ _showAlert('删除异常: '+e.message); }
}

// ===== Tasks =====
function loadProjectTasks(pid){
  var k = PM_CACHE_PREFIX+'tasks_'+pid;
  return JSON.parse(localStorage.getItem(k)||'[]');
}
function saveProjectTasks(pid, arr){
  localStorage.setItem(PM_CACHE_PREFIX+'tasks_'+pid, JSON.stringify(arr));
}

async function syncTasksFromCloud(pid){
  try{
    var resp = await supabase.from(SUPABASE_TASK_TABLE).select('*').eq('project_id',pid).order('order_index');
    if(resp.error){ console.warn('[PM] Task sync error:',resp.error.message); return; }
    var tasks = resp.data||[];
    saveProjectTasks(pid, tasks);
    return tasks;
  }catch(e){ console.warn('[PM] Task sync exception:',e.message); }
}

async function saveTask(t){
  t.updated_at = new Date().toISOString();
  var tasks = loadProjectTasks(t.project_id);
  var idx = tasks.findIndex(function(x){return x.id===t.id;});
  if(idx>=0) tasks[idx]=t; else tasks.push(t);
  saveProjectTasks(t.project_id, tasks);
  try{
    var r = await supabase.from(SUPABASE_TASK_TABLE).upsert(t,{onConflict:'id'});
    if(r.error) console.warn('[PM] Task save error:',r.error.message);
  }catch(e){ console.warn('[PM] Task save exception:',e.message); }
}

async function createTask(project_id, data){
  var t = Object.assign({
    project_id:project_id, status:'待开始', priority:'普通', progress:0,
    order_index: loadProjectTasks(project_id).length,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }, data);
  if(!t.title){ _showAlert('请输入任务名称'); return null; }
  try{
    var r = await supabase.from(SUPABASE_TASK_TABLE).insert(t).select();
    if(r.error){ _showAlert('创建任务失败: '+r.error.message); return null; }
    var nt = r.data[0];
    var tasks = loadProjectTasks(project_id); tasks.push(nt); saveProjectTasks(project_id, tasks);
    return nt;
  }catch(e){ _showAlert('创建任务异常: '+e.message); return null; }
}

async function deleteTask(project_id, task_id){
  try{
    await supabase.from(SUPABASE_TASK_TABLE).delete().eq('id',task_id);
    var tasks = loadProjectTasks(project_id).filter(function(x){return x.id!==task_id;});
    saveProjectTasks(project_id, tasks);
    if(_pmCurrent&&_pmCurrent.tasks) _pmCurrent.tasks = tasks;
    renderPMTaskBoard();
    var p = _pmCurrent.project;
    p.progress = calcProjectProgress(project_id);
    await saveProject(p);
  }catch(e){ console.warn('[PM] Delete task error:',e.message); }
}

// ===== Progress Calculation =====
function calcProjectProgress(pid){
  var tasks = loadProjectTasks(pid);
  if(!tasks.length) return 0;
  var total = 0;
  tasks.forEach(function(t){ total += (t.progress||0); });
  return Math.round(total / tasks.length);
}

// ===== UI: Project List (Card Grid) =====
function renderPMList(){
  if(!document.getElementById('pmView')) return;
  var el = document.getElementById('pmContent');
  if(!el) return;

  // ★ V0.6.4L: 统一筛选维度（侧边栏为唯一筛选入口，删除顶部重复下拉）
  var projects = _pmProjects||[];
  if(_pmFilter.type && _pmFilter.type!=='全部'){
    projects = projects.filter(function(p){return p.type===_pmFilter.type;});
  }
  if(_pmFilter.owner){
    projects = projects.filter(function(p){return p.owner===_pmFilter.owner;});
  }
  if(_pmFilter._active){
    projects = projects.filter(function(p){return p.status==='实施中';});
  }
  if(_pmFilter.level){
    projects = projects.filter(function(p){return String(p.level)===String(_pmFilter.level);});
  }
  if(_pmFilter.search){
    var s = _pmFilter.search.toLowerCase();
    projects = projects.filter(function(p){return (p.name||'').toLowerCase().indexOf(s)>=0;});
  }

  // 当前筛选条件描述
  var crumbs = [];
  if(_pmFilter.owner) crumbs.push('我的项目');
  else if(_pmFilter._active) crumbs.push('进行中');
  else crumbs.push(pmTypeLabel(_pmFilter.type));
  if(_pmFilter.level) crumbs.push(['','一级','二级','三级'][_pmFilter.level]||'');

  var html = '';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
  html += '<div style="font-size:12px;color:#6E6A63">'+esc(crumbs.join(' · '))+' <span style="color:#A8A29A">· '+projects.length+' 个项目</span></div>';
  html += '<input placeholder="搜索项目…" value="'+esc(_pmFilter.search)+'" oninput="_pmFilter.search=this.value;renderPMList()" style="padding:6px 12px;border:1px solid #D8D3C8;border-radius:8px;font-size:12px;width:180px;background:#fff;outline:none">';
  html += '</div>';

  if(!projects.length){
    html += '<div style="text-align:center;padding:70px 20px;color:#A8A29A;font-size:13px">暂无符合条件的项目</div>';
  }else{
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">';
    projects.forEach(function(p,i){ html += renderProjectCard(p,i,!_pmMotionPlayed); });
    html += '</div>';
  }

  el.innerHTML = html;
  // ★ V0.6.4La: 首次渲染完成后锁定动效，后续筛选/点击/云端同步全部静默更新
  _pmMotionPlayed = true;

  // ★ V1.0 RDPM: 预取研发项目阶段数据（驱动卡片阶段条）
  if(typeof rdPrefetchStages==='function'){
    var rdPids = projects.filter(function(p){return p.type==='研发';}).map(function(p){return p.id;});
    if(rdPids.length) rdPrefetchStages(rdPids);
  }
}

function renderProjectCard(p, idx, anim){
  // ★ V0.6.4L 水墨屏体系：发丝线、墨黑/朱砂/黛绿、无阴影
  var lvlMeta = {'1':{label:'一级',ink:'#B3382C'},'2':{label:'二级',ink:'#6E6A63'},'3':{label:'三级',ink:'#C9C4BA'}};
  var lm = lvlMeta[p.level]||lvlMeta['3'];
  var statusMeta = {
    '草稿中':{c:'#A8A29A',fill:false},'审批中':{c:'#6E6A63',fill:false},
    '实施中':{c:'#1F1F1F',fill:true},'已完成':{c:'#2F5D50',fill:false},
    '已逾期':{c:'#B3382C',fill:false},'待复审':{c:'#6E6A63',fill:false},'已中止':{c:'#A8A29A',fill:false}
  };
  var sm = statusMeta[p.status]||statusMeta['草稿中'];

  var h = '';
  h += '<div onclick="openPMDetail('+p.id+')" class="pm-card'+(anim?' pm-card-anim':'')+'" style="'+(anim?('animation-delay:'+((idx||0)*40)+'ms;'):'')+'position:relative;display:flex;background:#fff;border-radius:10px;border:1px solid #E3E0D9;overflow:hidden;cursor:pointer">';
  h += '<div style="width:2px;min-width:2px;background:'+lm.ink+'"></div>';
  h += '<div style="flex:1;padding:14px 16px">';
  h += '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">';
  h += '<div style="font-weight:600;font-size:15px;color:#1F1F1F;line-height:1.35">'+esc(p.name||'未命名')+'</div>';
  h += '<div style="display:flex;gap:4px;flex-shrink:0;align-items:center">';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:9px;border:1px solid '+lm.ink+';color:'+lm.ink+'">'+lm.label+'</span>';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:9px;border:1px solid #C9C4BA;color:#6E6A63">'+esc(pmTypeLabel(p.type))+'</span>';
  h += '<button class="pm-del-btn" onclick="event.stopPropagation();deleteProject('+p.id+')" title="删除项目" style="padding:2px 8px;border:0;background:transparent;font-size:11px;color:#A8A29A;cursor:pointer">删除</button>';
  h += '</div></div>';
  h += '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:11px;color:#6E6A63;margin-bottom:4px"><span>进度</span><span style="font-weight:600;color:#1F1F1F">'+(p.progress||0)+'%</span></div>';
  h += '<div style="height:4px;background:#EFEDE8;border-radius:2px;overflow:hidden"><div style="height:100%;width:'+(p.progress||0)+'%;background:#1F1F1F;border-radius:2px"></div></div></div>';
  // ★ V1.0 RDPM: 研发项目卡片显示 7 段阶段条（数据来自 rdpm.js 缓存，不影响其他类型）
  if(p.type==='研发' && typeof rdStageBarHtml==='function') h += rdStageBarHtml(p.id);
  var teamCount = (p.team&&Array.isArray(p.team))?p.team.length:0;
  h += '<div style="display:flex;align-items:center;gap:14px;font-size:11px;color:#A8A29A">';
  h += '<span>'+esc(p.owner||'')+'</span>';
  h += '<span>团队 '+teamCount+' 人</span>';
  h += '<span>'+(p.start_date||'')+' ~ '+(p.end_date||'')+'</span>';
  h += '</div>';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid #EFEDE8">';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:8px;'+(sm.fill?('background:'+sm.c+';color:#F7F5F0'):('border:1px solid '+sm.c+';color:'+sm.c))+'">'+esc(p.status||'')+'</span>';
  h += '<span style="font-size:10px;color:#C9C4BA">'+(p.updated_at?formatDate(p.updated_at):'')+'</span>';
  h += '</div>';
  h += '</div></div>';
  return h;
}

// ===== UI: Sidebar =====
function renderPMSidebar(){
  var el = document.getElementById('pmSidebar');
  if(!el) return;

  var all = _pmProjects||[];
  // 级别统计基于当前类型筛选后的集合（与列表口径一致）
  var typed = all.filter(function(p){return !_pmFilter.type||_pmFilter.type==='全部'||p.type===_pmFilter.type;});
  var myProjects = all.filter(function(p){return p.owner===(currentUser&&currentUser.name);}).length;
  var active = all.filter(function(p){return p.status==='实施中';}).length;
  var noQuick = !_pmFilter.owner && !_pmFilter._active;

  var h = '';
  var idx = 0;
  var animCls = _pmMotionPlayed ? '' : ' pm-nav-anim';
  h += '<div style="margin-bottom:22px">';
  h += '<div style="font-size:11px;font-weight:500;color:#A8A29A;margin-bottom:8px;letter-spacing:1px">项目类型</div>';
  PM_TYPE_DEFS.forEach(function(td){
    var sel = td.key===_pmFilter.type && noQuick;
    var cnt = td.key==='全部' ? all.length : all.filter(function(p){return p.type===td.key;}).length;
    h += '<div class="pm-nav-item'+animCls+(sel?' pm-nav-sel':'')+'" onclick="_pmFilter.type=\''+td.key+'\';_pmFilter.owner=\'\';_pmFilter._active=false;renderPMSidebar();renderPMList()" style="'+(_pmMotionPlayed?'':('animation-delay:'+(idx++*30)+'ms;'))+'display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px;font-size:12px;cursor:pointer;margin-bottom:2px;color:'+(sel?'#F7F5F0':'#3A3835')+'">'
      +'<span>'+td.label+'</span><span class="pm-nav-cnt" style="font-size:11px;color:#A8A29A;font-variant-numeric:tabular-nums">'+cnt+'</span></div>';
  });
  h += '</div>';

  h += '<div style="margin-bottom:22px">';
  h += '<div style="font-size:11px;font-weight:500;color:#A8A29A;margin-bottom:8px;letter-spacing:1px">快速筛选</div>';
  var mySel = !!_pmFilter.owner;
  h += '<div class="pm-nav-item'+animCls+(mySel?' pm-nav-sel':'')+'" onclick="filterMyProjects()" style="'+(_pmMotionPlayed?'':('animation-delay:'+(idx++*30)+'ms;'))+'display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px;font-size:12px;cursor:pointer;margin-bottom:2px;color:'+(mySel?'#F7F5F0':'#3A3835')+'"><span>我的项目</span><span class="pm-nav-cnt" style="font-size:11px;color:#A8A29A;font-variant-numeric:tabular-nums">'+myProjects+'</span></div>';
  var activeSel = !!_pmFilter._active;
  h += '<div class="pm-nav-item'+animCls+(activeSel?' pm-nav-sel':'')+'" onclick="filterActiveProjects()" style="'+(_pmMotionPlayed?'':('animation-delay:'+(idx++*30)+'ms;'))+'display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px;font-size:12px;cursor:pointer;margin-bottom:2px;color:'+(activeSel?'#F7F5F0':'#3A3835')+'"><span>进行中</span><span class="pm-nav-cnt" style="font-size:11px;color:#A8A29A;font-variant-numeric:tabular-nums">'+active+'</span></div>';
  h += '</div>';

  // ★ V0.6.4L: 项目级别升级为可点击筛选器（单选切换，再次点击取消）
  h += '<div style="margin-bottom:18px">';
  h += '<div style="font-size:11px;font-weight:500;color:#A8A29A;margin-bottom:8px;letter-spacing:1px">项目级别' + (_pmFilter.level?'（筛选中）':'') + '</div>';
  h += '<div style="display:flex;gap:6px">';
  [{v:1,l:'一级',c:'#B3382C'},{v:2,l:'二级',c:'#6E6A63'},{v:3,l:'三级',c:'#A8A29A'}].forEach(function(lv){
    var cnt = typed.filter(function(p){return String(p.level)===String(lv.v);}).length;
    var on = String(_pmFilter.level||'')===String(lv.v);
    h += '<div class="pm-lvl-chip'+(on?' pm-lvl-on':'')+'" onclick="toggleLevelFilter('+lv.v+')" style="flex:1;padding:5px 4px;border-radius:7px;border:1px solid '+(on?'#1F1F1F':'#D8D3C8')+';font-size:11px;text-align:center;color:'+(on?'#F7F5F0':lv.c)+'">'+lv.l+' '+cnt+'</div>';
  });
  h += '</div></div>';

  el.innerHTML = h;
}

function toggleLevelFilter(lv){
  _pmFilter.level = (String(_pmFilter.level||'')===String(lv)) ? null : lv;
  renderPMSidebar(); renderPMList();
}

function filterMyProjects(){
  _pmFilter.type = '全部';
  _pmFilter.search = '';
  _pmFilter.level = null;
  _pmFilter.owner = (currentUser&&currentUser.name)||'';
  _pmFilter._active = false;
  renderPMList(); renderPMSidebar();
}

// ★ V0.6.4L: 「进行中」改为切换式筛选（再次点击回到全部），渲染统一走 renderPMList
function filterActiveProjects(){
  if(_pmFilter._active){
    _pmFilter._active = false;
  }else{
    _pmFilter.type = '全部';
    _pmFilter.search = '';
    _pmFilter.level = null;
    _pmFilter.owner = '';
    _pmFilter._active = true;
  }
  renderPMList(); renderPMSidebar();
}

// ===== UI: Project Detail =====
async function openPMDetail(pid){
  _pmView = 'detail';
  var all = loadAllProjects();
  var p = all.find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return; }
  // ★ V1.0 RDPM: 研发项目详情由阶段门引擎接管（rdpm.js）
  if(p.type==='研发' && typeof openRdProjectDetail==='function'){
    var rdListEl = document.getElementById('pmListView');
    var rdDetailEl = document.getElementById('pmDetailView');
    var rdPmv = document.getElementById('pmView');
    var rdBackBtn = document.getElementById('pmBackListBtn');
    if(rdListEl) rdListEl.style.display='none';
    // ★ V0.6.4P: 必须为 flex（与通用路径一致）——flex-direction:column 生效后 pmDetailContent 才能靠 flex:1 形成固定高度的内部滚动容器，研发详情头部 sticky 才有粘附对象；block 会让高度被内容撑开、滚动甩给外层导致 sticky 失效
    if(rdDetailEl) rdDetailEl.style.display='flex';
    if(rdPmv) rdPmv.classList.add('pm-detail-mode');
    if(rdBackBtn) rdBackBtn.style.display='';
    _pmCurrent = {project:p, tasks:[]};
    await openRdProjectDetail(p);
    return;
  }
  var tasks = await syncTasksFromCloud(pid) || loadProjectTasks(pid);
  p.progress = calcProjectProgress(pid);
  _pmCurrent = {project:p, tasks:tasks};

  var pmv = document.getElementById('pmView');
  var listEl = document.getElementById('pmListView');
  var detailEl = document.getElementById('pmDetailView');
  var backBtn = document.getElementById('pmBackListBtn');
  if(listEl) listEl.style.display='none';
  if(detailEl) detailEl.style.display='flex';
  if(pmv) pmv.classList.add('pm-detail-mode');
  if(backBtn) backBtn.style.display='';

  renderPMDetail();
  renderPMTaskBoard();
}

function renderPMToolbar(p){
  var h = '';
  // ★ V0.6.4O: 「返回列表」已上移至页面 header（新建项目与返回首页之间），此处不再重复
  h += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;margin-bottom:8px;border-bottom:1px solid #E5E7EB">';
  h += '<span style="flex:1;font-size:13px;color:#374151">'+esc(p.name||'')+'</span>';
  h += '<select onchange="updatePMStatus('+p.id+',this.value)" style="padding:4px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px">';
  ['草稿中','审批中','实施中','已完成','已中止'].forEach(function(s){
    h += '<option'+(s===p.status?' selected':'')+'>'+s+'</option>';
  });
  h += '</select>';
  h += '<button onclick="deleteProject('+p.id+')" style="padding:5px 12px;border:1px solid #FCA5A5;border-radius:6px;background:#FEF2F2;color:#DC2626;font-size:12px;cursor:pointer">删除</button>';
  h += '</div>';
  return h;
}

function renderPMDetail(){
  var el = document.getElementById('pmDetailContent');
  if(!el||!_pmCurrent) return;
  var p = _pmCurrent.project;
  var tasks = _pmCurrent.tasks||[];

  var teamCount = (p.team&&Array.isArray(p.team))?p.team.length:0;
  var todo = tasks.filter(function(t){return t.status==='待开始';}).length;
  var doing = tasks.filter(function(t){return t.status==='进行中';}).length;
  var done = tasks.filter(function(t){return t.status==='已完成';}).length;

  var h = '';
  h += renderPMToolbar(p);
  h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">';
  h += '<div class="pm-stat-card"><div style="font-size:24px;font-weight:600;color:#111827">'+(p.progress||0)+'%</div><div style="font-size:11px;color:#9CA3AF">总进度</div></div>';
  h += '<div class="pm-stat-card"><div style="font-size:24px;font-weight:600;color:#3B82F6">'+todo+'</div><div style="font-size:11px;color:#9CA3AF">待开始</div></div>';
  h += '<div class="pm-stat-card"><div style="font-size:24px;font-weight:600;color:#F59E0B">'+doing+'</div><div style="font-size:11px;color:#9CA3AF">进行中</div></div>';
  h += '<div class="pm-stat-card"><div style="font-size:24px;font-weight:600;color:#10B981">'+done+'</div><div style="font-size:11px;color:#9CA3AF">已完成</div></div>';
  h += '</div>';
  h += '<div style="display:flex;gap:16px;font-size:12px;color:#6B7280;margin-bottom:16px">';
  h += '<span>负责人: '+esc(p.owner||'')+'</span>';
  h += '<span>团队: '+teamCount+' 人</span>';
  h += '<span>周期: '+(p.start_date||'?')+' ~ '+(p.end_date||'?')+'</span>';
  if(p.budget_pool) h += '<span>奖金池: '+Number(p.budget_pool).toLocaleString()+' 元</span>';
  h += '</div>';
  h += '<div style="font-weight:600;font-size:13px;margin-bottom:8px">任务看板</div>';
  h += '<div id="pmTaskBoard" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;min-height:200px"></div>';
  el.innerHTML = h;
}

function renderPMTaskBoard(){
  var el = document.getElementById('pmTaskBoard');
  if(!el||!_pmCurrent) return;
  var tasks = _pmCurrent.tasks||[];

  var cols = {
    '待开始': {title:'待开始', tasks:[], color:'#3B82F6', bg:'#EFF6FF'},
    '进行中': {title:'进行中', tasks:[], color:'#F59E0B', bg:'#FFFBEB'},
    '已完成': {title:'已完成', tasks:[], color:'#10B981', bg:'#ECFDF5'},
  };

  tasks.forEach(function(t){
    var c = cols[t.status];
    if(c) c.tasks.push(t); else cols['待开始'].tasks.push(t);
  });

  var h = '';
  Object.keys(cols).forEach(function(key){
    var col = cols[key];
    h += '<div style="background:#F9FAFB;border-radius:10px;padding:12px;min-height:150px">';
    h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid '+col.color+'">';
    h += '<span style="font-weight:600;font-size:13px;color:'+col.color+'">'+col.title+'</span>';
    h += '<span style="font-size:11px;color:#9CA3AF">'+col.tasks.length+'</span>';
    h += '</div>';
    col.tasks.forEach(function(t){
      h += '<div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:all .15s">';
      h += '<div onclick="openTaskEdit('+t.project_id+','+t.id+')" style="font-size:12px;font-weight:500;color:#374151;margin-bottom:4px">'+esc(t.title||'未命名任务')+'</div>';
      h += '<div style="display:flex;align-items:center;justify-content:space-between">';
      h += '<div style="display:flex;align-items:center;gap:8px;font-size:10px;color:#9CA3AF">';
      if(t.assignee) h += '<span>'+esc(t.assignee)+'</span>';
      if(t.due_date) h += '<span>'+t.due_date+'</span>';
      if(t.progress) h += '<span>'+t.progress+'%</span>';
      h += '</div>';
      h += '<span onclick="deleteTask('+t.project_id+','+t.id+');event.stopPropagation();" style="font-size:10px;color:#FCA5A5;cursor:pointer;padding:2px 4px">×</span>';
      h += '</div></div>';
    });
    h += '<button onclick="addTaskInline('+_pmCurrent.project.id+',\''+key+'\')" class="pm-add-task-btn">+ 添加任务</button>';
    h += '</div>';
  });
  el.innerHTML = h;
}

// ★ V0.6.4S: 在职员工姓名自动补全（通用组件，PM/RDPM 全域姓名输入框复用）
// opts.multi: true=多值（空格/逗号/顿号分隔，如评审参会人）；false/缺省=单值（如负责人）
function _pmEmpPool(){
  var pool = (typeof allEmployees!=='undefined' && allEmployees && allEmployees.length)
    ? allEmployees
    : (window.__PRELOADED_EMPLOYEES__||[]);
  var names = [], seen = {};
  pool.forEach(function(e){
    var n = e && (e.name||e['姓名']);
    if(n && !seen[n]){ seen[n]=true; names.push(n); }
  });
  return names;
}
function attachEmpNameAutocomplete(input, opts){
  opts = opts||{};
  var multi = !!opts.multi;
  if(!input || !input.parentElement) return;
  if(window.getComputedStyle(input.parentElement).position==='static'){
    input.parentElement.style.position = 'relative';
  }
  var dropdown = document.createElement('div');
  dropdown.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;margin-top:2px;z-index:5;background:#fff;border:1px solid #D0D5DD;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.14);max-height:180px;overflow-y:auto;font-size:12px';
  input.parentElement.appendChild(dropdown);

  function _parts(){ return input.value.split(/[,，、\s]+/); }
  function _token(){
    if(!multi) return {token:input.value.trim(), head:''};
    var parts = _parts();
    var last = parts[parts.length-1]||'';
    return {token:last.trim(), head:input.value.slice(0, input.value.length-last.length)};
  }
  function _hide(){ dropdown.style.display='none'; }
  function _fill(name){
    if(multi){ var t=_token(); input.value = t.head + name + ' '; }
    else{ input.value = name; }
    _hide(); input.focus();
  }
  input.addEventListener('input', function(){
    var t = _token();
    if(!t.token){ _hide(); return; }
    var entered = multi ? _parts().map(function(s){return s.trim();}).filter(function(s){return s;}) : [];
    var hits = _pmEmpPool().filter(function(n){
      return n.indexOf(t.token)>=0 && entered.indexOf(n)<0;
    }).slice(0,8);
    if(!hits.length){ _hide(); return; }
    dropdown.innerHTML = hits.map(function(n){
      return '<div data-name="'+esc(n)+'" style="padding:7px 12px;cursor:pointer;color:#1F1F1F" onmouseover="this.style.background=\'#F3F4F6\'" onmouseout="this.style.background=\'\'">'+esc(n)+'</div>';
    }).join('');
    dropdown.querySelectorAll('[data-name]').forEach(function(el){
      el.addEventListener('mousedown', function(e){ e.preventDefault(); _fill(el.getAttribute('data-name')); });
    });
    dropdown.style.display='block';
  });
  input.addEventListener('blur', function(){ setTimeout(_hide, 150); });
  input.addEventListener('keydown', function(e){ if(e.key==='Escape') _hide(); });
}

// ===== Form Modal Helper (replaces _showConfirm for forms) =====
function showFormModal(html, title, okText, cancelText, onSubmit){
  var overlay = document.createElement('div');
  overlay.id = 'pm-form-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
  var modal = '<div style="background:#fff;border-radius:12px;padding:0;width:480px;max-width:90%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.2);">';
  modal += '<div style="display:flex;align-items:center;gap:10px;padding:20px 24px;border-bottom:1px solid #E5E7EB;">';
  modal += '<span style="font-size:18px">&#9888;</span>';
  modal += '<span style="font-weight:700;font-size:16px;color:#111827;">' + esc(title||'') + '</span>';
  modal += '</div>';
  modal += '<div style="padding:20px 24px;">' + html + '</div>';
  modal += '<div style="display:flex;justify-content:flex-end;gap:10px;padding:16px 24px;border-top:1px solid #E5E7EB;">';
  // ★ V0.6.4R: cancelText===null 时不渲染取消按钮（只读弹窗单按钮场景）
  if(cancelText!==null){
    modal += '<button id="pm-form-cancel" style="padding:8px 16px;border:1px solid #D0D5DD;border-radius:6px;background:#fff;font-size:13px;cursor:pointer">' + esc(cancelText||'取消') + '</button>';
  }
  modal += '<button id="pm-form-ok" style="padding:8px 16px;border:none;border-radius:6px;background:#3B82F6;color:#fff;font-size:13px;cursor:pointer">' + esc(okText||'确定') + '</button>';
  modal += '</div></div>';
  overlay.innerHTML = modal;
  document.body.appendChild(overlay);
  var close = function(){ var el = document.getElementById('pm-form-modal'); if(el && el.parentElement) el.parentElement.removeChild(el); };
  var cancelBtn = overlay.querySelector('#pm-form-cancel');
  if(cancelBtn) cancelBtn.onclick = close;
  // ★ V0.6.4R: 回调异常兜底——任何提交错误必须可见提示，绝不让弹窗静默卡死（本次 createTask 未导出事故的根治防线）
  overlay.querySelector('#pm-form-ok').onclick = async function(){
    try{
      await onSubmit(close);
    }catch(e){
      var msg = (e&&e.message)?e.message:String(e);
      if(typeof _showAlert==='function') _showAlert('操作失败: '+msg);
      else alert('操作失败: '+msg);
      console.error('[showFormModal] submit error:', e);
    }
  };
  overlay.onclick = function(e){ if(e.target === overlay) close(); };
}

// ===== Task Management =====
async function addTaskInline(pid, status){
  var title = prompt('输入任务名称:');
  if(!title||!title.trim()) return;
  var t = await createTask(pid, {title:title.trim(), status:status||'待开始'});
  if(t){
    if(_pmCurrent&&_pmCurrent.tasks) _pmCurrent.tasks.push(t);
    renderPMTaskBoard();
  }
}

async function openTaskEdit(pid, tid){
  var tasks = loadProjectTasks(pid);
  var t = tasks.find(function(x){return x.id===tid;});
  if(!t) return;

  var statuses = ['待开始','进行中','已完成'];
  var priorities = ['高','中','普通'];

  var h = '';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">任务名称</label>';
  h += '<input id="te-title" value="'+esc(t.title||'')+'" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div>';
  h += '<div style="display:flex;gap:12px;margin-bottom:12px">';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">状态</label>';
  h += '<select id="te-status" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  statuses.forEach(function(s){ h += '<option'+(s===t.status?' selected':'')+'>'+s+'</option>'; });
  h += '</select></div>';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">优先级</label>';
  h += '<select id="te-priority" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  priorities.forEach(function(s){ h += '<option'+(s===t.priority?' selected':'')+'>'+s+'</option>'; });
  h += '</select></div></div>';
  h += '<div style="display:flex;gap:12px;margin-bottom:12px">';
  h += '<div style="flex:1;position:relative">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">负责人</label>';
  h += '<input id="te-assignee" value="'+esc(t.assignee||'')+'" autocomplete="off" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div>';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">截止日期</label>';
  h += '<input id="te-due" type="date" value="'+esc(t.due_date||'')+'" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div></div>';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">进度 ('+(t.progress||0)+'%)</label>';
  h += '<input id="te-progress" type="range" min="0" max="100" value="'+(t.progress||0)+'" style="width:100%;cursor:pointer" oninput="this.previousElementSibling.innerHTML=\'进度 (\'+this.value+\'%)\'">';
  h += '</div>';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">任务描述</label>';
  h += '<textarea id="te-desc" rows="3" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box;resize:vertical">'+esc(t.description||'')+'</textarea>';
  h += '</div>';

  showFormModal(h, '编辑任务 / Edit Task', '保存 / Save', '取消 / Cancel', async function(close){
    var title = document.getElementById('te-title').value.trim();
    if(!title){ _showAlert('任务名称不能为空'); return; }
    t.title = title;
    t.status = document.getElementById('te-status').value;
    t.priority = document.getElementById('te-priority').value;
    t.assignee = document.getElementById('te-assignee').value.trim();
    t.due_date = document.getElementById('te-due').value;
    t.progress = parseInt(document.getElementById('te-progress').value)||0;
    t.description = document.getElementById('te-desc').value.trim();
    if(t.status==='已完成') t.progress = 100;
    else if(t.progress===100) t.progress = 99;

    await saveTask(t);
    _pmCurrent.tasks = loadProjectTasks(pid);
    renderPMTaskBoard();
    var p = _pmCurrent.project;
    p.progress = calcProjectProgress(pid);
    await saveProject(p);
    showToast('任务已保存');
    close();
  });
  // ★ V0.6.4S: 任务负责人姓名联想（单值模式）
  attachEmpNameAutocomplete(document.getElementById('te-assignee'), {multi:false});
}

async function updatePMStatus(pid, status){
  var all = loadAllProjects();
  var p = all.find(function(x){return x.id===pid;});
  if(!p) return;
  p.status = status;
  await saveProject(p);
  _pmProjects = all;
  if(_pmCurrent&&_pmCurrent.project) _pmCurrent.project.status = status;
  showToast('状态已更新: '+status);
}

function backToPMList(){
  _pmView = 'list'; _pmCurrent = null;
  var listEl = document.getElementById('pmListView');
  var detailEl = document.getElementById('pmDetailView');
  var pmv = document.getElementById('pmView');
  var backBtn = document.getElementById('pmBackListBtn');
  if(listEl) listEl.style.display='block';
  if(detailEl) detailEl.style.display='none';
  if(pmv) pmv.classList.remove('pm-detail-mode');
  if(backBtn) backBtn.style.display='none';
  renderPMList();
}

// ===== New Project Form (HTML Modal) =====
async function showNewProjectForm(){
  var levels = [{v:1,t:'一级 - 公司战略级重大'},{v:2,t:'二级 - 公司级及跨部门重要'},{v:3,t:'三级 - 体系及部门内小型'}];
  var currentName = (currentUser&&currentUser.name)||'';

  var h = '';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目名称 <span style="color:#EF4444">*</span></label>';
  h += '<input id="np-name" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box" placeholder="请输入项目名称">';
  h += '</div>';
  h += '<div style="display:flex;gap:12px;margin-bottom:12px">';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目类型</label>';
  h += '<select id="np-type" onchange="var w=document.getElementById(\'np-rdstart-wrap\');if(w)w.style.display=(this.value===\'研发\'?\'block\':\'none\')" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  PM_TYPE_DEFS.forEach(function(td){ if(td.key!=='全部') h += '<option value="'+td.key+'">'+td.label+'</option>'; });
  h += '</select></div>';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目级别</label>';
  h += '<select id="np-level" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  levels.forEach(function(l){ h += '<option value="'+l.v+'">'+l.t+'</option>'; });
  h += '</select></div></div>';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目负责人</label>';
  h += '<div style="position:relative"><input id="np-owner" value="'+esc(currentName)+'" autocomplete="off" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box"></div>';
  h += '</div>';
  // ★ V1.0 RDPM: 研发项目可选起始阶段（在研项目中间切入）
  h += '<div id="np-rdstart-wrap" style="display:none;margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">起始阶段（研发项目：之前阶段将补录为已通过）</label>';
  h += '<select id="np-rdstart" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  h += '<option value="preresearch">预研（从头开始）</option>';
  h += '<option value="initiation">立项</option>';
  h += '<option value="input">设计输入</option>';
  h += '<option value="output">设计输出</option>';
  h += '<option value="verification">设计验证</option>';
  h += '<option value="validation">设计确认</option>';
  h += '<option value="transfer">设计转化</option>';
  h += '</select></div>';
  h += '<div style="display:flex;gap:12px;margin-bottom:12px">';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">开始日期</label>';
  h += '<input id="np-start" type="date" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div>';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">结束日期</label>';
  h += '<input id="np-end" type="date" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div></div>';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">奖金池 (元)</label>';
  h += '<input id="np-budget" type="number" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box" placeholder="选填">';
  h += '</div>';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目描述</label>';
  h += '<textarea id="np-desc" rows="3" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box;resize:vertical" placeholder="简要描述项目目标和范围"></textarea>';
  h += '</div>';

  showFormModal(h, '新建项目 / New Project', '创建 / Create', '取消 / Cancel', async function(close){
    var name = document.getElementById('np-name').value.trim();
    if(!name){ _showAlert('请输入项目名称'); return; }
    var type = document.getElementById('np-type').value;
    var level = parseInt(document.getElementById('np-level').value)||3;
    var owner = document.getElementById('np-owner').value.trim()||currentName;
    var start = document.getElementById('np-start').value;
    var end = document.getElementById('np-end').value;
    var budget = document.getElementById('np-budget').value;
    var desc = document.getElementById('np-desc').value.trim();

    var p = await createProject({
      name: name, type: type, level: level, owner: owner,
      start_date: start||null, end_date: end||null,
      budget_pool: budget?parseFloat(budget):null,
      description: desc
    });
    // ★ V1.0 RDPM: 研发项目实例化阶段门流程（含中间切入）
    if(p && p.type==='研发' && typeof instantiateRdProject==='function'){
      var rdStartEl = document.getElementById('np-rdstart');
      await instantiateRdProject(p.id, rdStartEl?rdStartEl.value:'preresearch');
    }
    if(p) { _pmFilter.type = '全部'; _pmProjects = loadAllProjects(); renderPMList(); renderPMSidebar(); close(); }
  });
  // ★ V0.6.4S: 项目负责人姓名联想（单值模式）
  attachEmpNameAutocomplete(document.getElementById('np-owner'), {multi:false});
}

// ===== Utility =====
function formatDate(d){
  if(!d) return '';
  var dt = new Date(d);
  if(isNaN(dt.getTime())) return d.toString().substring(0,10);
  return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
}

function esc(s){
  if(!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== CSS Injection =====
function injectPMStyles(){
  if(document.getElementById('pm-styles')) return;
  var s = document.createElement('style');
  s.id = 'pm-styles';
  s.textContent = ''
  +'.pm-header{padding:16px 20px!important;padding-top:max(16px,env(safe-area-inset-top))!important;min-height:40px!important}'
  +'.pm-header h1{font-size:18px!important}'
  +'.pm-header .header-sub{font-size:11px!important}'
  // ★ V0.6.4L 水墨屏设计体系：纸底、发丝线、墨黑/朱砂/黛绿三色、静谧动效
  +'#pmView{background:#F7F5F0}'
  +'#pmView ::selection{background:#1F1F1F;color:#F7F5F0}'
  +'@keyframes pmFadeIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:none}}'
  +'@keyframes pmCardIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'
  // ★ V0.6.4La: 入场动效只挂独立类，由渲染层控制在模块进入时播放一次（防止每次点击重放造成抖动）
  +'.pm-nav-anim{animation:pmFadeIn .22s ease-out both}'
  +'.pm-card-anim{animation:pmCardIn .24s ease-out both}'
  +'.pm-nav-item{transition:background-color .16s ease-out,color .16s ease-out}'
  +'.pm-nav-item:hover{background:#EFEDE8}'
  +'.pm-nav-sel{background:#1F1F1F!important;color:#F7F5F0!important;font-weight:600}'
  +'.pm-nav-sel .pm-nav-cnt{color:#A8A29A!important}'
  +'.pm-lvl-chip{transition:background-color .16s ease-out,color .16s ease-out,border-color .16s ease-out;cursor:pointer;user-select:none}'
  +'.pm-lvl-chip:hover{border-color:#6E6A63}'
  +'.pm-lvl-on{background:#1F1F1F!important;color:#F7F5F0!important;border-color:#1F1F1F!important}'
  +'.pm-card:hover{border-color:#A8A29A!important}'
  +'.pm-del-btn{opacity:0;transition:opacity .16s ease-out,color .16s ease-out}'
  +'.pm-card:hover .pm-del-btn{opacity:1}'
  +'.pm-del-btn:hover{color:#B3382C!important}'
  +'.pm-stat-card{background:#fff;border:1px solid #E3E0D9;border-radius:10px;padding:14px 16px;text-align:center}'
  +'.pm-btn-back:hover{background:#EFEDE8;color:#1F1F1F}'
  +'.pm-add-task-btn{width:100%;padding:8px;border:1px dashed #C9C4BA;border-radius:8px;background:transparent;font-size:11px;color:#A8A29A;cursor:pointer;margin-top:4px;transition:all .16s ease-out}'
  +'.pm-add-task-btn:hover{border-color:#1F1F1F;color:#1F1F1F;background:#fff}'
  +'.pm-detail-mode{background:#F7F5F0}'
  +'#pmDetailView{display:none}'
  +'.pm-card{background:#fff}'
  ;
  document.head.appendChild(s);
}

// ===== Main Entry =====
async function enterPMModule(){
  injectPMStyles();
  _pmProjects = loadAllProjects();
  _pmView = 'list';
  _pmCurrent = null;
  _pmFilter = {type:'全部', search:'', owner:'', _active:false, level:null};
  _pmMotionPlayed = false; // ★ V0.6.4La: 每次进入模块重置入场动效

  var listEl = document.getElementById('pmListView');
  var detailEl = document.getElementById('pmDetailView');
  var pmv = document.getElementById('pmView');
  if(listEl) listEl.style.display='block';
  if(detailEl) detailEl.style.display='none';
  if(pmv) pmv.classList.remove('pm-detail-mode');

  renderPMSidebar();
  renderPMList();

  var cloud = await syncProjectsFromCloud();
  if(cloud) { _pmProjects = cloud; saveAllProjects(cloud); renderPMSidebar(); renderPMList(); }
}

// Expose to global
window.enterPMModule = enterPMModule;
window.openPMDetail = openPMDetail;
window.backToPMList = backToPMList;
window.showNewProjectForm = showNewProjectForm;
window.deleteProject = deleteProject;
window.updatePMStatus = updatePMStatus;
window.addTaskInline = addTaskInline;
window.openTaskEdit = openTaskEdit;
window.renderPMList = renderPMList;
window.renderPMSidebar = renderPMSidebar;
window.renderPMTaskBoard = renderPMTaskBoard;
window.calcProjectProgress = calcProjectProgress;
window.saveProject = saveProject;
window.deleteTask = deleteTask;
window.filterMyProjects = filterMyProjects;
window.filterActiveProjects = filterActiveProjects;
window.toggleLevelFilter = toggleLevelFilter;
window.attachEmpNameAutocomplete = attachEmpNameAutocomplete;

console.log('[PM] Module loaded - V0.2.0 (研发项目管理 + HTML Modal)');

} // end _pmInit guard
