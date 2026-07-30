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
    var local = loadAllProjects();
    var cloudIds = {};
    cloud.forEach(function(p){ cloudIds[p.id]=p; });
    // ★ V0.6.5u: 合并而非覆盖——本地更新的项目优先保留并回推云端
    var merged = [];
    var needPush = []; // 本地有但云端缺失或较新的项目，需回推
    local.forEach(function(p){
      var c = cloudIds[p.id];
      if(!c){
        // 本地有云端无 → 回推
        needPush.push(p);
        merged.push(p);
      }else{
        // 两边都有，比 updated_at
        var lt = new Date(p.updated_at||0).getTime();
        var ct = new Date(c.updated_at||0).getTime();
        if(lt > ct){
          needPush.push(p);
          merged.push(p);
        }else{
          merged.push(c);
        }
        delete cloudIds[p.id];
      }
    });
    // 云端独有（本地无）
    Object.keys(cloudIds).forEach(function(k){ merged.push(cloudIds[k]); });
    saveAllProjects(merged);
    // 异步回推本地领先的数据到云端
    if(needPush.length){
      (async function(){
        for(var i=0; i<needPush.length; i++){
          try{ await supabase.from(SUPABASE_PM_TABLE).upsert(needPush[i],{onConflict:'id'}); }
          catch(e){ console.warn('[PM] Push-back failed:',e.message); }
        }
      })();
    }
    return merged;
  }catch(e){ console.warn('[PM] Cloud sync exception:',e.message); }
}

async function saveProject(p){
  p.updated_at = new Date().toISOString();
  var all = loadAllProjects();
  var idx = all.findIndex(function(x){return x.id===p.id;});
  if(idx>=0) all[idx]=p; else all.push(p);
  saveAllProjects(all);
  // ★ V0.6.5q: 同步更新内存中的项目列表，确保卡片进度立即刷新
  _pmProjects = all;
  if(_pmView==='list') renderPMList();
  // ★ V0.6.5u: Supabase 保存加重试（最多3次），确保云端同步成功
  var cloudOk = false;
  for(var attempt=0; attempt<3 && !cloudOk; attempt++){
    try{
      var r = await supabase.from(SUPABASE_PM_TABLE).upsert(p,{onConflict:'id'});
      if(r.error){ console.warn('[PM] Cloud save error (attempt '+(attempt+1)+'/3):',r.error.message); }
      else { cloudOk = true; }
    }catch(e){ console.warn('[PM] Cloud save exception (attempt '+(attempt+1)+'/3):',e.message); }
    if(!cloudOk && attempt<2) await new Promise(function(rs){setTimeout(rs,500);});
  }
  if(!cloudOk) console.warn('[PM] Cloud save FAILED after 3 attempts, localStorage only');
  return cloudOk;
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
  // ★ V0.6.5s: 删除权限检查——仅项目负责人/管理员可删除
  var p = loadAllProjects().find(function(x){return x.id===id;});
  if(!p){ _showAlert('项目不存在'); return; }
  var me = (currentUser&&currentUser.name)||'';
  var canDelete = (me===p.owner) || (typeof hasPermission==='function'&&hasPermission('maintenance'));
  if(!canDelete){
    _showAlert('您没有权限删除此项目。<br><br>只有项目负责人「'+esc(p.owner||'')+'」或系统管理员可以删除项目。','权限提示',3000);
    return;
  }
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
// ★ V0.6.5k: 返回 -1 表示"无任务"（显示"未开始"而非0%）
function calcProjectProgress(pid){
  var tasks = loadProjectTasks(pid);
  if(!tasks.length) return -1;
  var total = 0;
  tasks.forEach(function(t){ total += (t.progress||0); });
  return Math.round(total / tasks.length);
}
function pmProgressLabel(prog){
  return prog===-1?'未开始':prog+'%';
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
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(336px,1fr));gap:14px">';
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
  // ★ V0.6.5s: 删除按钮仅项目负责人/管理员可见
  var _canDelete = (currentUser&&currentUser.name)===p.owner || (typeof hasPermission==='function'&&hasPermission('maintenance'));
  if(_canDelete) h += '<button class="pm-del-btn" onclick="event.stopPropagation();deleteProject('+p.id+')" title="删除项目" style="padding:2px 8px;border:0;background:transparent;font-size:11px;color:#A8A29A;cursor:pointer">删除</button>';
  h += '</div></div>';
  h += '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:11px;color:#6E6A63;margin-bottom:4px"><span>进度</span><span style="font-weight:600;color:'+(p.progress===-1?'#A8A29A':'#1F1F1F')+'">'+pmProgressLabel(p.progress)+'</span></div>';
  h += '<div style="height:4px;background:#EFEDE8;border-radius:2px;overflow:hidden"><div style="height:100%;width:'+(p.progress===-1?0:(p.progress||0))+'%;background:'+(p.progress===-1?'#EFEDE8':'#1F1F1F')+';border-radius:2px"></div></div></div>';
  // ★ V1.0 RDPM: 研发项目卡片显示 7 段阶段条（数据来自 rdpm.js 缓存，不影响其他类型）
  if(p.type==='研发' && typeof rdStageBarHtml==='function') h += rdStageBarHtml(p.id);
  var teamCount = (p.team&&Array.isArray(p.team))?p.team.length:0;
  h += '<div style="display:flex;align-items:center;gap:14px;font-size:12px;color:#6B7280">';
  h += '<span>'+esc(p.owner||'')+'</span>';
  h += '<span>团队 '+teamCount+' 人</span>';
  h += '<span>'+(p.start_date||'')+' ~ '+(p.end_date||'')+'</span>';
  h += '</div>';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid #EFEDE8">';
  h += '<div style="display:flex;gap:8px">';
  h += '<button onclick="event.stopPropagation();showProjectTeam('+p.id+')" style="font-size:11px;padding:6px 14px;border-radius:10px;border:none;background:#1F1F1F;color:#F7F5F0;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-weight:500" title="查看项目组成员"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>项目团队 ('+teamCount+')</button>';
  h += '<button onclick="event.stopPropagation();openProjectGanttTab('+p.id+')" style="font-size:11px;padding:6px 14px;border-radius:10px;border:1px solid #C9C4BA;background:#fff;color:#6E6A63;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-weight:500" title="查看项目甘特图"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>项目甘特图</button>';
  h += '</div>';
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
  // ★ V0.6.5m: 成员名单+密码门禁 — 成员需验证密码方可进入
  var _accessOk = await verifyProjectAccess(pid);
  if(!_accessOk) return;
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
  // ★ V0.6.5s: 删除按钮仅项目负责人/管理员可见
  var _canDeleteToolbar = (currentUser&&currentUser.name)===p.owner || (typeof hasPermission==='function'&&hasPermission('maintenance'));
  if(_canDeleteToolbar) h += '<button onclick="deleteProject('+p.id+')" style="padding:5px 12px;border:1px solid #FCA5A5;border-radius:6px;background:#FEF2F2;color:#DC2626;font-size:12px;cursor:pointer">删除</button>';
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
  h += '<div class="pm-stat-card"><div style="font-size:24px;font-weight:600;color:'+(p.progress===-1?'#A8A29A':'#111827')+'">'+pmProgressLabel(p.progress)+'</div><div style="font-size:11px;color:#9CA3AF">总进度</div></div>';
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
  // ★ V0.6.5y: Tab 切换 — 任务看板 | 甘特图
  h += '<div style="display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid #E5E7EB">';
  var tabs = [{key:'board',label:'任务看板'},{key:'gantt',label:'甘特图'}];
  tabs.forEach(function(t){
    var sel = (_pmDetailTab||'board')===t.key;
    h += '<div onclick="_pmDetailTab=\''+t.key+'\';renderPMDetail();" style="padding:8px 16px;font-size:12px;cursor:pointer;border-bottom:2px solid '+(sel?'#3B82F6':'transparent')+';color:'+(sel?'#3B82F6':'#6B7280')+';font-weight:'+(sel?'600':'400')+';margin-bottom:-1px">'+t.label+'</div>';
  });
  h += '</div>';
  // 甘特图视图
  if((_pmDetailTab||'board')==='gantt'){
    h += renderPMGantt(p, tasks);
  }else{
    h += '<div id="pmTaskBoard" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;min-height:200px"></div>';
  }
  el.innerHTML = h;
  if((_pmDetailTab||'board')!=='gantt') renderPMTaskBoard();
}

// ===== 甘特图渲染 =====
var _pmDetailTab = 'board';
var _pmGanttGranularity = null; // null=auto, 'day', 'week', 'month'

function _pmGanttAutoGranularity(p){
  var startD = p.start_date?new Date(p.start_date):new Date();
  var endD = p.end_date?new Date(p.end_date):new Date(startD.getTime()+30*24*3600*1000);
  var days = Math.ceil((endD-startD)/(24*3600*1000));
  if(days<=30) return 'day';
  if(days<=180) return 'week';
  return 'month';
}

function _pmGanttGranularityLabel(g){
  return {day:'按日',week:'按周',month:'按月'}[g]||g;
}

function renderPMGantt(p, tasks){
  var gran = _pmGanttGranularity || _pmGanttAutoGranularity(p);
  var startD = p.start_date?new Date(p.start_date):new Date();
  var endD = p.end_date?new Date(p.end_date):new Date(startD.getTime()+30*24*3600*1000);
  var today = new Date();
  today.setHours(0,0,0,0);

  var h = '';
  // 颗粒度切换
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
  h += '<span style="font-size:12px;color:#6B7280">时间颗粒度：</span>';
  ['day','week','month'].forEach(function(g){
    var sel = gran===g;
    h += '<button onclick="_pmGanttGranularity=\''+g+'\';renderPMDetail();" style="padding:4px 12px;font-size:11px;border:1px solid '+(sel?'#3B82F6':'#D0D5DD')+';border-radius:6px;background:'+(sel?'#3B82F6':'#fff')+';color:'+(sel?'#fff':'#6B7280')+';cursor:pointer">'+_pmGanttGranularityLabel(g)+'</button>';
  });
  h += '</div>';

  // 时间轴计算
  var totalMs = endD - startD;
  var colW, cols = [];
  if(gran==='day'){
    colW = 40;
    for(var d=new Date(startD); d<=endD; d.setDate(d.getDate()+1)){
      cols.push({label:(d.getMonth()+1)+'/'+d.getDate(), ms:24*3600*1000, start:new Date(d)});
    }
  }else if(gran==='week'){
    colW = 80;
    var wd = new Date(startD);
    wd.setDate(wd.getDate()-wd.getDay()); // 从周一开始
    while(wd<=endD){
      var we = new Date(wd); we.setDate(we.getDate()+6);
      cols.push({label:(wd.getMonth()+1)+'/'+wd.getDate()+'~'+(we.getMonth()+1)+'/'+we.getDate(), ms:7*24*3600*1000, start:new Date(wd)});
      wd.setDate(wd.getDate()+7);
    }
  }else{ // month
    colW = 100;
    var md = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while(md<=endD){
      var me = new Date(md.getFullYear(), md.getMonth()+1, 0);
      cols.push({label:md.getFullYear()+'-'+String(md.getMonth()+1).padStart(2,'0'), ms:me-md, start:new Date(md)});
      md.setMonth(md.getMonth()+1);
    }
  }

  var chartW = cols.length * colW;

  h += '<div style="overflow-x:auto;background:#fff;border:1px solid #E5E7EB;border-radius:10px">';
  h += '<div style="min-width:'+(chartW+200)+'px">';

  // 表头
  h += '<div style="display:flex;border-bottom:1px solid #E5E7EB;background:#F9FAFB">';
  h += '<div style="width:180px;flex-shrink:0;padding:8px 10px;font-size:11px;font-weight:600;color:#374151;border-right:1px solid #E5E7EB">任务 / 负责人</div>';
  h += '<div style="width:70px;flex-shrink:0;padding:8px 6px;font-size:10px;color:#6B7280;border-right:1px solid #E5E7EB">开始</div>';
  h += '<div style="width:70px;flex-shrink:0;padding:8px 6px;font-size:10px;color:#6B7280;border-right:1px solid #E5E7EB">结束</div>';
  cols.forEach(function(c){
    h += '<div style="width:'+colW+'px;flex-shrink:0;padding:8px 2px;font-size:10px;color:#6B7280;text-align:center;border-right:1px solid #F3F4F6">'+c.label+'</div>';
  });
  h += '</div>';

  // 任务行
  if(!tasks.length){
    h += '<div style="padding:32px;text-align:center;color:#9CA3AF;font-size:12px">暂无任务数据</div>';
  }else{
    tasks.forEach(function(t, ti){
      var sd = t.start_date?new Date(t.start_date):startD;
      var dd = t.due_date?new Date(t.due_date):sd;
      var prog = t.progress||0;
      var statusColor = t.status==='已完成'?'#059669':(t.status==='进行中'?'#3B82F6':'#9CA3AF');
      var bgColor = t.status==='已完成'?'#ECFDF5':(t.status==='进行中'?'#EFF6FF':'#F9FAFB');

      h += '<div style="display:flex;border-bottom:1px solid #F3F4F6;'+(ti%2===0?'background:#fff':'background:#FAFAFA')+'">';
      h += '<div style="width:180px;flex-shrink:0;padding:8px 10px;font-size:11px;color:#374151;border-right:1px solid #E5E7EB;display:flex;align-items:center;gap:4px">';
      h += '<span style="width:6px;height:6px;border-radius:50%;background:'+statusColor+';flex-shrink:0"></span>';
      h += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(t.title||'')+'">'+esc(t.title||'未命名')+'</span>';
      h += '</div>';
      h += '<div style="width:70px;flex-shrink:0;padding:8px 6px;font-size:10px;color:#9CA3AF;border-right:1px solid #E5E7EB">'+(t.start_date||'')+'</div>';
      h += '<div style="width:70px;flex-shrink:0;padding:8px 6px;font-size:10px;color:#9CA3AF;border-right:1px solid #E5E7EB">'+(t.due_date||'')+'</div>';

      // 时间轴区域
      h += '<div style="flex:1;position:relative;height:36px;background:'+bgColor+'">';
      var taskOffset = Math.max(0, (sd - startD) / totalMs * chartW);
      var taskW = Math.max(4, (dd - sd) / totalMs * chartW);
      var progW = Math.floor(taskW * prog / 100);

      // 任务条
      h += '<div style="position:absolute;left:'+taskOffset+'px;top:8px;width:'+taskW+'px;height:20px;background:'+statusColor+';border-radius:4px;opacity:'+(prog===0?'0.25':'0.85')+'" title="'+esc(t.title||'')+' '+prog+'%"></div>';
      // 进度填充
      if(prog>0){
        h += '<div style="position:absolute;left:'+taskOffset+'px;top:8px;width:'+progW+'px;height:20px;background:'+statusColor+';border-radius:4px;opacity:1"></div>';
      }
      // 进度文字
      if(prog>0){
        h += '<div style="position:absolute;left:'+(taskOffset+taskW/2-12)+'px;top:12px;font-size:9px;color:#fff;font-weight:600;text-shadow:0 0 2px rgba(0,0,0,.3)">'+prog+'%</div>';
      }
      h += '</div>';
      h += '</div>';
    });
  }

  // 今日线
  var todayOffset = (today - startD) / totalMs * chartW;
  if(todayOffset>=0 && todayOffset<=chartW){
    h += '<div style="position:absolute;left:'+(180+70+70+todayOffset)+'px;top:0;width:1px;height:100%;background:#EF4444;z-index:2;pointer-events:none"></div>';
    h += '<div style="position:absolute;left:'+(180+70+70+todayOffset-12)+'px;top:2px;font-size:9px;color:#EF4444;z-index:2;pointer-events:none">今天</div>';
  }

  h += '</div></div>';
  h += '<div style="margin-top:8px;font-size:10px;color:#9CA3AF;display:flex;gap:12px">';
  h += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#059669;margin-right:3px"></span>已完成</span>';
  h += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3B82F6;margin-right:3px"></span>进行中</span>';
  h += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#9CA3AF;margin-right:3px"></span>待开始</span>';
  h += '<span style="color:#EF4444">| 红色竖线 = 今天</span>';
  h += '</div>';
  return h;
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
// ★ V0.6.5o: 每次创建前先移除旧遮罩，防止多次调用时遮罩叠加变暗
function showFormModal(html, title, okText, cancelText, onSubmit){
  var oldOverlay = document.getElementById('pm-form-modal');
  if(oldOverlay && oldOverlay.parentElement) oldOverlay.parentElement.removeChild(oldOverlay);
  var overlay = document.createElement('div');
  overlay.id = 'pm-form-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
  var modal = '<div style="background:#fff;border-radius:12px;padding:0;width:576px;max-width:92%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.2);">';
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
  h += '<label style="display:block;font-size:12px;color:#6B7280;margin-bottom:4px">项目组成员（可多选，按空格/逗号分隔添加）</label>';
  h += '<div style="position:relative"><input id="np-members" autocomplete="off" placeholder="输入姓名后选择，按空格添加下一个" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box"></div>';
  h += '<div id="np-members-chips" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px"></div>';
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
    // ★ V0.6.5k: 收集已选项目组成员
    var memberNames = _npCollectMembers();
    var today = new Date().toISOString().split('T')[0];
    var team = memberNames.map(function(n){ return {name:n, role:'成员', joinedAt:today}; });
    // 负责人自动加入团队
    if(owner && !team.some(function(t){return t.name===owner;})){
      team.unshift({name:owner, role:'项目负责人', joinedAt:today});
    }

    var p = await createProject({
      name: name, type: type, level: level, owner: owner,
      start_date: start||null, end_date: end||null,
      budget_pool: budget?parseFloat(budget):null,
      description: desc,
      team: team
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
  // ★ V0.6.5k: 项目组成员多选联想
  _npInitMemberSelect(document.getElementById('np-members'), document.getElementById('np-members-chips'));
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

  // ★ V0.6.5o: 返回列表前刷新 _pmProjects（详情页 saveProject 可能已更新 localStorage 中的 progress）
  _pmProjects = loadAllProjects();
  renderPMSidebar();
  renderPMList();

  var cloud = await syncProjectsFromCloud();
  if(cloud) { _pmProjects = cloud; saveAllProjects(cloud); renderPMSidebar(); renderPMList(); }
}

// ===== Project Team Management =====
// ★ V0.6.5k: 团队数据结构升级为 [{name, role, joinedAt}]，兼容旧版字符串数组
var _npSelectedMembers = [];

function _npInitMemberSelect(input, chipsEl){
  if(!input||!chipsEl) return;
  _npSelectedMembers = [];
  var names = _pmEmpPool();

  function _renderChips(){
    var h = '';
    _npSelectedMembers.forEach(function(n, i){
      h += '<span style="display:inline-flex;align-items:center;background:#E8F0FE;color:#1B6EC4;font-size:11px;font-weight:500;padding:3px 10px;border-radius:12px;gap:4px">'+esc(n)+'<span onclick="_npRemoveMember('+i+')" style="cursor:pointer;opacity:.6;font-size:14px;line-height:1;margin-left:2px">&times;</span></span>';
    });
    chipsEl.innerHTML = h;
  }
  window._npRemoveMember = function(i){
    _npSelectedMembers.splice(i,1);
    _renderChips();
  };
  function _add(name){
    name = name.trim();
    if(!name) return;
    // ★ V0.6.5s: 只允许添加员工表中存在的姓名，防止部分输入被误存
    if(names.indexOf(name)<0) return;
    if(_npSelectedMembers.indexOf(name)>=0) return;
    _npSelectedMembers.push(name);
    _renderChips();
    input.value = '';
  }
  input.addEventListener('keydown', function(e){
    if(e.key==='Enter'||e.key===' '||e.key===','){
      e.preventDefault();
      _add(input.value);
    }else if(e.key==='Backspace'&&!input.value&&_npSelectedMembers.length){
      _npRemoveMember(_npSelectedMembers.length-1);
    }
  });
  input.addEventListener('input', function(){
    var q = input.value.trim();
    if(!q) return;
    // 如果输入包含空格或逗号，尝试拆分添加
    var parts = input.value.split(/[\s,，]+/).filter(function(s){return s.trim();});
    if(parts.length>1){
      parts.forEach(function(s){ _add(s); });
      input.value = '';
      return;
    }
    // ★ V0.6.5s: 联想匹配改为前缀匹配（防误匹配），且只显示未添加的完整姓名
    if(q.length<1) return;
    var hits = names.filter(function(n){ return n.indexOf(q)===0 && _npSelectedMembers.indexOf(n)<0; }).slice(0,6);
    if(!hits.length) return;
    // 使用 attachEmpNameAutocomplete 已有逻辑时，这里用简单下拉
    var dd = document.createElement('div');
    dd.style.cssText = 'position:absolute;top:100%;left:0;right:0;margin-top:2px;z-index:5;background:#fff;border:1px solid #D0D5DD;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.14);max-height:180px;overflow-y:auto;font-size:12px';
    dd.id = 'np-members-dd';
    dd.innerHTML = hits.map(function(n){
      return '<div style="padding:7px 12px;cursor:pointer;color:#1F1F1F" onmouseover="this.style.background=\'#F3F4F6\'" onmouseout="this.style.background=\'\'" onmousedown="event.preventDefault();_npAddMemberFromDD(\''+esc(n)+'\')">'+esc(n)+'</div>';
    }).join('');
    var parent = input.parentElement;
    var old = document.getElementById('np-members-dd');
    if(old) old.remove();
    parent.appendChild(dd);
  });
  window._npAddMemberFromDD = function(name){
    _add(name);
    var dd = document.getElementById('np-members-dd');
    if(dd) dd.remove();
  };
  input.addEventListener('blur', function(){
    setTimeout(function(){
      var dd = document.getElementById('np-members-dd');
      if(dd) dd.remove();
      if(input.value.trim()) _add(input.value);
    }, 200);
  });
}
function _npCollectMembers(){
  // ★ V0.6.5n: 从 chips DOM 读取成员，防止全局变量状态丢失/重置
  var chipsEl = document.getElementById('np-members-chips');
  if(!chipsEl) return _npSelectedMembers.slice();
  var chips = chipsEl.querySelectorAll('span');
  var names = [];
  chips.forEach(function(chip){
    var name = chip.textContent.replace(/×/g,'').trim();
    if(name && names.indexOf(name)<0) names.push(name);
  });
  return names;
}

// ★ V0.6.5m: 团队数据结构升级为 [{name, dept, password, accessStages, joinedAt}]
function _normalizeTeam(team){
  if(!Array.isArray(team)) return [];
  var out = [];
  team.forEach(function(t){
    if(!t) return;
    if(typeof t==='string'){
      out.push({name:t, dept:'', password:'', accessStages:[], joinedAt:''});
    }else if(t.name){
      out.push({
        name: t.name,
        dept: t.dept||'',
        password: t.password||'',
        accessStages: t.accessStages||[],
        joinedAt: t.joinedAt||''
      });
    }
  });
  return out;
}
function _teamNames(team){
  return _normalizeTeam(team).map(function(t){return t.name;});
}

// 从员工表获取部门信息
function _getMemberDept(name){
  var pool = (typeof allEmployees!=='undefined' && allEmployees && allEmployees.length)
    ? allEmployees
    : (window.__PRELOADED_EMPLOYEES__||[]);
  for(var i=0;i<pool.length;i++){
    var e = pool[i];
    if(e && (e.name===name || e['姓名']===name)){
      return e.dept||e['部门']||'';
    }
  }
  return '';
}

// 7 个研发阶段定义（与 rd-template.js 一致）
var _RD_STAGE_KEYS = [
  {key:'preresearch', name:'预研'},
  {key:'initiation', name:'立项'},
  {key:'input', name:'设计输入'},
  {key:'output', name:'设计输出'},
  {key:'verification', name:'设计验证'},
  {key:'validation', name:'设计确认'},
  {key:'transfer', name:'设计转化'}
];

// 生成 4 位随机密码
function _genPwd(){
  return Math.floor(1000+Math.random()*9000).toString();
}

// 查看项目团队设置（表格弹窗）
function showProjectTeam(pid){
  var p = loadAllProjects().find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return; }
  var team = _normalizeTeam(p.team||[]);
  var owner = p.owner||'';
  var canEdit = (currentUser&&currentUser.name)===owner;

  var h = '';
  h += '<div style="font-size:12px;color:#6B7280;margin-bottom:16px">项目负责人：<strong style="color:#1F1F1F">'+esc(owner)+'</strong></div>';
  if(team.length===0){
    h += '<div style="padding:32px;text-align:center;color:#9CA3AF;font-size:13px">暂无项目组成员<br>'+(canEdit?'点击下方按钮添加成员':'')+'</div>';
  }else{
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px">';
    h += '<thead><tr style="border-bottom:1px solid #E5E7EB">';
    h += '<th style="text-align:left;padding:6px 4px;color:#6B7280;font-weight:500">姓名</th>';
    h += '<th style="text-align:left;padding:6px 4px;color:#6B7280;font-weight:500">部门</th>';
    h += '<th style="text-align:left;padding:6px 4px;color:#6B7280;font-weight:500">进入密码</th>';
    _RD_STAGE_KEYS.forEach(function(s){
      h += '<th style="text-align:center;padding:6px 4px;color:#6B7280;font-weight:500;width:36px">'+s.name+'</th>';
    });
    if(canEdit) h += '<th style="padding:6px 4px;width:50px"></th>';
    h += '</tr></thead><tbody>';
    team.forEach(function(t,i){
      h += '<tr style="border-bottom:1px solid #F3F4F6">';
      h += '<td style="padding:8px 4px;color:#1F1F1F;font-weight:500">'+esc(t.name)+'</td>';
      h += '<td style="padding:8px 4px;color:#6B7280">'+esc(t.dept||'-')+'</td>';
      h += '<td style="padding:8px 4px;color:#6B7280">'+(canEdit?esc(t.password||'未设'):'••••••')+'</td>';
      _RD_STAGE_KEYS.forEach(function(s){
        var checked = (t.accessStages||[]).indexOf(s.key)>=0;
        if(canEdit){
          h += '<td style="text-align:center;padding:8px 4px"><input type="checkbox" '+(checked?'checked':'')+' onchange="toggleMemberStage('+p.id+',\''+esc(t.name)+'\',\''+s.key+'\',this.checked)" style="cursor:pointer"></td>';
        }else{
          h += '<td style="text-align:center;padding:8px 4px">'+(checked?'☑':'—')+'</td>';
        }
      });
      if(canEdit) h += '<td style="padding:8px 4px;text-align:right"><button onclick="removeProjectMember('+p.id+',\''+esc(t.name)+'\')" style="padding:2px 6px;font-size:10px;border:1px solid #FCA5A5;border-radius:4px;background:#FEF2F2;color:#DC2626;cursor:pointer">移除</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    h += '<div style="margin-top:8px;font-size:10px;color:#9CA3AF">☑ = 该成员进入项目后可见此阶段信息</div>';
  }

  if(canEdit){
    h += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #E5E7EB">';
    h += '<div style="font-size:11px;color:#6B7280;margin-bottom:8px">添加成员</div>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    h += '<div style="flex:1;min-width:120px;position:relative"><input id="ptm-new-name" placeholder="姓名" autocomplete="off" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box"></div>';
    h += '<input id="ptm-new-pwd" placeholder="密码（默认随机）" style="width:140px;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
    h += '<button onclick="addProjectMember('+p.id+')" style="padding:8px 16px;background:#3B82F6;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">添加</button>';
    h += '</div>';
    h += '<div style="margin-top:8px;font-size:10px;color:#9CA3AF">勾选下方阶段以授权该成员查看对应里程碑信息</div>';
    h += '<div id="ptm-new-stages" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">';
    _RD_STAGE_KEYS.forEach(function(s){
      h += '<label style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#6B7280;cursor:pointer"><input type="checkbox" value="'+s.key+'" class="ptm-stage-cb">'+s.name+'</label>';
    });
    h += '</div></div>';
  }

  showFormModal(h, '项目团队设置 / Project Team Settings', '关闭 / Close', null, function(close){ close(); });
  attachEmpNameAutocomplete(document.getElementById('ptm-new-name'), {multi:false});
}

// ===== 项目甘特图 =====
// ★ V0.6.5z: 甘特图按钮改为直接进入项目详情的甘特图 Tab（替代旧弹窗）
async function openProjectGanttTab(pid){
  _pmDetailTab = 'gantt';
  await openPMDetail(pid);
}

function showProjectGantt(pid){
  var p = loadAllProjects().find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return; }
  var tasks = loadProjectTasks(pid);
  var startD = p.start_date ? new Date(p.start_date) : null;
  var endD = p.end_date ? new Date(p.end_date) : null;
  var today = new Date();
  today.setHours(0,0,0,0);

  // 计算时间轴范围
  var minD = startD, maxD = endD;
  tasks.forEach(function(t){
    var sd = t.start_date?new Date(t.start_date):null;
    var dd = t.due_date?new Date(t.due_date):null;
    if(sd && (!minD || sd<minD)) minD=sd;
    if(dd && (!maxD || dd>maxD)) maxD=dd;
  });
  if(!minD) minD = new Date(today.getFullYear(), today.getMonth(), 1);
  if(!maxD) maxD = new Date(minD.getTime()+30*24*3600*1000);
  var totalDays = Math.ceil((maxD-minD)/(24*3600*1000))||1;
  var dayW = Math.max(20, Math.floor(800/totalDays));
  var chartW = totalDays*dayW;

  var h = '';
  h += '<div style="font-size:13px;color:#1F1F1F;font-weight:600;margin-bottom:4px">'+esc(p.name||'')+'</div>';
  h += '<div style="font-size:11px;color:#6B7280;margin-bottom:16px">'+(p.start_date||'')+' ~ '+(p.end_date||'')+'</div>';
  h += '<div style="overflow-x:auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:12px">';
  h += '<div style="min-width:'+(chartW+140)+'px">';

  // 表头（日期）
  h += '<div style="display:flex;border-bottom:1px solid #E5E7EB;padding-bottom:4px;margin-bottom:8px">';
  h += '<div style="width:120px;flex-shrink:0;font-size:11px;font-weight:600;color:#6B7280">任务</div>';
  var step = Math.max(1,Math.ceil(totalDays/15));
  for(var i=0;i<totalDays;i+=step){
    var d = new Date(minD.getTime()+i*24*3600*1000);
    h += '<div style="width:'+(step*dayW)+'px;flex-shrink:0;font-size:10px;color:#9CA3AF;text-align:center">'+(d.getMonth()+1)+'/'+d.getDate()+'</div>';
  }
  h += '</div>';

  // 任务行
  var hasTasks = tasks.length>0;
  if(!hasTasks){
    h += '<div style="padding:32px;text-align:center;color:#9CA3AF;font-size:12px">暂无任务数据</div>';
  }else{
    tasks.forEach(function(t, ti){
      var sd = t.start_date?new Date(t.start_date):minD;
      var dd = t.due_date?new Date(t.due_date):sd;
      var offset = Math.max(0, Math.floor((sd-minD)/(24*3600*1000))*dayW);
      var barW = Math.max(1, Math.floor((dd-sd)/(24*3600*1000))*dayW);
      var prog = t.progress||0;
      var statusColor = t.status==='已完成'?'#059669':(t.status==='进行中'?'#3B82F6':'#9CA3AF');
      h += '<div style="display:flex;align-items:center;height:28px;border-bottom:1px solid #F3F4F6">';
      h += '<div style="width:120px;flex-shrink:0;font-size:11px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(t.title||'')+'">'+esc(t.title||'未命名')+'</div>';
      h += '<div style="flex:1;position:relative;height:20px">';
      h += '<div style="position:absolute;left:'+offset+'px;width:'+barW+'px;height:100%;background:'+statusColor+';border-radius:3px;opacity:'+(prog===0?'0.3':'0.8')+'"></div>';
      if(prog>0){
        h += '<div style="position:absolute;left:'+offset+'px;width:'+Math.floor(barW*prog/100)+'px;height:100%;background:'+statusColor+';border-radius:3px"></div>';
      }
      h += '</div>';
      h += '<div style="width:50px;flex-shrink:0;font-size:10px;color:#9CA3AF;text-align:right">'+prog+'%</div>';
      h += '</div>';
    });
  }

  // 今日线
  var todayOffset = Math.floor((today-minD)/(24*3600*1000))*dayW;
  if(todayOffset>=0 && todayOffset<=chartW){
    h += '<div style="position:relative;margin-top:4px">';
    h += '<div style="position:absolute;left:'+(120+todayOffset)+'px;top:-'+(tasks.length*28+8)+'px;width:1px;height:'+(tasks.length*28+16)+'px;background:#EF4444;z-index:2"></div>';
    h += '<div style="position:absolute;left:'+(120+todayOffset-14)+'px;top:-'+(tasks.length*28+16)+'px;font-size:9px;color:#EF4444;z-index:2">今天</div>';
    h += '</div>';
  }

  h += '</div></div>';
  h += '<div style="margin-top:12px;font-size:10px;color:#9CA3AF">● 绿色=已完成 | 蓝色=进行中 | 灰色=待开始</div>';

  showFormModal(h, '项目甘特图 / Project Gantt Chart', '关闭 / Close', null, function(close){ close(); });
}
async function addProjectMember(pid){
  var nameInput = document.getElementById('ptm-new-name');
  var pwdInput = document.getElementById('ptm-new-pwd');
  var name = (nameInput?nameInput.value.trim():'');
  var pwd = (pwdInput?pwdInput.value.trim():'')||_genPwd();
  if(!name){ _showAlert('请输入成员姓名'); return; }
  var p = loadAllProjects().find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return; }
  var team = _normalizeTeam(p.team||[]);
  if(team.some(function(t){return t.name===name;})){ _showAlert(name+' 已在项目组中'); return; }
  // 收集阶段权限
  var stages = [];
  document.querySelectorAll('.ptm-stage-cb:checked').forEach(function(cb){ stages.push(cb.value); });
  var dept = _getMemberDept(name);
  team.push({name:name, dept:dept, password:pwd, accessStages:stages, joinedAt:new Date().toISOString().split('T')[0]});
  p.team = team;
  await saveProject(p);
  _pmProjects = loadAllProjects();
  showProjectTeam(pid);
  renderPMList();
  showToast(name+' 已加入项目组，密码：'+pwd);
}

// 移除项目成员
async function removeProjectMember(pid, name){
  var p = loadAllProjects().find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return; }
  var team = _normalizeTeam(p.team||[]).filter(function(t){return t.name!==name;});
  p.team = team;
  await saveProject(p);
  _pmProjects = loadAllProjects();
  showProjectTeam(pid);
  renderPMList();
}

// 切换成员阶段权限
async function toggleMemberStage(pid, name, stageKey, checked){
  var p = loadAllProjects().find(function(x){return x.id===pid;});
  if(!p) return;
  var team = _normalizeTeam(p.team||[]);
  var member = team.find(function(t){return t.name===name;});
  if(!member) return;
  if(!member.accessStages) member.accessStages = [];
  if(checked){
    if(member.accessStages.indexOf(stageKey)<0) member.accessStages.push(stageKey);
  }else{
    member.accessStages = member.accessStages.filter(function(k){return k!==stageKey;});
  }
  p.team = team;
  await saveProject(p);
  showToast((checked?'已授权':'已取消')+' '+name+' 查看'+_RD_STAGE_KEYS.find(function(s){return s.key===stageKey;}).name+'阶段');
}

// ===== 成员名单门禁控制 =====
// ★ V0.6.5m: 非项目组成员不可进入；成员需验证密码；负责人/管理员免密
function _pmCanAccessProject(p){
  if(!p) return false;
  var me = (currentUser&&currentUser.name)||'';
  if(!me) return false;
  if(p.owner===me) return true;
  if(typeof hasPermission==='function'&&hasPermission('maintenance')) return true;
  var team = _normalizeTeam(p.team||[]);
  if(team.some(function(t){return t.name===me;})) return true;
  return false;
}

// 获取当前用户在项目中的成员信息
function _pmGetMemberInfo(p){
  if(!p) return null;
  var me = (currentUser&&currentUser.name)||'';
  if(!me) return null;
  if(p.owner===me) return {name:me, isOwner:true};
  var team = _normalizeTeam(p.team||[]);
  var m = team.find(function(t){return t.name===me;});
  return m?Object.assign({isOwner:false},m):null;
}

// 密码验证弹窗（成员进入项目时调用）
async function verifyProjectAccess(pid){
  var p = loadAllProjects().find(function(x){return x.id===pid;});
  if(!p){ _showAlert('项目不存在'); return false; }
  var me = (currentUser&&currentUser.name)||'';
  if(!me) return false;
  // 负责人/管理员免密
  if(p.owner===me) return true;
  if(typeof hasPermission==='function'&&hasPermission('maintenance')) return true;
  // 成员需验证密码
  var member = _pmGetMemberInfo(p);
  if(!member){ _showAlert('您不在项目成员名单中，无法查看本项目详情。<br><br>请联系项目负责人「'+esc(p.owner||'')+'」将您加入项目组。','权限提示',3000); return false; }
  if(!member.password){ _showAlert('项目负责人尚未为您设置进入密码，请联系负责人「'+esc(p.owner||'')+'」设置。','权限提示',3000); return false; }

  return new Promise(function(resolve){
    var _resolved = false;
    var h = '';
    h += '<div style="margin-bottom:16px;text-align:center">';
    h += '<div style="font-size:24px;margin-bottom:8px">🔐</div>';
    h += '<div style="font-size:14px;color:#1F1F1F;font-weight:600;margin-bottom:4px">项目区门禁验证</div>';
    h += '<div style="font-size:12px;color:#6B7280;margin-bottom:16px">请输入您的项目区进入密码</div>';
    h += '<input id="pv-pwd" type="password" maxlength="4" autocomplete="new-password" placeholder="4 位数字密码" style="width:180px;padding:10px 14px;border:1px solid #D0D5DD;border-radius:8px;font-size:16px;text-align:center;letter-spacing:4px;box-sizing:border-box" onkeydown="if(event.key===\'Enter\')document.getElementById(\'pm-form-ok\').click()">';
    h += '</div>';
    h += '<div id="pv-err" style="display:none;text-align:center;color:#DC2626;font-size:12px;margin-bottom:12px">密码错误，请重试</div>';
    showFormModal(h, '项目区门禁 / Project Access', '进入 / Enter', '取消 / Cancel', function(close){
      var pwd = document.getElementById('pv-pwd').value.trim();
      if(!pwd){ return; }
      if(pwd === member.password){
        _resolved = true;
        // ★ V0.6.5w: 先 resolve 再 close，确保弹窗被移除
        resolve(true);
        setTimeout(function(){ close(); }, 50);
      }else{
        document.getElementById('pv-err').style.display='block';
        document.getElementById('pv-pwd').value='';
        document.getElementById('pv-pwd').focus();
      }
    });
    // 密码输入框自动聚焦
    setTimeout(function(){
      var pwdInput = document.getElementById('pv-pwd');
      if(pwdInput) pwdInput.focus();
    }, 100);
    // ★ 取消/关闭时兜底 resolve(false)，防止 Promise 悬挂
    setTimeout(function(){
      var modalEl = document.getElementById('pm-form-modal');
      if(modalEl){
        var obs = new MutationObserver(function(mutations){
          if(!document.getElementById('pm-form-modal') && !_resolved){
            obs.disconnect();
            resolve(false);
          }
        });
        obs.observe(document.body, {childList:true});
      }
    }, 150);
  });
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
window.showProjectTeam = showProjectTeam;
window.showProjectGantt = showProjectGantt;
window.openProjectGanttTab = openProjectGanttTab;
window.addProjectMember = addProjectMember;
window.removeProjectMember = removeProjectMember;
window.toggleMemberStage = toggleMemberStage;
window._pmCanAccessProject = _pmCanAccessProject;
window._pmGetMemberInfo = _pmGetMemberInfo;
window.verifyProjectAccess = verifyProjectAccess;

console.log('[PM] Module loaded - V0.2.0 (研发项目管理 + HTML Modal)');

} // end _pmInit guard
