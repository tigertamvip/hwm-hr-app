/**
 * MBO+AI 研发项目管理 — 阶段门引擎（Stage-Gate Engine）
 * V1.0 P1 - 依据《MDR和FDA设计开发流程(1)》
 * 范围：仅 projects.type='研发' 挂载本引擎；其他项目类别不感知。
 * 数据：Supabase rd_stages / rd_deliverables / rd_gates + localStorage 缓存
 * 权限：评审结论仅项目负责人（owner/created_by）；交付物更新对登录用户开放。
 */

if(!window._rdpmInit){
window._rdpmInit = true;

// ===== Config =====
var RD_STAGE_TABLE = (typeof SUPABASE_RD_STAGES_TABLE!=='undefined')?SUPABASE_RD_STAGES_TABLE:'rd_stages';
var RD_DELIVER_TABLE = (typeof SUPABASE_RD_DELIVERABLES_TABLE!=='undefined')?SUPABASE_RD_DELIVERABLES_TABLE:'rd_deliverables';
var RD_GATE_TABLE = (typeof SUPABASE_RD_GATES_TABLE!=='undefined')?SUPABASE_RD_GATES_TABLE:'rd_gates';
var RD_CACHE_PREFIX = 'hwm_rd_';

var RD_STAGE_STATUS = {
  locked:        {label:'未解锁',   color:'#9CA3AF', bg:'#F3F4F6'},
  active:        {label:'进行中',   color:'#3B82F6', bg:'#EFF6FF'},
  pending_review:{label:'待评审',   color:'#D97706', bg:'#FFFBEB'},
  passed:        {label:'已通过',   color:'#059669', bg:'#ECFDF5'},
  conditional:   {label:'有条件通过',color:'#EA580C', bg:'#FFF7ED'},
  returned:      {label:'已退回',   color:'#DC2626', bg:'#FEF2F2'}
};
var RD_DELIVER_STATUS = {
  pending:    {label:'未开始', color:'#9CA3AF', bg:'#F3F4F6'},
  in_progress:{label:'撰写中', color:'#3B82F6', bg:'#EFF6FF'},
  submitted:  {label:'已提交', color:'#059669', bg:'#ECFDF5'},
  approved:   {label:'已通过', color:'#047857', bg:'#D1FAE5'},
  na:         {label:'不适用', color:'#D97706', bg:'#FFFBEB'}
};
var RD_GATE_RESULT = {
  pending:    {label:'待评审',   color:'#9CA3AF', bg:'#F3F4F6'},
  passed:     {label:'通过',     color:'#059669', bg:'#ECFDF5'},
  conditional:{label:'有条件通过',color:'#EA580C', bg:'#FFF7ED'},
  rejected:   {label:'退回',     color:'#DC2626', bg:'#FEF2F2'}
};

// ★ V0.6.6b: 甘特图颗粒度
var _rdGanttGranularity = null;

// ===== State =====
var _rdCurrent = null; // {project, stages, deliverables, gates, viewStageKey, tasks}

// ===== Utils =====
function _rdEsc(s){
  if(s===null||s===undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _rdToday(){
  var d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function _rdCnNum(n){
  var m = {'1':'一','2':'二','3':'三','4':'四','5':'五','6':'六','7':'七','8':'八','9':'九','10':'十'};
  return m[String(n)]||String(n);
}
function _rdCanReview(project){
  var me = (currentUser&&currentUser.name)||'';
  // ★ V0.6.5s: 管理员也可评审/删除
  var isAdmin = (typeof hasPermission==='function'&&hasPermission('maintenance'));
  return me && (project.owner===me || project.created_by===me || isAdmin);
}

// ===== Cache =====
function _rdCacheKey(pid){ return RD_CACHE_PREFIX+pid; }
function loadRdCache(pid){
  try{ return JSON.parse(localStorage.getItem(_rdCacheKey(pid))||'null'); }catch(e){ return null; }
}
function saveRdCache(pid, data){
  try{ localStorage.setItem(_rdCacheKey(pid), JSON.stringify(data)); }catch(e){}
}

// ===== Data Layer =====
async function syncRdFromCloud(pid){
  try{
    var s = await supabase.from(RD_STAGE_TABLE).select('*').eq('project_id',pid).order('order_index');
    if(s.error){ console.warn('[RD] stages sync error:', s.error.message); return null; }
    var d = await supabase.from(RD_DELIVER_TABLE).select('*').eq('project_id',pid).order('order_index');
    if(d.error){ console.warn('[RD] deliverables sync error:', d.error.message); return null; }
    var g = await supabase.from(RD_GATE_TABLE).select('*').eq('project_id',pid).order('order_index');
    if(g.error){ console.warn('[RD] gates sync error:', g.error.message); return null; }
    var data = {stages:s.data||[], deliverables:d.data||[], gates:g.data||[]};
    saveRdCache(pid, data);
    return data;
  }catch(e){ console.warn('[RD] sync exception:', e.message); return null; }
}

async function _rdInsert(table, rows){
  var r = await supabase.from(table).insert(rows).select();
  if(r.error) throw new Error(r.error.message);
  return r.data||[];
}
async function _rdUpdate(table, id, patch){
  patch.updated_at = new Date().toISOString();
  var r = await supabase.from(table).update(patch).eq('id',id);
  if(r.error) console.warn('[RD] update error:', table, r.error.message);
}

// ★ V0.6.4R: 整改任务创建——模块自治直插 project_tasks，不依赖 pm.js 内部函数
// （根因：pm.js 的 async createTask 未 window 导出，跨模块调用 ReferenceError 致评审提交静默卡死）
async function _rdCreateRectifyTask(pid, title){
  var now = new Date().toISOString();
  var row = {
    project_id: pid, title: title, status: '待开始', priority: '高',
    progress: 0, created_at: now, updated_at: now
  };
  var r = await supabase.from(SUPABASE_TASK_TABLE).insert(row).select();
  if(r.error) throw new Error(r.error.message);
  return (r.data&&r.data[0])||null;
}

// ★ V0.6.4U: 项目任务同步——模块自治直查 project_tasks（替代未导出的 pm.js syncTasksFromCloud）
// 根因：syncTasksFromCloud 是 pm.js 未 window 导出的 async 函数（Annex B 陷阱第三处），
// typeof 守卫恒 false → c.tasks 恒为空 → 整改项完成状态永远不亮、「确认通过」按钮永不显示
async function _rdSyncTasks(pid){
  if(!pid || typeof supabase==='undefined' || !supabase || !supabase.from) return [];
  try{
    var r = await supabase.from(SUPABASE_TASK_TABLE).select('*').eq('project_id',pid).order('order_index',{ascending:true});
    if(r.error) throw new Error(r.error.message);
    return r.data||[];
  }catch(e){ console.warn('[RD] sync tasks error:', e.message); return []; }
}

// ★ V0.6.4U: 整改项点击切换完成状态——研发详情页无任务看板，整改项须在页内可完成
async function _rdToggleRectifyTask(taskId){
  var c = _rdCurrent;
  if(!c) return;
  var t = (c.tasks||[]).find(function(x){return String(x.id)===String(taskId);});
  if(!t) return;
  var next = t.status==='已完成' ? '待开始' : '已完成';
  var now = new Date().toISOString();
  var r = await supabase.from(SUPABASE_TASK_TABLE).update({status:next, progress:next==='已完成'?100:0, updated_at:now}).eq('id',taskId);
  if(r.error){ _showAlert('更新失败: '+r.error.message); return; }
  t.status = next; t.progress = next==='已完成'?100:0; t.updated_at = now;
  renderRdDetail();
}

// ★ V0.6.4S: 姓名自动补全统一改用 pm.js 通用组件 attachEmpNameAutocomplete（本模块不再重复实现）
function _rdNameAutocomplete(input, multi){
  if(typeof attachEmpNameAutocomplete==='function') attachEmpNameAutocomplete(input, {multi:multi});
}

// ===== Template Instantiation =====
// startStageKey: 中间切入的起始阶段；之前的阶段补录通过
async function instantiateRdProject(pid, startStageKey){
  if(typeof RD_TEMPLATE==='undefined'){ console.warn('[RD] template missing'); return false; }
  var me = (currentUser&&currentUser.name)||'';
  var today = _rdToday();
  var startIdx = RD_TEMPLATE.findIndex(function(t){return t.stage_key===startStageKey;});
  if(startIdx<0) startIdx = 0;

  var stageRows = RD_TEMPLATE.map(function(t, i){
    var status = 'locked';
    if(i<startIdx) status = 'passed';
    else if(i===startIdx) status = 'active';
    return {
      project_id: pid, stage_key: t.stage_key, stage_name: t.stage_name,
      order_index: i, status: status, owner: me,
      actual_start: i<=startIdx?today:null,
      actual_end: i<startIdx?today:null
    };
  });
  try{
    var stages = await _rdInsert(RD_STAGE_TABLE, stageRows);
    var stageIdByKey = {};
    stages.forEach(function(s){ stageIdByKey[s.stage_key]=s.id; });

    var dRows = [], gRows = [];
    RD_TEMPLATE.forEach(function(t, i){
      var sid = stageIdByKey[t.stage_key];
      var prePassed = i<startIdx;
      var di = 0;
      t.deliverables.forEach(function(d){
        dRows.push({
          project_id: pid, stage_id: sid, item_key: d.item_key, name: d.name,
          is_key: d.is_key!==false, note: d.note||'',
          status: prePassed?'approved':'pending',
          version:'', iteration:'', order_index: di++
        });
      });
      // 设计输出：生成 DMR 1.0 迭代组（11 项全量）
      if(t.stage_key==='output'){
        RD_DMR_GROUP.forEach(function(g){
          dRows.push({
            project_id: pid, stage_id: sid, item_key: g.item_key, name: g.name,
            is_key: true, note:'', status: prePassed?'approved':'pending',
            version:'1.0', iteration:'1.0', order_index: di++
          });
        });
      }
      t.gates.forEach(function(g, gi){
        gRows.push({
          project_id: pid, stage_id: sid, gate_key: g.gate_key, gate_name: g.gate_name,
          is_adhoc: false, result: prePassed?'passed':'pending',
          review_date: prePassed?today:null, reviewed_by: prePassed?me:'',
          iteration: g.iteration||'', order_index: gi
        });
      });
    });
    await _rdInsert(RD_DELIVER_TABLE, dRows);
    await _rdInsert(RD_GATE_TABLE, gRows);
    console.log('[RD] instantiated project', pid, 'from stage', RD_TEMPLATE[startIdx].stage_key);
    return true;
  }catch(e){
    console.warn('[RD] instantiate error:', e.message);
    _showAlert('研发流程初始化失败: '+e.message);
    return false;
  }
}

// 确保研发项目已有阶段数据（老项目自动从头实例化）
async function ensureRdProject(pid){
  var data = await syncRdFromCloud(pid);
  if(data && data.stages.length>0) return data;
  var ok = await instantiateRdProject(pid, 'preresearch');
  if(!ok) return data;
  return await syncRdFromCloud(pid);
}

// 删除项目时清理（由 pm.js deleteProject 调用）
async function rdCleanupProject(pid){
  try{
    await supabase.from(RD_GATE_TABLE).delete().eq('project_id',pid);
    await supabase.from(RD_DELIVER_TABLE).delete().eq('project_id',pid);
    await supabase.from(RD_STAGE_TABLE).delete().eq('project_id',pid);
    localStorage.removeItem(_rdCacheKey(pid));
  }catch(e){ console.warn('[RD] cleanup error:', e.message); }
}

// ===== Progress =====
function calcRdProgress(stages, deliverables){
  if(!stages||!stages.length) return 0;
  var total = 0;
  stages.forEach(function(s){
    var tpl = RD_TEMPLATE.find(function(t){return t.stage_key===s.stage_key;});
    var w = tpl?tpl.weight:0;
    if(s.status==='passed'){ total += w; return; }
    if(s.status==='locked'){ return; }
    // 进行中：按关键交付物完成率折算
    var keys = deliverables.filter(function(d){return d.stage_id===s.id && d.is_key;});
    if(!keys.length){ return; }
    var done = keys.filter(function(d){return d.status==='submitted'||d.status==='approved'||d.status==='na';}).length;
    total += Math.round(w * done / keys.length);
  });
  return Math.min(100, total);
}

// ★ V0.6.5m: 成员阶段可见性 — 非负责人/管理员时按 accessStages 过滤
function _rdVisibleStages(p){
  var me = (currentUser&&currentUser.name)||'';
  if(!me) return [];
  // 负责人/管理员可看全部
  if(p.owner===me) return null; // null = 不过滤
  if(typeof hasPermission==='function'&&hasPermission('maintenance')) return null;
  // 从项目团队数据中获取当前用户的 accessStages
  var team = (p.team||[]);
  var member = null;
  team.forEach(function(t){
    if(t && t.name===me) member = t;
  });
  if(!member) return []; // 不在团队 = 无权限
  return member.accessStages||[];
}

function _rdCanSeeStage(p, stageKey){
  var vis = _rdVisibleStages(p);
  if(vis===null) return true; // 不过滤
  return vis.indexOf(stageKey)>=0;
}

// ===== Detail View Entry (pm.js openPMDetail 分流，DOM 切换由 pm.js 完成) =====
// ★ V0.6.5w: 密码验证已在 openPMDetail 完成，此处不再重复（否则弹窗出现两次）
async function openRdProjectDetail(p){
  // ★ V0.6.4N: 写入 pmDetailContent（与通用详情页同容器），避免摧毁该节点导致通用详情页空白
  var detailEl = document.getElementById('pmDetailContent') || document.getElementById('pmDetailView');
  if(detailEl){
    detailEl.innerHTML = '<div style="text-align:center;padding:60px;color:#9CA3AF;font-size:13px">正在加载研发流程数据…</div>';
  }
  var data = await ensureRdProject(p.id);
  if(!data){ _showAlert('研发流程数据加载失败'); return; }
  // ★ V0.6.5m: 默认展示当前用户有权限的第一个阶段
  var active = data.stages.find(function(s){return s.status!=='locked'&&s.status!=='passed';}) || data.stages[data.stages.length-1];
  if(active && !_rdCanSeeStage(p, active.stage_key)){
    var firstVisible = data.stages.find(function(s){return _rdCanSeeStage(p, s.stage_key);});
    if(firstVisible) active = firstVisible;
  }
  _rdCurrent = {
    project: p, stages: data.stages, deliverables: data.deliverables, gates: data.gates,
    viewStageKey: active?active.stage_key:null, tasks: []
  };
  // 同步任务（整改项状态检查用）★ V0.6.4U: 模块自治 _rdSyncTasks
  _rdCurrent.tasks = await _rdSyncTasks(p.id);
  // 进度回写
  var prog = calcRdProgress(data.stages, data.deliverables);
  if(p.progress!==prog){
    p.progress = prog;
    if(typeof saveProject==='function') await saveProject(p);
  }
  renderRdDetail();
}

// ===== Render: Detail =====
// ★ V0.6.5aa: 研发详情页 Tab 切换 — 阶段管道 | 甘特图
var _rdDetailTab = 'pipeline';

function renderRdDetail(){
  var el = document.getElementById('pmDetailContent') || document.getElementById('pmDetailView');
  if(!el || !_rdCurrent) return;
  var c = _rdCurrent, p = c.project;
  var canReview = _rdCanReview(p);

  var h = '';
  // ★ V0.6.4N: 工具栏+阶段管道条 sticky 固定，滚动交付物清单时保持可见（V0.6.4P: 底色与外层滚动容器 #F3F4F6 统一，消除色差）
  h += '<div style="position:sticky;top:0;z-index:20;background:#F3F4F6;padding:4px 0 10px">';
  // Toolbar（★ V0.6.4O: 「返回列表」已上移至页面 header，此处不重复）
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">';
  h += '<div style="display:flex;align-items:center;gap:10px">';
  h += '<span style="font-weight:600;font-size:16px;color:#111827">'+_rdEsc(p.name)+'</span>';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#EFF6FF;color:#3B82F6">新产品开发</span>';
  h += '<span style="font-size:11px;color:#6B7280">负责人：'+_rdEsc(p.owner||'')+'</span>';
  h += '</div>';
  h += '<div style="display:flex;align-items:center;gap:12px">';
  h += '<div style="font-size:12px;color:#6B7280">进度 <span style="font-weight:600;color:#111827">'+(p.progress||0)+'%</span></div>';
  if(canReview){
    h += '<button onclick="if(typeof deleteProject===\'function\')deleteProject('+p.id+')" style="padding:4px 10px;border:1px solid #FCA5A5;border-radius:6px;background:#FEF2F2;color:#B3382C;font-size:11px;cursor:pointer">删除项目</button>';
  }
  h += '</div>';
  h += '</div>';

  // ★ V0.6.5aa: Tab 切换 — 阶段管道 | 甘特图
  h += '<div style="display:flex;gap:0;margin-bottom:14px;border-bottom:1px solid #E5E7EB">';
  var rdTabs = [{key:'pipeline',label:'阶段管道'},{key:'gantt',label:'甘特图'}];
  rdTabs.forEach(function(t){
    var sel = _rdDetailTab===t.key;
    h += '<div onclick="window._rdDetailTab=\''+t.key+'\';renderRdDetail();" style="padding:8px 16px;font-size:12px;cursor:pointer;border-bottom:2px solid '+(sel?'#3B82F6':'transparent')+';color:'+(sel?'#3B82F6':'#6B7280')+';font-weight:'+(sel?'600':'400')+';margin-bottom:-1px">'+t.label+'</div>';
  });
  h += '</div>';

  if(_rdDetailTab==='gantt' || window._rdDetailTab==='gantt'){
    // 甘特图视图 — 用研发阶段数据渲染
    h += _renderRdGantt(c);
  }else{
    // Pipeline bar
    h += renderRdPipeline(c);
    h += '</div>'; // /sticky 头部容器

    // Current stage panel（★ V0.6.5m: 成员阶段权限检查 — 未授权阶段不渲染面板）
    var vs = c.stages.find(function(s){return s.stage_key===c.viewStageKey;});
    if(vs && !_rdCanSeeStage(c.project, vs.stage_key)){
      vs = c.stages.find(function(s){return _rdCanSeeStage(c.project, s.stage_key);});
      if(vs) c.viewStageKey = vs.stage_key;
    }
    if(vs) h += renderRdStagePanel(c, vs, canReview);

    // History (other stages, collapsed)
    h += renderRdHistory(c);
  }

  el.innerHTML = h;
  // ★ V0.6.6n: 绑定内嵌团队激励面板的事件
  if(typeof _rdBindBonusPanel==='function' && document.getElementById('rd-mem-tbody')){
    setTimeout(_rdBindBonusPanel, 0);
  }
}

// ★ V0.6.6k: 判断当前用户是否为项目负责人
function _rdIsProjectOwner(){
  if(!_rdCurrent||!_rdCurrent.project) return false;
  var p = _rdCurrent.project;
  var me = (typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||'';
  return p.owner === me || (typeof hasPermission==='function'&&hasPermission('maintenance'));
}

// ★ V0.6.6l: 解析项目成员数据（兼容旧字符串+新JSON数组）
function _rdParseMembers(raw){
  if(!raw) return [];
  if(typeof raw === 'object') return raw;
  if(typeof raw !== 'string') return [];
  var trimmed = raw.trim();
  if(!trimmed) return [];
  if(trimmed.startsWith('[')){
    try{ var arr = JSON.parse(trimmed); if(Array.isArray(arr)) return arr; }catch(e){}
  }
  // 兼容旧格式：逗号分隔的名字
  return trimmed.split(/[,，、;；\s]+/).filter(function(n){return n&&n.trim();}).map(function(n){
    return {name:n.trim(),dept:'',role:'组员',ratio:0};
  });
}

// ★ V0.6.6l: 计算项目成员总人数
function _rdMembersCount(raw){
  return _rdParseMembers(raw).length;
}

// ★ V0.6.6l: 渲染项目成员管理弹窗（含表格+自动求和+100%校验）
// ★ V0.6.6m: 奖金计算引擎 — 积分映射+四步算法+自动计算
var BONUS_SCORE = {'+2':5,'+1':3,'0':2,'-1':1,'-2':0,'无法评估':0};
var EFF_SCORE = {'按时交付':5,'延期交付':2,'逾期未交付':0};
var EFF_OPTIONS = ['按时交付','延期交付','逾期未交付'];
var QUAL_OPTIONS = ['+2','+1','0','-1','-2'];
var OVERALL_OPTIONS = ['+2','+1','0','-1','-2','无法评估'];
var QUAL_LABEL = {'+2':'+2级 优于预期','+1':'+1级 略优于预期','0':'0级 符合预期','-1':'-1级 有差距','-2':'-2级 严重差距'};
var OVERALL_LABEL = {'+2':'+2级 优秀','+1':'+1级 良好','0':'0级 合格','-1':'-1级 基本合格','-2':'-2级 有较大差距','无法评估':'无法评估'};

async function _rdOpenMembersModal(stageId){
  if(!_rdCurrent) return;
  var stage = _rdCurrent.stages.find(function(s){return s.id===stageId;});
  if(!stage) return;
  var me = (typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||'';
  var isOwner = stage.owner === me || (typeof hasPermission==='function'&&hasPermission('maintenance'));
  if(!isOwner){
    showToast('仅项目负责人可编辑项目成员');
    return;
  }
  var members = _rdParseMembers(stage.members||'');
  var team = _rdCurrent.project && _rdCurrent.project.team ? _rdCurrent.project.team : [];
  function findDept(n){ var m = team.find(function(t){return t.name===n;}); return m?(m.dept||''):''; }

  // 总奖金池：优先取阶段已保存的，否则取项目奖金池
  var bonusPool = stage.bonus_pool || _rdCurrent.project.bonus_pool || '';
  var isReadOnly = !isOwner;

  var html = '';
  html += '<style>#bonus-modal-wrap .bonus-select{width:100%;padding:4px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box}#bonus-modal-wrap .bonus-input{width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box}#bonus-modal-wrap th{position:sticky;top:0;background:#F9FAFB;z-index:1;padding:6px 4px;border-bottom:1px solid #E5E7EB;font-size:10px;font-weight:600;color:#6B7280;white-space:nowrap}#bonus-modal-wrap td{padding:5px 3px;border-bottom:1px solid #F3F4F6;font-size:11px}</style>';
  html += '<div id="bonus-modal-wrap" style="min-width:1100px">';
  html += '<div style="margin-bottom:8px;font-size:12px;color:#6B7280">项目成员绩效评价与奖金分配</div>';
  html += '<div id="rd-mem-table" style="max-height:380px;overflow:auto;border:1px solid #E5E7EB;border-radius:6px">';
  html += '<table style="width:100%;border-collapse:collapse">';
  html += '<thead><tr>';
  html += '<th style="width:32px">#</th>';
  html += '<th>姓名</th>';
  html += '<th style="width:70px">部门</th>';
  html += '<th style="width:70px">职责</th>';
  html += '<th style="width:80px">交付效率</th>';
  html += '<th style="width:80px">交付质量</th>';
  html += '<th style="width:85px">综合评价</th>';
  html += '<th style="width:72px">分配比%</th>';
  html += '<th style="width:80px">预算基数</th>';
  html += '<th style="width:85px">应发奖金</th>';
  html += '<th style="width:40px">操作</th>';
  html += '</tr></thead><tbody id="rd-mem-tbody">';

  function buildRow(idx, m){
    var eff = m.efficiency||'按时交付';
    var qual = m.quality||'0';
    var ovr = m.overall||'无法评估';
    var ratio = m.ratio||0;
    var base = _rdCalcBaseAmount(bonusPool, ratio);
    var finalAmt = _rdCalcFinalAmount(m, bonusPool, members);
    var h = '<tr data-idx="'+idx+'">';
    h += '<td style="text-align:center;color:#6B7280">'+(idx+1)+'</td>';
    h += '<td><input class="bonus-input rd-mem-name" data-fld="name" value="'+esc(m.name||'')+'" placeholder="选择"></td>';
    h += '<td><input class="bonus-input rd-mem-dept" data-fld="dept" value="'+esc(m.dept||findDept(m.name)||'')+'"></td>';
    h += '<td><input class="bonus-input rd-mem-role" data-fld="role" value="'+esc(m.role||'组员')+'"></td>';
    // 交付效率
    h += '<td><select class="bonus-select rd-mem-eff" data-fld="efficiency">';
    EFF_OPTIONS.forEach(function(e){ h += '<option value="'+e+'"'+(eff===e?' selected':'')+'>'+e+'</option>'; });
    h += '</select></td>';
    // 交付质量
    h += '<td><select class="bonus-select rd-mem-qual" data-fld="quality">';
    QUAL_OPTIONS.forEach(function(q){ h += '<option value="'+q+'"'+(qual===q?' selected':'')+'>'+QUAL_LABEL[q]+'</option>'; });
    h += '</select></td>';
    // 综合评价
    h += '<td><select class="bonus-select rd-mem-ovr" data-fld="overall">';
    OVERALL_OPTIONS.forEach(function(o){ h += '<option value="'+o+'"'+(ovr===o?' selected':'')+'>'+OVERALL_LABEL[o]+'</option>'; });
    h += '</select></td>';
    // 分配比
    h += '<td><input class="bonus-input rd-mem-ratio" data-fld="ratio" type="number" min="0" max="100" step="0.1" value="'+ratio+'" style="text-align:center"></td>';
    // 预算基数
    h += '<td style="text-align:right;color:#6B7280;padding-right:8px" class="rd-mem-base">'+(base?base.toFixed(0):'—')+'</td>';
    // 应发奖金
    h += '<td style="text-align:right;color:#1B6EC4;font-weight:600;padding-right:8px" class="rd-mem-final">'+(finalAmt?finalAmt.toFixed(0):'—')+'</td>';
    h += '<td style="text-align:center"><button type="button" class="rd-mem-del" style="padding:2px 6px;border:1px solid #FCA5A5;border-radius:4px;background:#FEF2F2;color:#DC2626;cursor:pointer;font-size:10px">×</button></td>';
    h += '</tr>';
    return h;
  }
  if(!members.length){ members = [{name:'',dept:'',role:'组员',ratio:0,efficiency:'按时交付',quality:'0',overall:'无法评估'}]; }
  members.forEach(function(m, i){ html += buildRow(i, m); });
  html += '</tbody></table></div>';

  // 底栏：总奖金池 + 比例合计 + 单位积分奖金 + 添加成员
  var unitBonus = _rdCalcUnitBonus(members, bonusPool);
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;flex-wrap:wrap;gap:8px">';
  html += '<div style="display:flex;align-items:center;gap:12px">';
  html += '<button type="button" id="rd-mem-add" style="padding:6px 14px;border:1px solid #D0D5DD;border-radius:6px;background:#fff;color:#374151;cursor:pointer;font-size:12px">+ 添加成员</button>';
  html += '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:11px;color:#6B7280;white-space:nowrap">总奖金池</span><input type="number" id="rd-bonus-pool" value="'+bonusPool+'" placeholder="金额" style="width:110px;padding:4px 8px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;text-align:right" step="1" min="0"></div>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:16px">';
  html += '<span style="font-size:11px;color:#6B7280">比例合计：<span id="rd-mem-sum" style="font-weight:600;color:#1B6EC4;font-size:13px">0</span>%</span>';
  html += '<span id="rd-mem-warn" style="color:#DC2626;font-size:11px;display:none">⚠ 超过100%</span>';
  html += '<span style="font-size:11px;color:#6B7280">单位积分奖金：<span id="rd-unit-bonus" style="font-weight:600;color:#059669;font-size:13px">—</span></span>';
  html += '</div>';
  html += '</div></div>';

  showFormModal(html, '项目组成员 / Members', '保存 / Save', '取消 / Cancel', function(close){
    var tbody = document.getElementById('rd-mem-tbody');
    var rows = tbody ? tbody.querySelectorAll('tr') : [];
    var arr = [];
    rows.forEach(function(tr){
      var name = tr.querySelector('[data-fld="name"]').value.trim();
      if(!name) return;
      var dept = tr.querySelector('[data-fld="dept"]').value.trim();
      var role = tr.querySelector('[data-fld="role"]').value.trim();
      var ratio = parseFloat(tr.querySelector('[data-fld="ratio"]').value)||0;
      var efficiency = tr.querySelector('[data-fld="efficiency"]').value;
      var quality = tr.querySelector('[data-fld="quality"]').value;
      var overall = tr.querySelector('[data-fld="overall"]').value;
      arr.push({name:name,dept:dept,role:role||'组员',ratio:ratio,efficiency:efficiency,quality:quality,overall:overall});
    });
    var total = arr.reduce(function(s,m){return s+(+m.ratio||0);},0);
    if(total > 100.01){
      showAlert('奖金分配比例总和为 '+total.toFixed(1)+'%，超过 100%，请调整后保存。','比例超限');
      return;
    }
    var pool = parseFloat(document.getElementById('rd-bonus-pool').value)||0;
    var json = JSON.stringify(arr);
    close();
    try{
      supabase.from(RD_STAGE_TABLE).update({members:json,bonus_pool:pool}).eq('id',stageId).then(function(){
        stage.members = json;
        stage.bonus_pool = pool;
        if(_rdCurrent.project) _rdCurrent.project.bonus_pool = pool;
        renderRdDetail();
        showToast('已保存');
      });
    }catch(e){ showToast('保存失败: '+e.message); }
  });

  // 绑定交互
  function recalcAll(){
    var tbody = document.getElementById('rd-mem-tbody');
    var allMem = [];
    var sum = 0;
    if(tbody){
      tbody.querySelectorAll('tr').forEach(function(tr){
        var name = tr.querySelector('[data-fld="name"]')?.value||'';
        var ratio = parseFloat(tr.querySelector('[data-fld="ratio"]')?.value)||0;
        var efficiency = tr.querySelector('[data-fld="efficiency"]')?.value||'';
        var quality = tr.querySelector('[data-fld="quality"]')?.value||'0';
        var overall = tr.querySelector('[data-fld="overall"]')?.value||'';
        sum += ratio;
        allMem.push({name:name,ratio:ratio,efficiency:efficiency,quality:quality,overall:overall});
      });
    }
    var pool = parseFloat((document.getElementById('rd-bonus-pool')?.value))||0;
    // 更新比例合计
    var sumEl = document.getElementById('rd-mem-sum');
    var warnEl = document.getElementById('rd-mem-warn');
    if(sumEl) sumEl.textContent = sum.toFixed(1);
    if(warnEl) warnEl.style.display = sum > 100.01 ? 'inline' : 'none';

    // 计算所有成员的积分+奖金
    var totalScore = 0;
    allMem.forEach(function(m){
      m.score = (EFF_SCORE[m.efficiency]||0) + (BONUS_SCORE[m.quality]||0) + (BONUS_SCORE[m.overall]||0);
      totalScore += m.score;
    });
    var unitBonus = totalScore > 0 ? pool / totalScore : 0;
    var unitEl = document.getElementById('rd-unit-bonus');
    if(unitEl) unitEl.textContent = unitBonus > 0 ? (unitBonus.toFixed(0)+' 元/分') : '—';

    // 更新预算基数和应发奖金
    if(tbody){
      tbody.querySelectorAll('tr').forEach(function(tr, i){
        var baseEl = tr.querySelector('.rd-mem-base');
        var finalEl = tr.querySelector('.rd-mem-final');
        if(i < allMem.length && allMem[i].name){
          var base = pool * (allMem[i].ratio / 100);
          var final = allMem[i].score * unitBonus;
          if(baseEl) baseEl.textContent = base ? base.toFixed(0) : '—';
          if(finalEl) finalEl.textContent = final ? final.toFixed(0) : '—';
        }
      });
    }
  }

  setTimeout(function(){
    var tbody = document.getElementById('rd-mem-tbody');
    function bindRow(tr){
      tr.querySelectorAll('input,select').forEach(function(inp){
        inp.addEventListener('input', recalcAll);
        inp.addEventListener('change', recalcAll);
      });
      var nameInp = tr.querySelector('[data-fld="name"]');
      if(nameInp && typeof attachEmpNameAutocomplete==='function'){
        attachEmpNameAutocomplete(nameInp, {multi:false});
        nameInp.addEventListener('input', function(){
          var dep = findDept(nameInp.value.trim());
          if(dep) tr.querySelector('[data-fld="dept"]').value = dep;
        });
      }
      var del = tr.querySelector('.rd-mem-del');
      if(del) del.addEventListener('click', function(){
        tr.parentNode.removeChild(tr);
        renumberRows();
        recalcAll();
      });
    }
    function renumberRows(){
      tbody.querySelectorAll('tr').forEach(function(tr, i){
        tr.setAttribute('data-idx', i);
        var idxCell = tr.querySelector('td:first-child');
        if(idxCell) idxCell.textContent = i+1;
      });
    }
    tbody.querySelectorAll('tr').forEach(bindRow);
    document.getElementById('rd-bonus-pool')?.addEventListener('input', recalcAll);
    var addBtn = document.getElementById('rd-mem-add');
    if(addBtn){
      addBtn.addEventListener('click', function(){
        var tmp = document.createElement('tbody');
        tmp.innerHTML = buildRow(tbody.querySelectorAll('tr').length, {name:'',dept:'',role:'组员',ratio:0,efficiency:'按时交付',quality:'0',overall:'无法评估'});
        var newRow = tmp.firstChild;
        tbody.appendChild(newRow);
        bindRow(newRow);
        recalcAll();
      });
    }
    recalcAll();
  }, 80);
}

// ★ V0.6.6m: 奖金计算辅助函数
function _rdCalcBaseAmount(pool, ratio){ if(!pool||!ratio) return 0; return parseFloat(pool) * (parseFloat(ratio)/100); }
function _rdCalcUnitBonus(members, pool){
  if(!pool||!members.length) return 0;
  var total = 0;
  members.forEach(function(m){
    if(!m.name) return;
    total += (EFF_SCORE[m.efficiency||'按时交付']||0)+(BONUS_SCORE[m.quality||'0']||0)+(BONUS_SCORE[m.overall||'无法评估']||0);
  });
  return total > 0 ? parseFloat(pool) / total : 0;
}
function _rdCalcFinalAmount(m, pool, allMembers){
  if(!pool||!m.name) return 0;
  var score = (EFF_SCORE[m.efficiency||'按时交付']||0)+(BONUS_SCORE[m.quality||'0']||0)+(BONUS_SCORE[m.overall||'无法评估']||0);
  var totalScore = 0;
  allMembers.forEach(function(m2){ if(m2.name) totalScore += (EFF_SCORE[m2.efficiency||'按时交付']||0)+(BONUS_SCORE[m2.quality||'0']||0)+(BONUS_SCORE[m2.overall||'无法评估']||0); });
  return totalScore > 0 ? (parseFloat(pool) * score / totalScore) : 0;
}

// ★ V0.6.5aa: 研发项目甘特图 — 用阶段数据渲染
function _renderRdGantt(c){
  var p = c.project;
  var stages = c.stages||[];

  // ★ V0.6.6j: 时间轴范围自动适配——以项目起止为锚，扩展到所有阶段的日期范围
  var projStart = p.start_date ? new Date(p.start_date) : new Date();
  var projEnd = p.end_date ? new Date(p.end_date) : new Date(projStart.getTime()+90*24*3600*1000);
  var minMs = projStart.getTime(), maxMs = projEnd.getTime();
  stages.forEach(function(s){
    if(s.start_date){
      var sd = new Date(s.start_date).getTime();
      if(sd < minMs) minMs = sd;
    }
    if(s.end_date){
      var ed = new Date(s.end_date).getTime();
      if(ed > maxMs) maxMs = ed;
    }
  });
  var startD = new Date(minMs);
  var endD = new Date(maxMs);
  var today = new Date();
  today.setHours(0,0,0,0);
  var totalMs = endD - startD || 1;

  // ★ V0.6.6b: 五档颗粒度
  var gran = (typeof _rdGanttGranularity!=='undefined' && _rdGanttGranularity) || 'auto';
  if(gran==='auto'){
    var days = Math.ceil(totalMs/(24*3600*1000));
    gran = days<=30?'day':days<=180?'week':days<=365?'month':days<=730?'quarter':'year';
  }

  var h = '';
  // 颗粒度切换
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
  h += '<span style="font-size:12px;color:#6B7280">时间颗粒度：</span>';
  ['day','week','month','quarter','year'].forEach(function(g){
    var sel = gran===g;
    h += '<button onclick="window._rdGanttGranularity=\''+g+'\';renderRdDetail();" style="padding:4px 12px;font-size:11px;border:1px solid '+(sel?'#3B82F6':'#D0D5DD')+';border-radius:6px;background:'+(sel?'#3B82F6':'#fff')+';color:'+(sel?'#fff':'#6B7280')+';cursor:pointer">'+_rdGanttGranularityLabel(g)+'</button>';
  });
  h += '</div>';

  // 时间轴计算
  var colW, cols = [];
  if(gran==='day'){
    colW = 40;
    for(var d=new Date(startD); d<=endD; d.setDate(d.getDate()+1)){
      cols.push({label:(d.getMonth()+1)+'/'+d.getDate(), ms:24*3600*1000, start:new Date(d)});
    }
  }else if(gran==='week'){
    colW = 80;
    var wd = new Date(startD);
    wd.setDate(wd.getDate()-wd.getDay());
    while(wd<=endD){
      var we = new Date(wd); we.setDate(we.getDate()+6);
      cols.push({label:(wd.getMonth()+1)+'/'+wd.getDate()+'~'+(we.getMonth()+1)+'/'+we.getDate(), ms:7*24*3600*1000, start:new Date(wd)});
      wd.setDate(wd.getDate()+7);
    }
  }else if(gran==='month'){
    colW = 100;
    var md = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while(md<=endD){
      var me = new Date(md.getFullYear(), md.getMonth()+1, 0);
      cols.push({label:md.getFullYear()+'-'+String(md.getMonth()+1).padStart(2,'0'), ms:me-md, start:new Date(md)});
      md.setMonth(md.getMonth()+1);
    }
  }else if(gran==='quarter'){
    colW = 120;
    var qm = Math.floor(startD.getMonth()/3)*3;
    var qd = new Date(startD.getFullYear(), qm, 1);
    while(qd<=endD){
      var qe = new Date(qd.getFullYear(), qd.getMonth()+3, 0);
      cols.push({label:qd.getFullYear()+'Q'+(Math.floor(qd.getMonth()/3)+1), ms:qe-qd, start:new Date(qd)});
      qd.setMonth(qd.getMonth()+3);
    }
  }else{ // year
    colW = 150;
    var yd = new Date(startD.getFullYear(), 0, 1);
    while(yd<=endD){
      var ye = new Date(yd.getFullYear()+1, 0, 0);
      cols.push({label:yd.getFullYear()+'年', ms:ye-yd, start:new Date(yd)});
      yd.setFullYear(yd.getFullYear()+1);
    }
  }
  var chartW = cols.length * colW;

  h += '<div style="background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px">';
  h += '<div style="overflow-x:auto">';
  h += '<div style="min-width:'+(chartW+520)+'px">';

  // ★ V0.6.6k: 表头——OWN + 副组长 + 项目助理 + 项目成员 + 起止日期
  var isOwner = _rdIsProjectOwner();
  h += '<div style="display:flex;border-bottom:1px solid #E5E7EB;background:#F9FAFB;padding-bottom:6px;margin-bottom:8px">';
  h += '<div style="width:80px;flex-shrink:0;padding:6px 8px;font-size:11px;font-weight:600;color:#374151;border-right:1px solid #E5E7EB">阶段</div>';
  h += '<div style="width:70px;flex-shrink:0;padding:6px 4px;font-size:10px;font-weight:600;color:#6B7280;border-right:1px solid #E5E7EB">OWN</div>';
  h += '<div style="width:70px;flex-shrink:0;padding:6px 4px;font-size:10px;font-weight:600;color:#6B7280;border-right:1px solid #E5E7EB">副组长</div>';
  h += '<div style="width:70px;flex-shrink:0;padding:6px 4px;font-size:10px;font-weight:600;color:#6B7280;border-right:1px solid #E5E7EB">项目助理</div>';
  h += '<div style="width:100px;flex-shrink:0;padding:6px 4px;font-size:10px;font-weight:600;color:#6B7280;border-right:1px solid #E5E7EB">项目成员</div>';
  h += '<div style="width:80px;flex-shrink:0;padding:6px 4px;font-size:10px;font-weight:600;color:#6B7280;border-right:1px solid #E5E7EB">启动日期</div>';
  h += '<div style="width:80px;flex-shrink:0;padding:6px 4px;font-size:10px;font-weight:600;color:#6B7280;border-right:1px solid #E5E7EB">完成截止</div>';
  cols.forEach(function(c){
    h += '<div style="width:'+colW+'px;flex-shrink:0;padding:6px 2px;font-size:10px;color:#9CA3AF;text-align:center;border-right:1px solid #F3F4F6">'+c.label+'</div>';
  });
  h += '</div>';

  // 计算每个阶段的日期范围：优先用用户设置的 start_date/end_date，否则按权重分配
  var stageNames = {preresearch:'预研',initiation:'立项',input:'设计输入',output:'设计输出',verification:'设计验证',validation:'设计确认',transfer:'设计转化'};
  var stageColors = {passed:'#059669',active:'#3B82F6',locked:'#9CA3AF'};
  var totalWeight = 0;
  stages.forEach(function(s){
    var tpl = (typeof RD_TEMPLATE!=='undefined') ? RD_TEMPLATE.find(function(t){return t.stage_key===s.stage_key;}) : null;
    totalWeight += tpl ? tpl.weight : 0;
  });
  var currentD = new Date(startD);
  var stageBars = [];
  stages.forEach(function(s, i){
    var tpl = (typeof RD_TEMPLATE!=='undefined') ? RD_TEMPLATE.find(function(t){return t.stage_key===s.stage_key;}) : null;
    var w = tpl ? tpl.weight : 0;
    // ★ V0.6.6j: 优先用用户手动设置的日期，否则按权重分配
    var sStart, sEnd;
    if(s.start_date && s.end_date){
      sStart = new Date(s.start_date);
      sEnd = new Date(s.end_date);
    }else{
      var stageMs = totalMs * (w / totalWeight);
      sStart = new Date(currentD);
      sEnd = new Date(currentD.getTime() + stageMs);
    }
    stageBars.push({
      name: stageNames[s.stage_key]||s.stage_name,
      status: s.status,
      start: sStart,
      end: sEnd,
      weight: w,
      owner: s.owner||'',
      vice_leader: s.vice_leader||'',
      assistant: s.assistant||'',
      members: s.members||'',
      startDate: s.start_date||'',
      endDate: s.end_date||'',
      id: s.id
    });
    if(!(s.start_date && s.end_date)) currentD = sEnd;
  });

  // 阶段条
  var barH = 32;
  stageBars.forEach(function(sb, i){
    var offset = Math.max(0, (sb.start - startD) / totalMs * chartW);
    var barW = Math.max(4, (sb.end - sb.start) / totalMs * chartW);
    var color = stageColors[sb.status]||'#9CA3AF';
    var own = sb.owner||'TBD';
    var vice = sb.vice_leader||'TBD';
    var asst = sb.assistant||'TBD';
    var mems = sb.members||'TBD';
    var startDate = sb.startDate||'TBD';
    var endDate = sb.endDate||'TBD';
    // ★ V0.6.6k: 项目负责人才能编辑，其他人只读
    var editCursor = isOwner?'pointer':'default';
    var editHint = isOwner?'点击修改':'仅项目负责人可编辑';

    h += '<div style="display:flex;align-items:center;height:'+barH+'px;border-bottom:1px solid #F3F4F6;'+(i%2===0?'background:#fff':'background:#FAFAFA')+'">';
    h += '<div style="width:80px;flex-shrink:0;padding:6px 8px;font-size:11px;color:#374151;border-right:1px solid #E5E7EB;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_rdEsc(sb.name)+'">'+_rdEsc(sb.name)+'</div>';
    // OWN
    h += '<div style="width:70px;flex-shrink:0;padding:6px 4px;font-size:10px;border-right:1px solid #E5E7EB;display:flex;align-items:center">'
       + '<span '+(isOwner?'onclick="_rdEditStageField(\''+sb.id+'\',\'owner\',\''+esc(own)+'\')"':'')+' style="cursor:'+editCursor+';color:'+(own==='TBD'?'#A8A29A':'#374151')+';border-bottom:1px dashed '+(own==='TBD'?'#D0D5DD':'transparent')+';padding:1px 2px" title="'+editHint+'">'+_rdEsc(own)+'</span>'
       + '</div>';
    // 副组长
    h += '<div style="width:70px;flex-shrink:0;padding:6px 4px;font-size:10px;border-right:1px solid #E5E7EB;display:flex;align-items:center">'
       + '<span '+(isOwner?'onclick="_rdEditStageField(\''+sb.id+'\',\'vice_leader\',\''+esc(vice)+'\')"':'')+' style="cursor:'+editCursor+';color:'+(vice==='TBD'?'#A8A29A':'#374151')+';border-bottom:1px dashed '+(vice==='TBD'?'#D0D5DD':'transparent')+';padding:1px 2px" title="'+editHint+'">'+_rdEsc(vice)+'</span>'
       + '</div>';
    // 项目助理
    h += '<div style="width:70px;flex-shrink:0;padding:6px 4px;font-size:10px;border-right:1px solid #E5E7EB;display:flex;align-items:center">'
       + '<span '+(isOwner?'onclick="_rdEditStageField(\''+sb.id+'\',\'assistant\',\''+esc(asst)+'\')"':'')+' style="cursor:'+editCursor+';color:'+(asst==='TBD'?'#A8A29A':'#374151')+';border-bottom:1px dashed '+(asst==='TBD'?'#D0D5DD':'transparent')+';padding:1px 2px" title="'+editHint+'">'+_rdEsc(asst)+'</span>'
       + '</div>';
    // ★ V0.6.6l: 项目成员——只显示人数，点击切换下方"团队激励维护区"
    var memCount = _rdMembersCount(mems);
    var memLabel = memCount>0 ? (memCount+' 人') : 'TBD';
    var memColor = memCount>0 ? '#374151' : '#A8A29A';
    h += '<div style="width:100px;flex-shrink:0;padding:6px 4px;font-size:10px;border-right:1px solid #E5E7EB;display:flex;align-items:center;cursor:pointer" '
       + 'onclick="window._rdBonusPanelStage=\''+sb.id+'\';renderRdDetail();" '
       + 'title="点击切换到本阶段的团队激励维护区">'
       + '<span style="color:'+memColor+';border-bottom:1px dashed '+(memCount===0?'#D0D5DD':'transparent')+';padding:1px 2px">'+memLabel+'</span>'
       + '</div>';
    // 启动日期
    h += '<div style="width:80px;flex-shrink:0;padding:6px 4px;font-size:10px;border-right:1px solid #E5E7EB;display:flex;align-items:center">'
       + '<span '+(isOwner?'onclick="_rdEditStageField(\''+sb.id+'\',\'start_date\',\''+startDate+'\')"':'')+' style="cursor:'+editCursor+';color:'+(startDate==='TBD'?'#A8A29A':'#374151')+';border-bottom:1px dashed '+(startDate==='TBD'?'#D0D5DD':'transparent')+';padding:1px 2px" title="'+editHint+'">'+startDate+'</span>'
       + '</div>';
    // 完成截止
    h += '<div style="width:80px;flex-shrink:0;padding:6px 4px;font-size:10px;border-right:1px solid #E5E7EB;display:flex;align-items:center">'
       + '<span '+(isOwner?'onclick="_rdEditStageField(\''+sb.id+'\',\'end_date\',\''+endDate+'\')"':'')+' style="cursor:'+editCursor+';color:'+(endDate==='TBD'?'#A8A29A':'#374151')+';border-bottom:1px dashed '+(endDate==='TBD'?'#D0D5DD':'transparent')+';padding:1px 2px" title="'+editHint+'">'+endDate+'</span>'
       + '</div>';
    // 时间轴
    h += '<div style="flex:1;position:relative;height:'+(barH-8)+'px">';
    h += '<div style="position:absolute;left:'+offset+'px;top:6px;width:'+barW+'px;height:'+(barH-16)+'px;background:'+color+';border-radius:4px;opacity:'+(sb.status==='locked'?'0.3':'0.85')+'" title="'+_rdEsc(sb.name)+'"></div>';
    h += '</div>';
    h += '</div>';
  });

  // 今日线
  var todayOffset = (today - startD) / totalMs * chartW;
  if(todayOffset>=0 && todayOffset<=chartW){
    h += '<div style="position:relative;margin-top:4px">';
    // ★ V0.6.6k: 7 列偏移 (阶段80+OWN70+副70+助理70+成员100+启动80+完成80=550)
    h += '<div style="position:absolute;left:'+(550+todayOffset)+'px;top:-'+(stageBars.length*barH+8)+'px;width:1px;height:'+(stageBars.length*barH+16)+'px;background:#EF4444;z-index:2;pointer-events:none"></div>';
    h += '<div style="position:absolute;left:'+(550+todayOffset-12)+'px;top:-'+(stageBars.length*barH+16)+'px;font-size:9px;color:#EF4444;z-index:2;pointer-events:none">今天</div>';
    h += '</div>';
  }

  h += '</div></div>';
  h += '<div style="margin-top:8px;font-size:10px;color:#9CA3AF;display:flex;gap:12px">';
  h += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#059669;margin-right:3px"></span>已通过</span>';
  h += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3B82F6;margin-right:3px"></span>进行中</span>';
  h += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#9CA3AF;margin-right:3px"></span>未开始</span>';
  h += '<span style="color:#EF4444">| 红色竖线 = 今天</span>';
  h += '</div>';
  h += '</div>';
  // ★ V0.6.6n: 内嵌团队激励维护区（弹窗改内嵌面板）
  h += _rdRenderBonusPanel(c);
  return h;
}

// ★ V0.6.6n: 团队激励维护内嵌面板
function _rdRenderBonusPanel(c){
  var me = (typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||'';
  var p = c.project||{};
  var isOwner = p.owner === me || (typeof hasPermission==='function'&&hasPermission('maintenance'));
  // 当前选中的阶段
  if(typeof _rdBonusPanelStage==='undefined') window._rdBonusPanelStage = null;
  var selectedStage = c.stages.find(function(s){return s.id===_rdBonusPanelStage;}) || c.stages[0];
  if(selectedStage) _rdBonusPanelStage = selectedStage.id;

  var members = _rdParseMembers(selectedStage?selectedStage.members||'':'');
  var team = p.team||[];
  function findDept(n){ var m = team.find(function(t){return t.name===n;}); return m?(m.dept||''):''; }
  var bonusPool = (selectedStage&&selectedStage.bonus_pool) || p.bonus_pool || '';

  var h = '<div style="margin-top:20px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden">';
  // 面板标题栏
  h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:linear-gradient(135deg,#EFF6FF 0%,#F9FAFB 100%);border-bottom:1px solid #E5E7EB">';
  h += '<div style="display:flex;align-items:center;gap:10px">';
  h += '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1B6EC4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  h += '<span style="font-size:14px;font-weight:600;color:#1F2937">团队激励维护区</span>';
  // 阶段选择下拉
  h += '<select id="rd-bonus-stage-sel" style="padding:5px 10px;border:1px solid #BFDBFE;border-radius:6px;font-size:12px;background:#fff;color:#1B6EC4;font-weight:500;cursor:pointer">';
  c.stages.forEach(function(s){
    var stageNames = {preresearch:'预研',initiation:'立项',input:'设计输入',output:'设计输出',verification:'设计验证',validation:'设计确认',transfer:'设计转化'};
    var name = stageNames[s.stage_key]||s.stage_name;
    var count = _rdMembersCount(s.members);
    var sel = (s.id===_rdBonusPanelStage)?' selected':'';
    h += '<option value="'+s.id+'"'+sel+'>'+name+(count>0?'（'+count+'人）':'')+'</option>';
  });
  h += '</select>';
  h += '</div>';
  if(!isOwner){
    h += '<span style="font-size:11px;color:#A8A29A;background:#F3F4F6;padding:4px 10px;border-radius:12px">🔒 仅项目负责人可编辑</span>';
  }
  h += '</div>';

  if(!selectedStage){
    h += '<div style="padding:40px;text-align:center;color:#9CA3AF;font-size:12px">请先选择项目阶段</div>';
    h += '</div>';
    return h;
  }

  // 阶段名+奖金池+单位奖金
  var stageNames = {preresearch:'预研',initiation:'立项',input:'设计输入',output:'设计输出',verification:'设计验证',validation:'设计确认',transfer:'设计转化'};
  var stageName = stageNames[selectedStage.stage_key]||selectedStage.stage_name;
  h += '<div style="display:flex;align-items:center;gap:16px;padding:10px 16px;border-bottom:1px solid #F3F4F6;background:#FAFBFC;flex-wrap:wrap">';
  h += '<span style="font-size:12px;color:#6B7280">阶段：<strong style="color:#1F2937">'+stageName+'</strong></span>';
  h += '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:12px;color:#6B7280">总奖金池</span>';
  h += '<input type="number" id="rd-bonus-pool" value="'+bonusPool+'" placeholder="0" '+(!isOwner?'disabled':'')+' style="width:130px;padding:4px 8px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;text-align:right" step="1" min="0"></div>';
  h += '<span style="font-size:11px;color:#9CA3AF">元</span>';
  h += '<span style="margin-left:auto;font-size:12px;color:#6B7280">比例合计：<span id="rd-mem-sum" style="font-weight:600;color:#1B6EC4;font-size:13px">0</span>% <span id="rd-mem-warn" style="color:#DC2626;font-size:11px;display:none;margin-left:6px">⚠ 超过100%</span></span>';
  h += '<span style="font-size:12px;color:#6B7280">单位积分：<span id="rd-unit-bonus" style="font-weight:600;color:#059669;font-size:13px">—</span></span>';
  h += '</div>';

  // 成员表格
  h += '<div style="overflow-x:auto;max-width:100%">';
  h += '<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:1200px">';
  h += '<thead><tr style="background:#F9FAFB">';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:32px;color:#6B7280;font-size:11px">#</th>';
  h += '<th style="padding:8px 6px;border-bottom:1px solid #E5E7EB;text-align:left;color:#374151;font-size:11px;font-weight:600">姓名</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:70px;color:#6B7280;font-size:11px">部门</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:70px;color:#6B7280;font-size:11px">职责</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:90px;color:#6B7280;font-size:11px">交付效率</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:90px;color:#6B7280;font-size:11px">交付质量</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:100px;color:#6B7280;font-size:11px">综合评价</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:72px;color:#6B7280;font-size:11px">分配比%</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:90px;color:#6B7280;font-size:11px">预算基数</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:90px;color:#6B7280;font-size:11px">应发奖金</th>';
  h += '<th style="padding:8px 4px;border-bottom:1px solid #E5E7EB;width:44px;color:#6B7280;font-size:11px">操作</th>';
  h += '</tr></thead><tbody id="rd-mem-tbody">';

  function buildRow(idx, m){
    var eff = m.efficiency||'按时交付';
    var qual = m.quality||'0';
    var ovr = m.overall||'无法评估';
    var ratio = m.ratio||0;
    var h2 = '<tr data-idx="'+idx+'">';
    h2 += '<td style="padding:5px;border-bottom:1px solid #F3F4F6;text-align:center;color:#6B7280;font-size:11px">'+(idx+1)+'</td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-name" data-fld="name" value="'+esc(m.name||'')+'" '+(!isOwner?'disabled':'')+' placeholder="选择" style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box"></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-dept" data-fld="dept" value="'+esc(m.dept||findDept(m.name)||'')+'" '+(!isOwner?'disabled':'')+' style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box"></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-role" data-fld="role" value="'+esc(m.role||'组员')+'" '+(!isOwner?'disabled':'')+' style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box"></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><select class="rd-mem-eff" data-fld="efficiency" '+(!isOwner?'disabled':'')+' style="width:100%;padding:3px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box">';
    EFF_OPTIONS.forEach(function(e){ h2 += '<option value="'+e+'"'+(eff===e?' selected':'')+'>'+e+'</option>'; });
    h2 += '</select></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><select class="rd-mem-qual" data-fld="quality" '+(!isOwner?'disabled':'')+' style="width:100%;padding:3px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box">';
    QUAL_OPTIONS.forEach(function(q){ h2 += '<option value="'+q+'"'+(qual===q?' selected':'')+'>'+QUAL_LABEL[q]+'</option>'; });
    h2 += '</select></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><select class="rd-mem-ovr" data-fld="overall" '+(!isOwner?'disabled':'')+' style="width:100%;padding:3px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box">';
    OVERALL_OPTIONS.forEach(function(o){ h2 += '<option value="'+o+'"'+(ovr===o?' selected':'')+'>'+OVERALL_LABEL[o]+'</option>'; });
    h2 += '</select></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-ratio" data-fld="ratio" type="number" min="0" max="100" step="0.1" value="'+ratio+'" '+(!isOwner?'disabled':'')+' style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box;text-align:center"></td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6;text-align:right;color:#6B7280;font-size:11px;padding-right:10px" class="rd-mem-base">—</td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6;text-align:right;color:#1B6EC4;font-weight:600;font-size:11px;padding-right:10px" class="rd-mem-final">—</td>';
    h2 += '<td style="padding:4px;border-bottom:1px solid #F3F4F6;text-align:center"><button type="button" class="rd-mem-del" '+(!isOwner?'disabled':'')+' style="padding:2px 6px;border:1px solid #FCA5A5;border-radius:4px;background:#FEF2F2;color:#DC2626;cursor:pointer;font-size:10px'+(isOwner?'':'disabled')+'>×</button></td>';
    h2 += '</tr>';
    return h2;
  }
  if(!members.length) members = [{name:'',dept:'',role:'组员',ratio:0,efficiency:'按时交付',quality:'0',overall:'无法评估'}];
  members.forEach(function(m, i){ h += buildRow(i, m); });
  h += '</tbody></table></div>';

  // 底部工具栏
  h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#FAFBFC;border-top:1px solid #F3F4F6;flex-wrap:wrap;gap:8px">';
  if(isOwner){
    h += '<button type="button" id="rd-mem-add" style="padding:6px 14px;border:1px solid #D0D5DD;border-radius:6px;background:#fff;color:#374151;cursor:pointer;font-size:12px">+ 添加成员</button>';
    h += '<button type="button" id="rd-bonus-save" style="padding:6px 16px;border:1px solid #1B6EC4;border-radius:6px;background:#1B6EC4;color:#fff;cursor:pointer;font-size:12px;font-weight:500">💾 保存</button>';
  } else {
    h += '<span style="font-size:11px;color:#9CA3AF">提示：只有项目负责人可编辑本面板</span>';
  }
  h += '<span style="margin-left:auto;font-size:11px;color:#9CA3AF">提示：先选左侧甘特图阶段行/或使用上方下拉切换</span>';
  h += '</div>';

  h += '</div>';
  return h;
}

// ★ V0.6.6b: 五档颗粒度标签
function _rdGanttGranularityLabel(g){
  return {day:'按日',week:'按周',month:'按月',quarter:'按季',year:'按年'}[g]||g;
}

// ★ V0.6.6n: 绑定内嵌团队激励面板的所有交互（阶段切换/添加/删除/重算/保存）
function _rdBindBonusPanel(){
  var stageSel = document.getElementById('rd-bonus-stage-sel');
  if(stageSel){
    stageSel.addEventListener('change', function(){
      window._rdBonusPanelStage = stageSel.value;
      if(typeof renderRdDetail==='function') renderRdDetail();
    });
  }
  var poolInput = document.getElementById('rd-bonus-pool');
  if(poolInput){ poolInput.addEventListener('input', recalcPanel); }

  var tbody = document.getElementById('rd-mem-tbody');
  if(!tbody) return;

  function renumberRows(){
    tbody.querySelectorAll('tr').forEach(function(tr, i){
      tr.setAttribute('data-idx', i);
      var idxCell = tr.querySelector('td:first-child');
      if(idxCell) idxCell.textContent = i+1;
    });
  }
  function recalcPanel(){
    var rows = tbody.querySelectorAll('tr');
    var sum = 0;
    var all = [];
    rows.forEach(function(tr){
      var name = tr.querySelector('[data-fld="name"]')?.value||'';
      var ratio = parseFloat(tr.querySelector('[data-fld="ratio"]')?.value)||0;
      var efficiency = tr.querySelector('[data-fld="efficiency"]')?.value||'';
      var quality = tr.querySelector('[data-fld="quality"]')?.value||'0';
      var overall = tr.querySelector('[data-fld="overall"]')?.value||'';
      sum += ratio;
      all.push({name:name,ratio:ratio,efficiency:efficiency,quality:quality,overall:overall});
    });
    var pool = parseFloat(poolInput?.value)||0;
    var sumEl = document.getElementById('rd-mem-sum');
    var warnEl = document.getElementById('rd-mem-warn');
    if(sumEl) sumEl.textContent = sum.toFixed(1);
    if(warnEl) warnEl.style.display = sum > 100.01 ? 'inline' : 'none';
    var totalScore = 0;
    all.forEach(function(m){ if(m.name) totalScore += (EFF_SCORE[m.efficiency]||0)+(BONUS_SCORE[m.quality]||0)+(BONUS_SCORE[m.overall]||0); });
    var unit = totalScore>0 ? pool/totalScore : 0;
    var unitEl = document.getElementById('rd-unit-bonus');
    if(unitEl) unitEl.textContent = unit>0 ? (unit.toFixed(2)+' 元/分') : '—';
    rows.forEach(function(tr, i){
      var baseEl = tr.querySelector('.rd-mem-base');
      var finalEl = tr.querySelector('.rd-mem-final');
      if(i<all.length && all[i].name){
        var base = pool * (all[i].ratio/100);
        var score = (EFF_SCORE[all[i].efficiency]||0)+(BONUS_SCORE[all[i].quality]||0)+(BONUS_SCORE[all[i].overall]||0);
        var final = score * unit;
        if(baseEl) baseEl.textContent = base?base.toFixed(0):'—';
        if(finalEl) finalEl.textContent = final?final.toFixed(0):'—';
      }
    });
  }
  function bindRow(tr){
    tr.querySelectorAll('input,select').forEach(function(inp){
      inp.addEventListener('input', recalcPanel);
      inp.addEventListener('change', recalcPanel);
    });
    var nameInp = tr.querySelector('[data-fld="name"]');
    if(nameInp && typeof attachEmpNameAutocomplete==='function'){
      attachEmpNameAutocomplete(nameInp, {multi:false});
      nameInp.addEventListener('input', function(){
        var team = (_rdCurrent.project&&_rdCurrent.project.team)||[];
        var m = team.find(function(t){return t.name===nameInp.value.trim();});
        if(m&&m.dept) tr.querySelector('[data-fld="dept"]').value = m.dept;
      });
    }
    var del = tr.querySelector('.rd-mem-del');
    if(del) del.addEventListener('click', function(){
      tr.parentNode.removeChild(tr);
      renumberRows();
      recalcPanel();
    });
  }
  tbody.querySelectorAll('tr').forEach(bindRow);

  var addBtn = document.getElementById('rd-mem-add');
  if(addBtn){
    addBtn.addEventListener('click', function(){
      var tr = document.createElement('tr');
      tr.setAttribute('data-idx', tbody.querySelectorAll('tr').length);
      tr.innerHTML = '<td style="padding:5px;border-bottom:1px solid #F3F4F6;text-align:center;color:#6B7280;font-size:11px">'+(tbody.querySelectorAll('tr').length+1)+'</td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-name" data-fld="name" placeholder="选择" style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box"></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-dept" data-fld="dept" style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box"></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-role" data-fld="role" value="组员" style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box"></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><select class="rd-mem-eff" data-fld="efficiency" style="width:100%;padding:3px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box"><option value="按时交付" selected>按时交付</option><option value="延期交付">延期交付</option><option value="逾期未交付">逾期未交付</option></select></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><select class="rd-mem-qual" data-fld="quality" style="width:100%;padding:3px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box"><option value="+2">+2级 优于预期</option><option value="+1">+1级 略优于预期</option><option value="0" selected>0级 符合预期</option><option value="-1">-1级 有差距</option><option value="-2">-2级 严重差距</option></select></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><select class="rd-mem-ovr" data-fld="overall" style="width:100%;padding:3px 4px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;background:#fff;box-sizing:border-box"><option value="+2">+2级 优秀</option><option value="+1">+1级 良好</option><option value="0">0级 合格</option><option value="-1">-1级 基本合格</option><option value="-2">-2级 有较大差距</option><option value="无法评估" selected>无法评估</option></select></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6"><input class="rd-mem-ratio" data-fld="ratio" type="number" min="0" max="100" step="0.1" value="0" style="width:100%;padding:4px 6px;border:1px solid #D0D5DD;border-radius:4px;font-size:11px;box-sizing:border-box;text-align:center"></td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6;text-align:right;color:#6B7280;font-size:11px;padding-right:10px" class="rd-mem-base">—</td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6;text-align:right;color:#1B6EC4;font-weight:600;font-size:11px;padding-right:10px" class="rd-mem-final">—</td>'
        +'<td style="padding:4px;border-bottom:1px solid #F3F4F6;text-align:center"><button type="button" class="rd-mem-del" style="padding:2px 6px;border:1px solid #FCA5A5;border-radius:4px;background:#FEF2F2;color:#DC2626;cursor:pointer;font-size:10px">×</button></td>';
      tbody.appendChild(tr);
      bindRow(tr);
      recalcPanel();
    });
  }
  var saveBtn = document.getElementById('rd-bonus-save');
  if(saveBtn){
    saveBtn.addEventListener('click', function(){
      var rows = tbody.querySelectorAll('tr');
      var arr = [];
      var sum = 0;
      rows.forEach(function(tr){
        var name = tr.querySelector('[data-fld="name"]').value.trim();
        if(!name) return;
        sum += parseFloat(tr.querySelector('[data-fld="ratio"]').value)||0;
        arr.push({
          name:name,
          dept:tr.querySelector('[data-fld="dept"]').value.trim(),
          role:tr.querySelector('[data-fld="role"]').value.trim()||'组员',
          ratio:parseFloat(tr.querySelector('[data-fld="ratio"]').value)||0,
          efficiency:tr.querySelector('[data-fld="efficiency"]').value,
          quality:tr.querySelector('[data-fld="quality"]').value,
          overall:tr.querySelector('[data-fld="overall"]').value
        });
      });
      if(sum > 100.01){
        if(typeof _showAlert==='function') _showAlert('奖金分配比例总和为 '+sum.toFixed(1)+'%，超过 100%，请调整后保存。','比例超限');
        return;
      }
      var pool = parseFloat(poolInput?.value)||0;
      var stageId = (typeof _rdBonusPanelStage!=='undefined')?_rdBonusPanelStage:null;
      if(!stageId || !_rdCurrent) return;
      var stage = _rdCurrent.stages.find(function(s){return s.id===stageId;});
      if(!stage) return;
      var json = JSON.stringify(arr);
      try{
        if(typeof supabase!=='undefined' && typeof RD_STAGE_TABLE!=='undefined'){
          supabase.from(RD_STAGE_TABLE).update({members:json,bonus_pool:pool}).eq('id',stageId).then(function(){
            stage.members = json;
            stage.bonus_pool = pool;
            if(_rdCurrent.project) _rdCurrent.project.bonus_pool = pool;
            if(typeof showToast==='function') showToast('已保存');
          });
        } else {
          stage.members = json;
          stage.bonus_pool = pool;
          if(typeof showToast==='function') showToast('已保存');
        }
      }catch(e){ if(typeof showToast==='function') showToast('保存失败: '+e.message); }
    });
  }
  recalcPanel();
}

// ★ V0.6.6b: 阶段字段编辑（OWN/日期）
async function _rdEditStageField(stageId, field, currentVal){
  var labelMap = {owner:'负责人',vice_leader:'副组长',assistant:'项目助理',members:'项目成员',start_date:'启动日期',end_date:'完成截止日期'};
  var label = labelMap[field]||field;
  var inputType = (field==='owner'||field==='vice_leader'||field==='assistant'||field==='members')?'text':'date';
  var h = '<div style="margin-bottom:12px"><label style="font-size:12px;color:#6B7280;display:block;margin-bottom:4px">'+label+'</label>';
  h += '<input id="rdsf-in" type="'+inputType+'" value="'+(currentVal==='TBD'?'':currentVal)+'" placeholder="'+(field==='members'?'多个成员用逗号分隔':'')+'" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div>';
  var inputId = 'rdsf-in';
  var isNameField = (field==='owner'||field==='vice_leader'||field==='assistant'||field==='members');

  return new Promise(function(resolve){
    showFormModal(h, '编辑'+label+' / Edit '+label, '确定 / OK', '取消 / Cancel', function(close){
      var el = document.getElementById(inputId);
      var val = el?el.value.trim():'';
      if(!val){ close(); resolve(null); return; }
      close();
      resolve(val);
    });
    if(isNameField){
      setTimeout(function(){
        var el = document.getElementById(inputId);
        if(el && typeof attachEmpNameAutocomplete==='function'){
          var multi = (field==='members');
          attachEmpNameAutocomplete(el, {multi:multi});
          el.focus();
        }
      }, 80);
    }else{
      setTimeout(function(){ var el = document.getElementById(inputId); if(el) el.focus(); }, 80);
    }
  }).then(function(val){
    if(!val) return;
    var patch = {};
    patch[field] = val;
    try{
      supabase.from(RD_STAGE_TABLE).update(patch).eq('id',stageId).then(function(){
        if(_rdCurrent && _rdCurrent.stages){
          var s = _rdCurrent.stages.find(function(x){return x.id===stageId;});
          if(s){ s[field] = val; }
          renderRdDetail();
          showToast('已更新');
        }
      });
    }catch(e){ showToast('更新失败: '+e.message); }
  });
}

// ★ V0.6.6k: 项目负责人可编辑项目起止日期（其他成员只读）
async function _rdEditProjectDate(field){
  if(!_rdCurrent) return;
  var p = _rdCurrent.project;
  if(!p) return;
  var me = (typeof currentUser!=='undefined'&&currentUser&&currentUser.name)||'';
  if(p.owner !== me && !(typeof hasPermission==='function'&&hasPermission('maintenance'))){
    showToast('仅项目负责人可编辑项目起止日期');
    return;
  }
  var currentVal = p[field]||'';
  var label = field==='start_date'?'项目启动日期':'项目完成截止日期';
  var h = '<div style="margin-bottom:12px"><label style="font-size:12px;color:#6B7280;display:block;margin-bottom:4px">'+label+'</label>';
  h += '<input id="rdproj-in" type="date" value="'+currentVal+'" style="width:100%;padding:8px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:13px;box-sizing:border-box">';
  h += '</div>';
  showFormModal(h, '编辑'+label, '确定 / OK', '取消 / Cancel', function(close){
    var el = document.getElementById('rdproj-in');
    var val = el?el.value.trim():'';
    if(!val){ close(); return; }
    var patch = {};
    patch[field] = val;
    if(typeof SUPABASE_PROJECTS_TABLE!=='undefined'){
      supabase.from(SUPABASE_PROJECTS_TABLE).update(patch).eq('id',p.id).then(function(){
        p[field] = val;
        var all = loadAllProjects();
        var idx = all.findIndex(function(x){return x.id===p.id;});
        if(idx>=0){ all[idx][field]=val; saveAllProjects(all); }
        close();
        renderRdDetail();
        showToast('已更新');
      });
    }else{ close(); }
  });
  setTimeout(function(){ var el=document.getElementById('rdproj-in'); if(el) el.focus(); }, 80);
}

function renderRdPipeline(c){
  // ★ V0.6.5q: 阶段名称移到圆点上方，连接线简化，减少顶部留白
  var h = '<div style="display:flex;align-items:flex-start;gap:0;margin-bottom:16px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:10px 12px 14px;overflow-x:auto">';
  c.stages.forEach(function(s, i){
    var st = RD_STAGE_STATUS[s.status]||RD_STAGE_STATUS.locked;
    var isView = c.viewStageKey===s.stage_key;
    // ★ V0.6.5m: 成员阶段可见性过滤 — 未授权阶段显示锁定图标且不可点击
    var canSee = _rdCanSeeStage(c.project, s.stage_key);
    var clickable = canSee && s.status!=='locked';
    var icon = s.status==='passed'?'✓':(i+1);
    if(!canSee){
      // 未授权阶段：显示锁图标，灰化，不可点击
      h += '<div style="flex:1;min-width:82px;display:flex;flex-direction:column;align-items:center;position:relative;opacity:.35" title="您没有权限查看此阶段">';
      h += '<div style="font-size:11px;color:#9CA3AF;margin-bottom:6px">'+_rdEsc(s.stage_name)+'</div>';
      h += '<div style="position:relative;z-index:1;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:#E5E7EB;color:#9CA3AF;border:2px solid #E5E7EB">🔒</div>';
      h += '<div style="font-size:10px;color:#9CA3AF;margin-top:6px">未授权</div>';
      h += '</div>';
      return;
    }
    h += '<div style="flex:1;min-width:82px;display:flex;flex-direction:column;align-items:center;position:relative;'+(clickable?'cursor:pointer':'opacity:.55')+'" '
       + (clickable?('onclick="rdSwitchStage(\''+s.stage_key+'\')"'):'') + '>';
    // 阶段名称在上方
    h += '<div style="font-size:12px;font-weight:'+(isView?'600':'400')+';color:'+(isView?'#111827':'#6B7280')+';margin-bottom:6px">'+_rdEsc(s.stage_name)+'</div>';
    // 连接线（简化为细线）
    if(i>0){
      h += '<div style="position:absolute;top:36px;left:-50%;width:100%;height:1px;background:'+(s.status==='locked'?'#E5E7EB':'#3B82F6')+';z-index:0"></div>';
    }
    // 圆点
    h += '<div style="position:relative;z-index:1;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;'
       + 'background:'+(isView?st.color:(s.status==='passed'?'#059669':(s.status==='locked'?'#E5E7EB':st.bg)))
       + ';color:'+(isView?'#fff':(s.status==='passed'?'#fff':(s.status==='locked'?'#9CA3AF':st.color)))
       + ';border:2px solid '+(isView?st.color:(s.status==='passed'?'#059669':(s.status==='locked'?'#E5E7EB':st.color)))+'">'+icon+'</div>';
    // 状态标签在下方
    h += '<div style="font-size:10px;color:'+st.color+';margin-top:6px">'+st.label+'</div>';
    h += '</div>';
  });
  h += '</div>';
  return h;
}

function rdSwitchStage(key){
  if(!_rdCurrent) return;
  // ★ V0.6.5m: 成员阶段权限检查 — 未授权阶段不可切换
  if(!_rdCanSeeStage(_rdCurrent.project, key)){
    showToast('您没有权限查看此阶段信息');
    return;
  }
  _rdCurrent.viewStageKey = key;
  renderRdDetail();
}

function _rdStageDeliverables(c, stageId){
  return c.deliverables.filter(function(d){return d.stage_id===stageId;})
    .sort(function(a,b){return (a.order_index||0)-(b.order_index||0);});
}
function _rdStageGates(c, stageId){
  return c.gates.filter(function(g){return g.stage_id===stageId;})
    .sort(function(a,b){return (a.order_index||0)-(b.order_index||0);});
}

// 评审前置：gate 关联的交付物（按 iteration 或阶段关键项）
function _rdGateRequires(c, gate){
  var all = _rdStageDeliverables(c, gate.stage_id);
  if(gate.iteration){
    return all.filter(function(d){return d.iteration===gate.iteration && d.is_key;});
  }
  // 特定门的前置映射
  var REQ = {
    preresearch_review:['preresearch_report'],
    proposal_review:['proposal'],
    plan_review:['dev_plan','user_req','risk_plan'],
    proto_review:['proto_verify','proto_confirm'],
    premold_review:['design_record','proto_verify','proto_confirm','mold_10'],
    transfer_plan_review:['transfer_plan'],
    trial_prod_review_1:['material_purchase','trial_prod_1'],
    dmr_review_n:['pv_master_plan','pv_plan','pv_exec','pv_report'],
    output_review_dmr:['output_list_dmr'],
    output_review_tech:['output_list_tech','dfmea_output','pfmea_output'],
    dv_plan_review:['dv_master_plan','dv_plan'],
    dv_review:['dv_sample','type_test','dv_report','usability_test','usability_report','dfmea_dv','pfmea_dv'],
    dval_plan_review:['dval_plan'],
    dval_review:['dval_report','dfmea_dval','pfmea_dval']
  };
  var keys = REQ[gate.gate_key];
  if(keys) return all.filter(function(d){return keys.indexOf(d.item_key)>=0;});
  return all.filter(function(d){return d.is_key;});
}
function _rdReadyCount(reqs){
  var done = reqs.filter(function(d){return d.status==='submitted'||d.status==='approved'||d.status==='na';}).length;
  return {done:done, total:reqs.length, ready:reqs.length===0||done===reqs.length};
}

function renderRdStagePanel(c, stage, canReview){
  var st = RD_STAGE_STATUS[stage.status]||RD_STAGE_STATUS.locked;
  var dels = _rdStageDeliverables(c, stage.id);
  var gates = _rdStageGates(c, stage.id);

  var h = '<div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;margin-bottom:14px;overflow:hidden">';
  // Stage header
  h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #F3F4F6;background:'+st.bg+'">';
  h += '<div style="display:flex;align-items:center;gap:8px">';
  h += '<span style="font-weight:600;font-size:14px;color:#111827">'+_rdEsc(stage.stage_name)+'</span>';
  h += '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#fff;color:'+st.color+';border:1px solid '+st.color+'">'+st.label+'</span>';
  h += '</div>';
  if(stage.status==='active'||stage.status==='returned'){
    h += '<div style="font-size:11px;color:#6B7280">完成关键交付物后，可启动各项评审</div>';
  }
  h += '</div>';

  h += '<div style="display:flex;gap:0;align-items:flex-start">';
  // Left: deliverables
  h += '<div style="flex:1.4;padding:12px 16px;border-right:1px solid #F3F4F6;min-width:0">';
  h += '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:10px">交付物清单（'+dels.length+'）</div>';

  // 设计输出：按迭代分组展示
  var iterations = [];
  dels.forEach(function(d){ if(d.iteration && iterations.indexOf(d.iteration)<0) iterations.push(d.iteration); });
  var plain = dels.filter(function(d){return !d.iteration;});

  plain.forEach(function(d){ h += renderRdDeliverableRow(c, d); });
  iterations.forEach(function(it){
    var group = dels.filter(function(d){return d.iteration===it;});
    h += '<div style="margin:10px 0 6px;padding:6px 10px;background:#F9FAFB;border-radius:8px;border:1px dashed #D1D5DB">';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
    h += '<div style="font-size:11px;font-weight:600;color:#6B7280">DMR '+_rdEsc(it)+' 文件组（'+group.length+' 项）</div>';
    // ★ V0.6.4N: 误新增迭代可整组撤回（1.0 为模板初始组不可删；仅负责人；有进展则函数内拦截）
    if(it!=='1.0' && canReview){
      h += '<button onclick="rdDeleteIteration(\''+_rdEsc(it)+'\')" style="padding:2px 8px;border:1px solid #E7C4C0;border-radius:5px;background:#fff;color:#B3382C;font-size:10px;cursor:pointer">删除本迭代</button>';
    }
    h += '</div>';
    group.forEach(function(d){ h += renderRdDeliverableRow(c, d, true); });
    h += '</div>';
  });

  if(stage.stage_key==='output' && stage.status!=='locked'){
    h += '<button onclick="rdAddIteration()" style="margin-top:8px;padding:5px 12px;border:1px dashed #3B82F6;border-radius:6px;background:#EFF6FF;color:#3B82F6;font-size:11px;cursor:pointer">+ 新增试产迭代</button>';
  }
  h += '</div>';

  // Right: gates
  h += '<div style="flex:1;padding:12px 16px;min-width:0">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
  h += '<div style="font-size:12px;font-weight:600;color:#374151">评审入口（'+gates.filter(function(g){return !g.is_adhoc;}).length+'）</div>';
  if(stage.status!=='locked' && stage.status!=='passed'){
    h += '<button onclick="rdAddAdhocGate(\''+stage.id+'\')" style="padding:3px 8px;border:1px dashed #D97706;border-radius:6px;background:#FFFBEB;color:#D97706;font-size:10px;cursor:pointer">+ 发起临时评审</button>';
  }
  h += '</div>';
  h += '<div style="font-size:9px;color:#A8A29A;margin-bottom:10px;line-height:1.5">前置交付物全部就绪后，由评审人启动评审；临时评审用于过程中即时评估（如型检发现问题），不影响阶段推进。</div>';
  gates.forEach(function(g){ h += renderRdGateCard(c, g, canReview); });
  // 注册提交终点
  if(stage.stage_key==='transfer'){
    var mainGate = gates.find(function(g){return g.gate_key==='transfer_review';});
    if(mainGate && mainGate.result==='passed' && c.project.status!=='已完成'){
      h += '<button onclick="rdRegisterSubmit()" style="width:100%;margin-top:8px;padding:10px;border:0;border-radius:8px;background:#059669;color:#fff;font-size:13px;font-weight:600;cursor:pointer">注册提交（完成项目）</button>';
    }
  }
  h += '</div>';
  h += '</div></div>';
  return h;
}

function renderRdDeliverableRow(c, d, inGroup){
  var st = RD_DELIVER_STATUS[d.status]||RD_DELIVER_STATUS.pending;
  var h = '<div style="display:flex;align-items:center;gap:8px;padding:'+(inGroup?'5px 6px':'7px 8px')+';border-bottom:1px solid #F9FAFB;font-size:12px">';
  h += '<span style="flex-shrink:0;font-size:10px;padding:1px 7px;border-radius:9px;background:'+st.bg+';color:'+st.color+'">'+st.label+'</span>';
  h += '<span style="flex:1;min-width:0;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_rdEsc(d.note||d.name)+'">'+_rdEsc(d.name)
     + (d.version?(' <span style="color:#9CA3AF;font-size:10px">v'+_rdEsc(d.version)+'</span>'):'') + '</span>';
  if(d.file_url){
    h += '<a href="'+_rdEsc(d.file_url)+'" target="_blank" style="flex-shrink:0;font-size:11px;color:#3B82F6;text-decoration:none">链接</a>';
  }
  if(d.owner){ h += '<span style="flex-shrink:0;font-size:10px;color:#6B7280">'+_rdEsc(d.owner)+'</span>'; }
  if(d.status==='na' && d.na_reason){
    h += '<span style="flex-shrink:0;font-size:10px;color:#D97706" title="'+_rdEsc(d.na_reason+'（'+_rdEsc(d.na_by||'')+'）')+'">?</span>';
  }
  h += '<button onclick="rdEditDeliverable(\''+d.id+'\')" style="flex-shrink:0;padding:2px 8px;border:1px solid #E5E7EB;border-radius:5px;background:#fff;font-size:10px;color:#6B7280;cursor:pointer">编辑</button>';
  if(d.status!=='na'){
    h += '<button onclick="rdMarkNA(\''+d.id+'\')" style="flex-shrink:0;padding:2px 8px;border:1px solid #FDE68A;border-radius:5px;background:#FFFBEB;font-size:10px;color:#D97706;cursor:pointer">N/A</button>';
  }
  h += '</div>';
  return h;
}

function renderRdGateCard(c, g, canReview){
  var gr = RD_GATE_RESULT[g.result]||RD_GATE_RESULT.pending;
  var reqs = _rdGateRequires(c, g);
  var rc = _rdReadyCount(reqs);
  var naItems = reqs.filter(function(d){return d.status==='na';});
  var ownerName = c.project.owner||'';

  var h = '<div style="border:1px solid #E5E7EB;border-radius:10px;padding:12px 14px;margin-bottom:8px;'+(g.is_adhoc?'border-style:dashed;':'')+'">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  h += '<span style="font-size:13px;font-weight:600;color:#111827">'+_rdEsc(g.gate_name)+(g.is_adhoc?' <span style="font-size:10px;color:#D97706">临时</span>':'')+'</span>';
  h += '<span style="font-size:11px;padding:2px 10px;border-radius:10px;background:'+gr.bg+';color:'+gr.color+'">'+gr.label+'</span>';
  h += '</div>';
  if(g.result==='pending'){
    // ★ V0.6.4Q: 评审人规则透明化——谁有权启动评审一眼可见
    h += '<div style="font-size:11px;color:#9CA3AF;margin-bottom:6px">评审人：'+_rdEsc(ownerName||'项目负责人')+'</div>';
    if(!g.is_adhoc){
      h += '<div style="font-size:11px;color:#6B7280;margin-bottom:6px">前置交付物 '+rc.done+'/'+rc.total+' 就绪</div>';
    }
    if(naItems.length){
      h += '<div style="font-size:11px;color:#D97706;background:#FFFBEB;border-radius:5px;padding:5px 8px;margin-bottom:6px">含 '+naItems.length+' 项 N/A（评审时请复核）：'+naItems.map(function(d){return _rdEsc(d.name);}).join('、')+'</div>';
    }
    // ★ V0.6.4Q: 入口显性化——按钮始终可见，未就绪/无权限时禁用并说明原因
    if(rc.ready && canReview){
      h += '<button onclick="rdOpenReviewForm(\''+g.id+'\')" style="width:100%;padding:8px;border:0;border-radius:6px;background:#3B82F6;color:#fff;font-size:12px;font-weight:600;cursor:pointer">启动评审</button>';
    }else{
      h += '<button disabled style="width:100%;padding:8px;border:1px solid #E5E7EB;border-radius:6px;background:#F9FAFB;color:#B0B4BA;font-size:12px;cursor:not-allowed">启动评审</button>';
      h += '<div style="font-size:10px;color:#A8A29A;text-align:center;margin-top:5px">'
         + (!canReview ? '仅评审人（'+_rdEsc(ownerName)+'）可启动' : '前置交付物全部就绪后可启动')
         + '</div>';
    }
  }else{
    h += '<div style="font-size:11px;color:#6B7280">评审人：'+_rdEsc(g.reviewed_by||'—')+'　日期：'+_rdEsc(g.review_date||'—')+'</div>';
    if(g.conclusion){ h += '<div style="font-size:11px;color:#374151;margin-top:5px;background:#F9FAFB;border-radius:5px;padding:5px 8px">'+_rdEsc(g.conclusion)+'</div>'; }
    if(g.result==='conditional'){
      h += renderRdActionItems(c, g, canReview);
    }
    // ★ V0.6.4R: 查看记录（所有人）+ 撤回评审（仅评审人）
    h += '<div style="display:flex;gap:6px;margin-top:8px">';
    h += '<button onclick="rdViewGateRecord(\''+g.id+'\')" style="flex:1;padding:5px;border:1px solid #E5E7EB;border-radius:5px;background:#fff;color:#6B7280;font-size:11px;cursor:pointer">查看记录</button>';
    if(canReview){
      h += '<button onclick="rdRevokeGate(\''+g.id+'\')" style="flex:1;padding:5px;border:1px solid #E7C4C0;border-radius:5px;background:#fff;color:#B3382C;font-size:11px;cursor:pointer">撤回评审</button>';
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function renderRdActionItems(c, g, canReview){
  var items = Array.isArray(g.action_items)?g.action_items:[];
  var h = '<div style="margin-top:6px;border-top:1px dashed #F3F4F6;padding-top:6px">';
  h += '<div style="font-size:10px;font-weight:600;color:#EA580C;margin-bottom:4px">整改项（'+items.length+'）</div>';
  var allDone = true;
  items.forEach(function(it){
    var t = c.tasks.find(function(x){return String(x.id)===String(it.task_id);});
    var done = t && t.status==='已完成';
    if(!done) allDone = false;
    // ★ V0.6.4U: 整改项行内点击切换完成（研发详情页无任务看板，此处即完成入口）
    if(t && it.task_id){
      h += '<div onclick="_rdToggleRectifyTask(\''+it.task_id+'\')" title="点击切换完成状态" style="font-size:10px;color:'+(done?'#059669':'#374151')+';padding:3px 4px;border-radius:4px;cursor:pointer;user-select:none" onmouseover="this.style.background=\'#F3F4F6\'" onmouseout="this.style.background=\'\'">'
         + (done?'✓ ':'○ ')+_rdEsc(it.title)+'</div>';
    }else{
      h += '<div style="font-size:10px;color:#9CA3AF;padding:3px 4px">○ '+_rdEsc(it.title)+'</div>';
    }
  });
  if(items.length && allDone && canReview){
    h += '<button onclick="rdConfirmConditionalDone(\''+g.id+'\')" style="width:100%;margin-top:4px;padding:5px;border:0;border-radius:6px;background:#059669;color:#fff;font-size:10px;cursor:pointer">整改已全部完成，确认通过</button>';
  }else if(items.length && !allDone){
    h += '<div style="font-size:9px;color:#9CA3AF;margin-top:2px">点击整改项标记完成；全部完成后由评审人确认通过</div>';
  }
  h += '</div>';
  return h;
}

function renderRdHistory(c){
  var others = c.stages.filter(function(s){return s.stage_key!==c.viewStageKey;});
  // ★ V0.6.5m: 过滤未授权阶段
  others = others.filter(function(s){return _rdCanSeeStage(c.project, s.stage_key);});
  var h = '<div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:12px 16px">';
  h += '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px">其他阶段</div>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
  others.forEach(function(s){
    var st = RD_STAGE_STATUS[s.status]||RD_STAGE_STATUS.locked;
    var gates = c.gates.filter(function(g){return g.stage_id===s.id && !g.is_adhoc;});
    var passed = gates.filter(function(g){return g.result==='passed';}).length;
    h += '<div onclick="'+(s.status!=='locked'?('rdSwitchStage(\''+s.stage_key+'\')'):'')+'" style="padding:8px 12px;border:1px solid #E5E7EB;border-radius:8px;font-size:11px;'+(s.status==='locked'?'opacity:.55':'cursor:pointer')+'">';
    h += '<span style="font-weight:600;color:#111827">'+_rdEsc(s.stage_name)+'</span> ';
    h += '<span style="color:'+st.color+'">'+st.label+'</span>';
    h += '<span style="color:#9CA3AF;margin-left:6px">评审 '+passed+'/'+gates.length+'</span>';
    h += '</div>';
  });
  h += '</div></div>';
  return h;
}

// ===== Deliverable Ops =====
function rdEditDeliverable(did){
  if(!_rdCurrent) return;
  var d = _rdCurrent.deliverables.find(function(x){return x.id===did;});
  if(!d) return;
  var h = '';
  h += '<div style="margin-bottom:10px;font-size:13px;font-weight:600;color:#111827">'+_rdEsc(d.name)+'</div>';
  h += '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">状态</label>';
  h += '<select id="rd-d-status" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px">';
  ['pending','in_progress','submitted','approved'].forEach(function(s){
    h += '<option value="'+s+'"'+(d.status===s?' selected':'')+'>'+RD_DELIVER_STATUS[s].label+'</option>';
  });
  h += '</select></div>';
  h += '<div style="display:flex;gap:10px;margin-bottom:10px">';
  h += '<div style="flex:1"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">负责人</label>';
  h += '<input id="rd-d-owner" value="'+_rdEsc(d.owner||'')+'" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box"></div>';
  h += '<div style="flex:1"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">到期日</label>';
  h += '<input id="rd-d-due" type="date" value="'+_rdEsc(d.due_date||'')+'" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box"></div>';
  h += '</div>';
  h += '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">文件链接（NAS 路径）</label>';
  h += '<input id="rd-d-url" value="'+_rdEsc(d.file_url||'')+'" placeholder="\\\\NAS\\... 或 https://..." style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box"></div>';
  h += '<div><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">备注</label>';
  h += '<textarea id="rd-d-note" rows="2" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box;resize:vertical">'+_rdEsc(d.note||'')+'</textarea></div>';

  showFormModal(h, '编辑交付物', '保存', '取消', async function(close){
    var patch = {
      status: document.getElementById('rd-d-status').value,
      owner: document.getElementById('rd-d-owner').value.trim(),
      due_date: document.getElementById('rd-d-due').value||null,
      file_url: document.getElementById('rd-d-url').value.trim(),
      note: document.getElementById('rd-d-note').value.trim()
    };
    // 从 N/A 恢复正常状态时清空留痕？——保留留痕作为审计记录，仅改状态
    await _rdUpdate(RD_DELIVER_TABLE, did, patch);
    Object.assign(d, patch);
    saveRdCache(c_projectId(), {stages:_rdCurrent.stages, deliverables:_rdCurrent.deliverables, gates:_rdCurrent.gates});
    close();
    renderRdDetail();
  });
  // ★ V0.6.4S: 交付物负责人姓名联想（单值模式）
  _rdNameAutocomplete(document.getElementById('rd-d-owner'), false);
}
function c_projectId(){ return _rdCurrent?_rdCurrent.project.id:null; }

function rdMarkNA(did){
  if(!_rdCurrent) return;
  var d = _rdCurrent.deliverables.find(function(x){return x.id===did;});
  if(!d) return;
  var h = '';
  h += '<div style="margin-bottom:10px;font-size:13px;color:#111827">将「<b>'+_rdEsc(d.name)+'</b>」标记为不适用（N/A）</div>';
  h += '<div style="margin-bottom:10px;font-size:11px;color:#D97706;background:#FFFBEB;border-radius:6px;padding:8px">N/A 不阻塞评审申请，但会在评审界面高亮供复核；操作人与时间将留痕。</div>';
  h += '<label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">不适用理由 <span style="color:#EF4444">*</span></label>';
  h += '<textarea id="rd-na-reason" rows="3" placeholder="必填：说明此项为何不适用于本产品/项目" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box;resize:vertical"></textarea>';

  showFormModal(h, '标记不适用', '确认标记', '取消', async function(close){
    var reason = document.getElementById('rd-na-reason').value.trim();
    if(!reason){ _showAlert('请填写不适用理由'); return; }
    var patch = {status:'na', na_reason:reason, na_by:(currentUser&&currentUser.name)||'', na_at:new Date().toISOString()};
    await _rdUpdate(RD_DELIVER_TABLE, did, patch);
    Object.assign(d, patch);
    saveRdCache(c_projectId(), {stages:_rdCurrent.stages, deliverables:_rdCurrent.deliverables, gates:_rdCurrent.gates});
    close();
    renderRdDetail();
  });
}

// ===== Gate Review =====
function rdOpenReviewForm(gid){
  if(!_rdCurrent) return;
  var g = _rdCurrent.gates.find(function(x){return x.id===gid;});
  if(!g) return;
  if(!_rdCanReview(_rdCurrent.project)){ _showAlert('仅项目负责人可提交评审结论'); return; }
  var reqs = _rdGateRequires(_rdCurrent, g);
  var naItems = reqs.filter(function(d){return d.status==='na';});

  var h = '';
  h += '<div style="margin-bottom:10px;font-size:13px;font-weight:600;color:#111827">'+_rdEsc(g.gate_name)+'</div>';
  if(naItems.length){
    h += '<div style="margin-bottom:10px;font-size:11px;color:#D97706;background:#FFFBEB;border-radius:6px;padding:8px">请复核 '+naItems.length+' 项 N/A：'+naItems.map(function(d){return _rdEsc(d.name)+'（'+_rdEsc(d.na_reason||'')+'）';}).join('；')+'</div>';
  }
  h += '<div style="display:flex;gap:10px;margin-bottom:10px">';
  h += '<div style="flex:1"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">评审日期</label>';
  h += '<input id="rd-g-date" type="date" value="'+_rdToday()+'" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box"></div>';
  h += '<div style="flex:1"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">参会人（输入姓氏自动联想在职员工）</label>';
  h += '<div style="position:relative"><input id="rd-g-att" placeholder="如：谭晨航 尤亚君" autocomplete="off" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box"></div></div>';
  h += '</div>';
  h += '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">评审结论 <span style="color:#EF4444">*</span></label>';
  // ★ V0.6.4S: 语义化配色——通过=绿、有条件通过=黄、退回=红（选中态高亮，未选中灰）
  h += '<div style="display:flex;gap:8px" id="rd-g-result-wrap">';
  h += '<label data-v="passed" style="flex:1;padding:8px;border:1px solid #059669;border-radius:6px;font-size:12px;cursor:pointer;text-align:center;background:#ECFDF5;color:#059669;font-weight:600"><input type="radio" name="rd-g-result" value="passed" checked> 通过</label>';
  h += '<label data-v="conditional" style="flex:1;padding:8px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;cursor:pointer;text-align:center;background:#fff;color:#6B7280;font-weight:400"><input type="radio" name="rd-g-result" value="conditional"> 有条件通过</label>';
  h += '<label data-v="rejected" style="flex:1;padding:8px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;cursor:pointer;text-align:center;background:#fff;color:#6B7280;font-weight:400"><input type="radio" name="rd-g-result" value="rejected"> 退回</label>';
  h += '</div></div>';
  h += '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">评审意见</label>';
  h += '<textarea id="rd-g-concl" rows="3" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box;resize:vertical"></textarea></div>';
  h += '<div><label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">整改项（有条件通过时必填，每行一条）</label>';
  h += '<textarea id="rd-g-actions" rows="3" placeholder="例：补充 EMC 摸底测试数据&#10;修订 BOM 中供应商信息" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box;resize:vertical"></textarea>';
  h += '<div id="rd-g-err" style="display:none;color:#DC2626;font-size:11px;margin-top:4px"></div></div>';

  showFormModal(h, '提交评审结论', '提交', '取消', async function(close){
    var result = (document.querySelector('input[name="rd-g-result"]:checked')||{}).value||'passed';
    var actionsText = document.getElementById('rd-g-actions').value.trim();
    var actionLines = actionsText?actionsText.split('\n').map(function(s){return s.trim();}).filter(function(s){return s;}):[];
    if(result==='conditional' && !actionLines.length){
      // ★ V0.6.4S: 校验失败弹窗内联提示，不再叠 _showAlert 遮罩（叠加变暗事故的根治）
      var errEl = document.getElementById('rd-g-err');
      var taEl = document.getElementById('rd-g-actions');
      errEl.textContent = '⚠ 有条件通过必须填写至少一条整改项（每行一条）';
      errEl.style.display = 'block';
      taEl.style.borderColor = '#DC2626';
      taEl.focus();
      return;
    }

    var me = (currentUser&&currentUser.name)||'';
    var actionItems = [];
    // 整改项写入 project_tasks（★ V0.6.4R: 改用模块自治的 _rdCreateRectifyTask）
    if(result==='conditional'){
      for(var i=0;i<actionLines.length;i++){
        var title = '[整改·'+g.gate_name+'] '+actionLines[i];
        var t = await _rdCreateRectifyTask(c_projectId(), title);
        actionItems.push({title:actionLines[i], task_id: t?t.id:null});
      }
    }
    var patch = {
      result: result,
      review_date: document.getElementById('rd-g-date').value||_rdToday(),
      // ★ V0.6.4R: 参会人支持逗号/顿号/空格分隔
      attendees: document.getElementById('rd-g-att').value.split(/[,，、\s]+/).map(function(s){return s.trim();}).filter(function(s){return s;}),
      conclusion: document.getElementById('rd-g-concl').value.trim(),
      action_items: actionItems,
      reviewed_by: me
    };
    await _rdUpdate(RD_GATE_TABLE, gid, patch);
    Object.assign(g, patch);

    // 刷新任务缓存供整改状态检查（★ V0.6.4U: 模块自治 _rdSyncTasks）
    _rdCurrent.tasks = await _rdSyncTasks(c_projectId());

    await _rdEvaluateStage(g.stage_id);
    close();
    renderRdDetail();
  });
  // ★ V0.6.4R: 参会人姓名自动补全（在职员工联想下拉，多值模式）
  _rdNameAutocomplete(document.getElementById('rd-g-att'), true);
  // ★ V0.6.4S: 整改项输入时清除内联错误提示
  (function(){
    var taEl = document.getElementById('rd-g-actions');
    var errEl = document.getElementById('rd-g-err');
    if(taEl && errEl) taEl.addEventListener('input', function(){
      errEl.style.display='none'; taEl.style.borderColor='#D0D5DD';
    });
  })();
  // ★ V0.6.4S: 评审结论按钮选中态配色切换（绿/黄/红）
  (function(){
    var COLORS = {
      passed:{c:'#059669',bg:'#ECFDF5'},
      conditional:{c:'#D97706',bg:'#FFFBEB'},
      rejected:{c:'#DC2626',bg:'#FEF2F2'}
    };
    var wrap = document.getElementById('rd-g-result-wrap');
    if(!wrap) return;
    wrap.querySelectorAll('label[data-v]').forEach(function(lb){
      lb.addEventListener('click', function(){
        wrap.querySelectorAll('label[data-v]').forEach(function(x){
          x.style.borderColor='#D0D5DD'; x.style.background='#fff';
          x.style.color='#6B7280'; x.style.fontWeight='400';
        });
        var st = COLORS[lb.getAttribute('data-v')];
        if(st){
          lb.style.borderColor=st.c; lb.style.background=st.bg;
          lb.style.color=st.c; lb.style.fontWeight='600';
        }
      });
    });
  })();
}

// 阶段状态评估：所有正式门 passed→阶段通过并解锁下一阶段；rejected→退回；conditional→有条件
async function _rdEvaluateStage(stageId){
  var c = _rdCurrent;
  var stage = c.stages.find(function(s){return s.id===stageId;});
  if(!stage) return;
  var formal = c.gates.filter(function(g){return g.stage_id===stageId && !g.is_adhoc;});
  var today = _rdToday();
  var newStatus = null;
  if(formal.length && formal.every(function(g){return g.result==='passed';})){
    newStatus = 'passed';
  }else if(formal.some(function(g){return g.result==='rejected';})){
    newStatus = 'returned';
  }else if(formal.some(function(g){return g.result==='conditional';})){
    newStatus = 'conditional';
  }else{
    newStatus = 'active';
  }
  if(stage.status!==newStatus){
    var patch = {status:newStatus};
    if(newStatus==='passed') patch.actual_end = today;
    await _rdUpdate(RD_STAGE_TABLE, stageId, patch);
    Object.assign(stage, patch);

    if(newStatus==='passed'){
      var next = c.stages.find(function(s){return s.order_index===stage.order_index+1;});
      if(next && next.status==='locked'){
        var np = {status:'active', actual_start:today};
        await _rdUpdate(RD_STAGE_TABLE, next.id, np);
        Object.assign(next, np);
        c.viewStageKey = next.stage_key;
        showToast('「'+stage.stage_name+'」已通过，「'+next.stage_name+'」已解锁');
      }
    }
  }
  // 进度回写
  var prog = calcRdProgress(c.stages, c.deliverables);
  if(c.project.progress!==prog){
    c.project.progress = prog;
    if(typeof saveProject==='function') await saveProject(c.project);
  }
  saveRdCache(c_projectId(), {stages:c.stages, deliverables:c.deliverables, gates:c.gates});
}

// 有条件通过：整改全部完成 → 确认通过
async function rdConfirmConditionalDone(gid){
  var g = _rdCurrent.gates.find(function(x){return x.id===gid;});
  if(!g || !_rdCanReview(_rdCurrent.project)) return;
  var ok = await _showConfirm('确认该评审的所有整改项已完成，将本评审标记为「通过」？','确认');
  if(!ok) return;
  await _rdUpdate(RD_GATE_TABLE, gid, {result:'passed'});
  g.result = 'passed';
  await _rdEvaluateStage(g.stage_id);
  renderRdDetail();
}

// ===== Iteration (设计输出专属) =====
async function rdAddIteration(){
  var c = _rdCurrent;
  if(!c) return;
  var stage = c.stages.find(function(s){return s.stage_key==='output';});
  if(!stage) return;
  // 现有版本列表 → 下一版本
  var versions = [];
  c.deliverables.forEach(function(d){
    if(d.iteration && versions.indexOf(d.iteration)<0) versions.push(d.iteration);
  });
  versions.sort();
  var last = versions.length?versions[versions.length-1]:'1.0';
  var parts = last.split('.');
  var nextVer = parts[0]+'.'+(parseInt(parts[1]||'0')+1);
  var trialCount = c.gates.filter(function(g){return g.gate_key.indexOf('trial_prod_review_')===0;}).length;
  var ok = await _showConfirm('将新增试产迭代 '+nextVer+'：\n· 克隆 11 项 DMR 文件组（版本 '+nextVer+'）\n· 修模记录 + 试产工单\n· '+nextVer+' DMR评审 + 第'+_rdCnNum(trialCount+1)+'次试产评审','新增试产迭代');
  if(!ok) return;
  try{
    var dItems = rdBuildIterationItems(nextVer);
    var maxOrder = Math.max.apply(null, c.deliverables.map(function(d){return d.order_index||0;}).concat([0]));
    var dRows = dItems.map(function(d, i){
      return {project_id:c.project.id, stage_id:stage.id, item_key:d.item_key, name:d.name,
        is_key:d.is_key, note:d.note||'', status:'pending',
        version:d.version, iteration:d.iteration, order_index:maxOrder+1+i};
    });
    var newDels = await _rdInsert(RD_DELIVER_TABLE, dRows);
    c.deliverables = c.deliverables.concat(newDels);

    var gItems = rdBuildIterationGates(nextVer, trialCount+1);
    var gRows = gItems.map(function(g, i){
      return {project_id:c.project.id, stage_id:stage.id, gate_key:g.gate_key, gate_name:g.gate_name,
        is_adhoc:false, result:'pending', iteration:g.iteration, order_index:50+i};
    });
    var newGates = await _rdInsert(RD_GATE_TABLE, gRows);
    c.gates = c.gates.concat(newGates);

    saveRdCache(c.project.id, {stages:c.stages, deliverables:c.deliverables, gates:c.gates});
    showToast('试产迭代 '+nextVer+' 已创建');
    renderRdDetail();
  }catch(e){ _showAlert('新增迭代失败: '+e.message); }
}

// ★ V0.6.4N: 删除误新增的试产迭代（整组撤回）
// 安全约束：仅当该迭代全部交付物未开始、全部评审门无结果时允许整组删除
async function rdDeleteIteration(version){
  var c = _rdCurrent;
  if(!c || !version || version==='1.0') return;
  var stage = c.stages.find(function(s){return s.stage_key==='output';});
  if(!stage) return;
  var groupDels = c.deliverables.filter(function(d){return d.iteration===version;});
  var groupGates = c.gates.filter(function(g){return g.iteration===version;});
  if(!groupDels.length && !groupGates.length){ _showAlert('未找到迭代 '+version+' 的数据'); return; }
  var started = groupDels.filter(function(d){return d.status!=='pending';});
  var reviewed = groupGates.filter(function(g){return g.result!=='pending';});
  if(started.length || reviewed.length){
    _showAlert('迭代 '+version+' 已有交付进展或评审记录，不能整组删除。\n（'+started.length+' 项交付物已启动，'+reviewed.length+' 个评审已有结论）');
    return;
  }
  var ok = await _showConfirm('将删除试产迭代 '+version+' 的全部内容：\n· '+groupDels.length+' 项交付物（DMR 文件组/修模记录/试产工单）\n· '+groupGates.length+' 个评审\n\n此操作不可恢复。','删除迭代 '+version);
  if(!ok) return;
  try{
    var r1 = await supabase.from(RD_DELIVER_TABLE).delete().eq('project_id',c.project.id).eq('stage_id',stage.id).eq('iteration',version);
    if(r1.error) throw new Error(r1.error.message);
    var r2 = await supabase.from(RD_GATE_TABLE).delete().eq('project_id',c.project.id).eq('stage_id',stage.id).eq('iteration',version);
    if(r2.error) throw new Error(r2.error.message);
    c.deliverables = c.deliverables.filter(function(d){return d.iteration!==version;});
    c.gates = c.gates.filter(function(g){return g.iteration!==version;});
    saveRdCache(c.project.id, {stages:c.stages, deliverables:c.deliverables, gates:c.gates});
    showToast('迭代 '+version+' 已删除');
    renderRdDetail();
  }catch(e){ _showAlert('删除迭代失败: '+e.message); }
}

// ★ V0.6.4R: 撤回已提交的评审——清除结论/日期/参会人/意见，删除关联整改任务，阶段状态重估（仅评审人）
async function rdRevokeGate(gid){
  var c = _rdCurrent;
  if(!c) return;
  var g = c.gates.find(function(x){return x.id===gid;});
  if(!g || g.result==='pending') return;
  if(!_rdCanReview(c.project)){ _showAlert('仅评审人可撤回评审'); return; }
  var items = Array.isArray(g.action_items)?g.action_items:[];
  var resultLabel = ({passed:'通过',conditional:'有条件通过',rejected:'退回'})[g.result]||g.result;
  var msg = '撤回后将清除「'+g.gate_name+'」的评审结论（'+resultLabel+'），该评审恢复为待评审状态。';
  if(items.length) msg += '\n关联的 '+items.length+' 项整改任务将一并删除。';
  msg += '\n\n注意：本阶段状态将重新评估；已解锁的后续阶段保持现状，请自行确认。';
  var ok = await _showConfirm(msg, '撤回评审');
  if(!ok) return;
  try{
    for(var i=0;i<items.length;i++){
      if(items[i].task_id) await supabase.from(SUPABASE_TASK_TABLE).delete().eq('id',items[i].task_id);
    }
    var patch = {result:'pending', reviewed_by:null, review_date:null, attendees:null, conclusion:null, action_items:null};
    await _rdUpdate(RD_GATE_TABLE, gid, patch);
    Object.assign(g, patch);
    c.tasks = await _rdSyncTasks(c.project.id);
    await _rdEvaluateStage(g.stage_id);
    showToast('评审已撤回');
    renderRdDetail();
  }catch(e){ _showAlert('撤回失败: '+e.message); }
}

// ★ V0.6.4R: 查看评审记录——只读弹窗展示当时提交的全部信息
function rdViewGateRecord(gid){
  var c = _rdCurrent;
  if(!c) return;
  var g = c.gates.find(function(x){return x.id===gid;});
  if(!g || g.result==='pending') return;
  var gr = RD_GATE_RESULT[g.result]||RD_GATE_RESULT.pending;
  var atts = Array.isArray(g.attendees)?g.attendees:[];
  var items = Array.isArray(g.action_items)?g.action_items:[];

  function _row(label, valueHtml){
    return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #F3F4F6;font-size:12px">'
      +'<span style="flex-shrink:0;width:64px;color:#9CA3AF">'+label+'</span>'
      +'<span style="flex:1;color:#1F1F1F;line-height:1.6;word-break:break-word">'+valueHtml+'</span></div>';
  }
  var h = '';
  h += '<div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:8px">'+_rdEsc(g.gate_name)+(g.is_adhoc?' <span style="font-size:9px;color:#D97706">临时</span>':'')+'</div>';
  h += _row('评审结论', '<span style="font-weight:600;color:'+gr.color+'">'+gr.label+'</span>');
  h += _row('评审人', _rdEsc(g.reviewed_by||'—'));
  h += _row('评审日期', _rdEsc(g.review_date||'—'));
  h += _row('参会人', atts.length?atts.map(function(a){return _rdEsc(a);}).join('、'):'—');
  h += _row('评审意见', g.conclusion?_rdEsc(g.conclusion):'—');
  if(items.length){
    h += '<div style="margin-top:10px"><div style="font-size:11px;color:#9CA3AF;margin-bottom:4px">整改项（'+items.length+'）</div>';
    items.forEach(function(it, i){
      h += '<div style="font-size:12px;color:#374151;padding:3px 0;line-height:1.5">'+(i+1)+'. '+_rdEsc(it.title)+'</div>';
    });
    h += '</div>';
  }
  showFormModal(h, '评审记录', '关闭', null, function(close){ close(); });
}

// ===== Adhoc Gate (临时评审) =====
function rdAddAdhocGate(stageId){  var h = '';
  h += '<div style="margin-bottom:10px;font-size:11px;color:#D97706;background:#FFFBEB;border-radius:6px;padding:8px">临时评审用于型检过程中发现问题等需要立即评估的场景，不影响主流程的门控判定。</div>';
  h += '<label style="display:block;font-size:11px;color:#6B7280;margin-bottom:3px">评审名称 <span style="color:#EF4444">*</span></label>';
  h += '<input id="rd-adhoc-name" placeholder="例：型检问题临时评审-EMC辐射超标" style="width:100%;padding:7px 10px;border:1px solid #D0D5DD;border-radius:6px;font-size:12px;box-sizing:border-box">';
  showFormModal(h, '新增临时评审', '创建', '取消', async function(close){
    var name = document.getElementById('rd-adhoc-name').value.trim();
    if(!name){ _showAlert('请输入评审名称'); return; }
    try{
      var rows = await _rdInsert(RD_GATE_TABLE, [{
        project_id:c_projectId(), stage_id:stageId,
        gate_key:'adhoc_'+Date.now(), gate_name:name,
        is_adhoc:true, result:'pending', order_index:90
      }]);
      _rdCurrent.gates = _rdCurrent.gates.concat(rows);
      saveRdCache(c_projectId(), {stages:_rdCurrent.stages, deliverables:_rdCurrent.deliverables, gates:_rdCurrent.gates});
      close();
      renderRdDetail();
    }catch(e){ _showAlert('创建失败: '+e.message); }
  });
}

// ===== Register Submit (终点) =====
async function rdRegisterSubmit(){
  var c = _rdCurrent;
  if(!c || !_rdCanReview(c.project)) return;
  var ok = await _showConfirm('确认完成注册提交？项目将标记为「已完成」。','注册提交');
  if(!ok) return;
  c.project.status = '已完成';
  c.project.progress = 100;
  if(typeof saveProject==='function') await saveProject(c.project);
  showToast('项目已完成注册提交');
  renderRdDetail();
}

// ===== L1 Card Hook =====
// 研发项目卡片：7 段迷你阶段条（从缓存渲染，无缓存时触发预取）
function rdStageBarHtml(pid){
  var data = loadRdCache(pid);
  if(!data || !data.stages || !data.stages.length){
    // 异步预取，下次渲染时出现
    setTimeout(function(){ rdPrefetchStages([pid]); }, 0);
    return '';
  }
  var h = '<div style="display:flex;gap:2px;margin-top:8px" title="研发流程阶段">';
  data.stages.forEach(function(s){
    var color = s.status==='passed'?'#059669':(s.status==='locked'?'#E5E7EB':(s.status==='conditional'?'#EA580C':(s.status==='returned'?'#DC2626':'#3B82F6')));
    h += '<div style="flex:1;height:4px;border-radius:2px;background:'+color+'" title="'+_rdEsc(s.stage_name)+'：'+(RD_STAGE_STATUS[s.status]||{}).label+'"></div>';
  });
  h += '</div>';
  return h;
}

// 批量预取研发项目阶段（L1 列表用）
async function rdPrefetchStages(pids){
  var need = pids.filter(function(pid){
    var d = loadRdCache(pid);
    return !d || !d.stages;
  });
  for(var i=0;i<need.length;i++){
    await syncRdFromCloud(need[i]);
  }
  if(need.length && typeof renderPMList==='function' && document.getElementById('pmListView') && document.getElementById('pmListView').style.display!=='none'){
    renderPMList();
  }
}

// ===== 兼容旧骨架入口 =====
function initRdPm(container){
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:300px;color:#9CA3AF;font-size:14px">研发项目管理已并入「项目管理」模块 — 请选择或新建「研发」类型项目</div>';
}

console.log('[RDPM] Module loaded - V1.0 (Stage-Gate Engine P1)');

// ===== Global Exports =====
// ★ 关键：async 函数在块级作用域中不会提升到全局（Annex B 仅覆盖普通函数声明）。
// 跨模块调用（pm.js 分流/实例化/清理/预取）与 onclick 内联绑定都在全局作用域求值，
// 必须显式导出（与 pm.js 末尾的 window.* 导出同一约定）。
window.openRdProjectDetail = openRdProjectDetail;
window.instantiateRdProject = instantiateRdProject;
window.ensureRdProject = ensureRdProject;
window.rdCleanupProject = rdCleanupProject;
window.rdPrefetchStages = rdPrefetchStages;
window.rdStageBarHtml = rdStageBarHtml;
window.renderRdDetail = renderRdDetail;
window.rdSwitchStage = rdSwitchStage;
window._rdDetailTab = _rdDetailTab;
window._renderRdGantt = _renderRdGantt;
window.rdEditDeliverable = rdEditDeliverable;
window.rdMarkNA = rdMarkNA;
window.rdOpenReviewForm = rdOpenReviewForm;
window.rdConfirmConditionalDone = rdConfirmConditionalDone;
window.rdAddIteration = rdAddIteration;
window.rdDeleteIteration = rdDeleteIteration;
window.rdRevokeGate = rdRevokeGate;
window.rdViewGateRecord = rdViewGateRecord;
window._rdToggleRectifyTask = _rdToggleRectifyTask;
window.rdAddAdhocGate = rdAddAdhocGate;
window.rdRegisterSubmit = rdRegisterSubmit;
window.calcRdProgress = calcRdProgress;
window.syncRdFromCloud = syncRdFromCloud;
window.initRdPm = initRdPm;
// ★ V0.6.6k: 甘特图 3 个角色列+项目起止日期（仅项目负责人可编辑）
window._rdDetailTab = _rdDetailTab;
window._renderRdGantt = _renderRdGantt;
window._rdGanttGranularityLabel = _rdGanttGranularityLabel;
window._rdEditStageField = _rdEditStageField;
window._rdEditProjectDate = _rdEditProjectDate;
window._rdIsProjectOwner = _rdIsProjectOwner;
// ★ V0.6.6l: 项目组成员管理（表格+自动求和+100%校验）
window._rdOpenMembersModal = _rdOpenMembersModal;
window._rdParseMembers = _rdParseMembers;
window._rdMembersCount = _rdMembersCount;
// ★ V0.6.6n: 内嵌团队激励面板
window._rdRenderBonusPanel = _rdRenderBonusPanel;
window._rdBindBonusPanel = _rdBindBonusPanel;
}
