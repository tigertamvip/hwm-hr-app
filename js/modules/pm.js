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
var PM_TYPE_DEFS = [
  {key:'全部', label:'全部项目'},
  {key:'战略', label:'战略项目管理'},
  {key:'协同', label:'协同项目管理'},
  {key:'研发', label:'研发项目管理'},
  {key:'通用', label:'通用项目管理'}
];

// ===== State =====
var _pmCurrent = null;       // {project, tasks}
var _pmView = 'list';        // list / detail / board
var _pmFilter = {type:'全部', search:'', owner:''};
var _pmProjects = [];

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
    await supabase.from(SUPABASE_PM_TABLE).delete().eq('id',id);
    var all = loadAllProjects().filter(function(x){return x.id!==id;});
    saveAllProjects(all); _pmProjects = all;
    if(_pmCurrent&&_pmCurrent.project&&_pmCurrent.project.id===id){ _pmCurrent = null; _pmView = 'list'; }
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

  var projects = _pmProjects||[];
  if(_pmFilter.type && _pmFilter.type!=='全部'){
    projects = projects.filter(function(p){return p.type===_pmFilter.type;});
  }
  if(_pmFilter.search){
    var s = _pmFilter.search.toLowerCase();
    projects = projects.filter(function(p){return (p.name||'').toLowerCase().indexOf(s)>=0;});
  }
  if(_pmFilter.owner){
    projects = projects.filter(function(p){return p.owner===_pmFilter.owner;});
  }

  var html = '';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">';
  html += '<div style="display:flex;align-items:center;gap:10px">';
  html += '<select onchange="_pmFilter.type=this.value;renderPMList()" style="padding:5px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;background:#fff">';
  PM_TYPE_DEFS.forEach(function(t){ html += '<option value="'+t.key+'"'+(t.key===_pmFilter.type?' selected':'')+'>'+t.label+'</option>'; });
  html += '</select>';
  html += '<span style="font-size:12px;color:#9CA3AF">共 '+projects.length+' 个项目</span>';
  html += '</div>';
  html += '<input placeholder="搜索项目..." value="'+esc(_pmFilter.search)+'" oninput="_pmFilter.search=this.value;renderPMList()" style="padding:5px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;width:180px">';
  html += '</div>';

  if(!projects.length){
    html += '<div style="text-align:center;padding:60px 20px;color:#9CA3AF">暂无项目，点击右上角"+ 新建项目"开始</div>';
  }else{
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
    projects.forEach(function(p){ html += renderProjectCard(p); });
    html += '</div>';
  }

  el.innerHTML = html;
}

function renderProjectCard(p){
  var lvlColors = {'1':'#EF4444','2':'#F59E0B','3':'#10B981'};
  var lvlBg = {'1':'#FEF2F2','2':'#FFFBEB','3':'#ECFDF5'};
  var lvlText = {'1':'#DC2626','2':'#D97706','3':'#059669'};
  var lvlLabels = {'1':'一级','2':'二级','3':'三级'};
  var typeColors = {'研发':'#3B82F6','通用':'#6B7280','战略':'#8B5CF6','协同':'#14B8A6'};
  var typeBg = {'研发':'#EFF6FF','通用':'#F3F4F6','战略':'#F5F3FF','协同':'#F0FDFA'};
  var statusBg = {'草稿中':'#F3F4F6','审批中':'#FFFBEB','实施中':'#EFF6FF','已完成':'#ECFDF5','已逾期':'#FEF2F2','待复审':'#FFF7ED','已中止':'#F3F4F6'};
  var statusColor = {'草稿中':'#9CA3AF','审批中':'#D97706','实施中':'#3B82F6','已完成':'#059669','已逾期':'#DC2626','待复审':'#EA580C','已中止':'#6B7280'};

  var lc = lvlColors[p.level]||'#10B981';
  var lb = lvlBg[p.level]||'#ECFDF5';
  var lt = lvlText[p.level]||'#059669';
  var sc = statusColor[p.status]||'#9CA3AF';
  var sb = statusBg[p.status]||'#F3F4F6';
  var tc = typeColors[p.type]||'#6B7280';
  var tbg = typeBg[p.type]||'#F3F4F6';

  var h = '';
  h += '<div onclick="openPMDetail('+p.id+')" class="pm-card" style="display:flex;background:#fff;border-radius:12px;border:1px solid #E5E7EB;overflow:hidden;cursor:pointer;transition:all .2s">';
  h += '<div style="width:4px;min-width:4px;background:'+lc+'"></div>';
  h += '<div style="flex:1;padding:14px 16px">';
  h += '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">';
  h += '<div style="font-weight:600;font-size:15px;color:#111827;line-height:1.3">'+esc(p.name||'未命名')+'</div>';
  h += '<div style="display:flex;gap:4px;flex-shrink:0">';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:'+lb+';color:'+lt+'">'+lvlLabels[p.level]+'</span>';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:'+tbg+';color:'+tc+'">'+esc(p.type||'')+'</span>';
  h += '</div></div>';
  h += '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:11px;color:#6B7280;margin-bottom:3px"><span>进度</span><span style="font-weight:600">'+(p.progress||0)+'%</span></div>';
  h += '<div style="height:5px;background:#F3F4F6;border-radius:3px;overflow:hidden"><div style="height:100%;width:'+(p.progress||0)+'%;background:'+lc+';border-radius:3px"></div></div></div>';
  var teamCount = (p.team&&Array.isArray(p.team))?p.team.length:0;
  h += '<div style="display:flex;align-items:center;gap:16px;font-size:11px;color:#9CA3AF">';
  h += '<span>'+esc(p.owner||'')+'</span>';
  h += '<span>团队 '+teamCount+' 人</span>';
  h += '<span>'+(p.start_date||'')+'-'+(p.end_date||'')+'</span>';
  h += '</div>';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid #F3F4F6">';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:8px;background:'+sb+';color:'+sc+'">'+esc(p.status||'')+'</span>';
  h += '<span style="font-size:10px;color:#D1D5DB">'+(p.updated_at?formatDate(p.updated_at):'')+'</span>';
  h += '</div>';
  h += '</div></div>';
  return h;
}

// ===== UI: Sidebar =====
function renderPMSidebar(){
  var el = document.getElementById('pmSidebar');
  if(!el) return;

  var projects = _pmProjects||[];
  var myProjects = projects.filter(function(p){return p.owner===(currentUser&&currentUser.name);}).length;
  var active = projects.filter(function(p){return p.status==='实施中';}).length;

  var h = '';
  h += '<div style="margin-bottom:18px">';
  h += '<div style="font-size:11px;font-weight:600;color:#9CA3AF;margin-bottom:8px;letter-spacing:.5px">项目类型</div>';
  PM_TYPE_DEFS.forEach(function(td){
    var sel = td.key===_pmFilter.type && !_pmFilter.owner && !_pmFilter._active;
    h += '<div onclick="_pmFilter.type=\''+td.key+'\';_pmFilter.owner=\'\';_pmFilter._active=false;renderPMSidebar();renderPMList()" style="padding:6px 10px;border-radius:6px;font-size:12px;cursor:pointer;margin-bottom:3px;'+(sel?'background:#EFF6FF;color:#3B82F6;font-weight:600':'color:#6B7280')+'">'+td.label+'</div>';
  });
  h += '</div>';

  h += '<div style="margin-bottom:18px">';
  h += '<div style="font-size:11px;font-weight:600;color:#9CA3AF;margin-bottom:8px;letter-spacing:.5px">快速筛选</div>';
  var mySel = !!_pmFilter.owner;
  h += '<div onclick="filterMyProjects()" style="padding:6px 10px;border-radius:6px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;'+(mySel?'background:#EFF6FF;color:#3B82F6;font-weight:600':'color:#6B7280')+'"><span>我的项目</span><span>'+myProjects+'</span></div>';
  var activeSel = !!_pmFilter._active;
  h += '<div onclick="filterActiveProjects()" style="padding:6px 10px;border-radius:6px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;'+(activeSel?'background:#EFF6FF;color:#3B82F6;font-weight:600':'color:#6B7280')+'"><span>进行中</span><span>'+active+'</span></div>';
  h += '</div>';

  h += '<div style="margin-bottom:18px">';
  h += '<div style="font-size:11px;font-weight:600;color:#9CA3AF;margin-bottom:8px;letter-spacing:.5px">项目级别</div>';
  h += '<div style="display:flex;gap:6px">';
  [{l:'一级',c:'#EF4444',b:'#FEF2F2'},{l:'二级',c:'#F59E0B',b:'#FFFBEB'},{l:'三级',c:'#10B981',b:'#ECFDF5'}].forEach(function(lv){
    var cnt = projects.filter(function(p){return String(p.level)===lv.l.charAt(0);}).length;
    h += '<div style="flex:1;padding:4px 8px;border-radius:6px;border:1px solid '+lv.c+';font-size:10px;text-align:center;background:'+lv.b+';color:'+lv.c+'">'+lv.l+' '+cnt+'</div>';
  });
  h += '</div></div>';

  el.innerHTML = h;
}

function filterMyProjects(){
  _pmFilter.type = '全部';
  _pmFilter.search = '';
  _pmFilter.owner = (currentUser&&currentUser.name)||'';
  _pmFilter._active = false;
  renderPMList(); renderPMSidebar();
}

function filterActiveProjects(){
  _pmFilter.type = '全部';
  _pmFilter.search = '';
  _pmFilter.owner = '';
  _pmFilter._active = true;
  // 暂存到全局，通过自定义渲染实现
  var el = document.getElementById('pmContent');
  if(!el) return;
  var projects = _pmProjects.filter(function(p){return p.status==='实施中';});
  var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">';
  html += '<div style="display:flex;align-items:center;gap:10px">';
  html += '<button onclick="_pmFilter._active=false;renderPMList()" style="padding:5px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;background:#fff;cursor:pointer">← 返回全部</button>';
  html += '<span style="font-size:12px;color:#9CA3AF">进行中项目: '+projects.length+'</span>';
  html += '</div></div>';
  if(!projects.length){
    html += '<div style="text-align:center;padding:60px 20px;color:#9CA3AF">暂无进行中项目</div>';
  }else{
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
    projects.forEach(function(p){ html += renderProjectCard(p); });
    html += '</div>';
  }
  el.innerHTML = html;
}

// ===== UI: Project Detail =====
async function openPMDetail(pid){
  _pmView = 'detail';
  var all = loadAllProjects();
  var p = all.find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return; }
  var tasks = await syncTasksFromCloud(pid) || loadProjectTasks(pid);
  p.progress = calcProjectProgress(pid);
  _pmCurrent = {project:p, tasks:tasks};

  var pmv = document.getElementById('pmView');
  var listEl = document.getElementById('pmListView');
  var detailEl = document.getElementById('pmDetailView');
  if(listEl) listEl.style.display='none';
  if(detailEl) detailEl.style.display='flex';
  if(pmv) pmv.classList.add('pm-detail-mode');

  renderPMDetail();
  renderPMTaskBoard();
}

function renderPMToolbar(p){
  var h = '';
  h += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;margin-bottom:8px;border-bottom:1px solid #E5E7EB">';
  h += '<button onclick="backToPMList()" class="pm-btn-back" style="padding:5px 14px;border:1px solid #D0D5DD;border-radius:6px;background:#fff;font-size:12px;cursor:pointer;color:#6B7280">返回列表</button>';
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
  modal += '<button id="pm-form-cancel" style="padding:8px 16px;border:1px solid #D0D5DD;border-radius:6px;background:#fff;font-size:13px;cursor:pointer">' + esc(cancelText||'取消') + '</button>';
  modal += '<button id="pm-form-ok" style="padding:8px 16px;border:none;border-radius:6px;background:#3B82F6;color:#fff;font-size:13px;cursor:pointer">' + esc(okText||'确定') + '</button>';
  modal += '</div></div>';
  overlay.innerHTML = modal;
  document.body.appendChild(overlay);
  var close = function(){ var el = document.getElementById('pm-form-modal'); if(el && el.parentElement) el.parentElement.removeChild(el); };
  overlay.querySelector('#pm-form-cancel').onclick = close;
  overlay.querySelector('#pm-form-ok').onclick = function(){ onSubmit(close); };
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
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">负责人</label>';
  h += '<input id="te-assignee" value="'+esc(t.assignee||'')+'" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
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
  if(listEl) listEl.style.display='block';
  if(detailEl) detailEl.style.display='none';
  if(pmv) pmv.classList.remove('pm-detail-mode');
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
  h += '<select id="np-type" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  PM_TYPE_DEFS.forEach(function(td){ if(td.key!=='全部') h += '<option value="'+td.key+'">'+td.label+'</option>'; });
  h += '</select></div>';
  h += '<div style="flex:1">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目级别</label>';
  h += '<select id="np-level" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px">';
  levels.forEach(function(l){ h += '<option value="'+l.v+'">'+l.t+'</option>'; });
  h += '</select></div></div>';
  h += '<div style="margin-bottom:12px">';
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目负责人</label>';
  h += '<input id="np-owner" value="'+esc(currentName)+'" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div>';
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
    if(p) { _pmFilter.type = '全部'; _pmProjects = loadAllProjects(); renderPMList(); renderPMSidebar(); close(); }
  });
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
  +'.pm-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);transform:translateY(-2px)}'
  +'.pm-stat-card{background:#F9FAFB;border-radius:10px;padding:14px 16px;text-align:center}'
  +'.pm-btn-back:hover{background:#F3F4F6;color:#374151}'
  +'.pm-add-task-btn{width:100%;padding:8px;border:1px dashed #D1D5DB;border-radius:8px;background:transparent;font-size:11px;color:#9CA3AF;cursor:pointer;margin-top:4px}'
  +'.pm-add-task-btn:hover{border-color:#3B82F6;color:#3B82F6;background:#EFF6FF}'
  +'.pm-detail-mode{background:#F9FAFB}'
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
  _pmFilter = {type:'全部', search:'', owner:'', _active:false};

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

console.log('[PM] Module loaded - V0.2.0 (研发项目管理 + HTML Modal)');

} // end _pmInit guard
