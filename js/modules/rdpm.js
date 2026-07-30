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
  return me && (project.owner===me || project.created_by===me);
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

// ===== Detail View Entry (pm.js openPMDetail 分流，DOM 切换由 pm.js 完成) =====
async function openRdProjectDetail(p){
  // ★ V0.6.5k: 成员名单门禁 — 非项目组成员不可查看研发项目详情
  if(typeof _pmCanAccessProject==='function' && !_pmCanAccessProject(p)){
    _showAlert('您不在项目成员名单中，无法查看本项目详情。<br><br>请联系项目负责人「'+esc(p.owner||'')+'」将您加入项目组。','权限提示',3000);
    return;
  }
  // ★ V0.6.4N: 写入 pmDetailContent（与通用详情页同容器），避免摧毁该节点导致通用详情页空白
  var detailEl = document.getElementById('pmDetailContent') || document.getElementById('pmDetailView');
  if(detailEl){
    detailEl.innerHTML = '<div style="text-align:center;padding:60px;color:#9CA3AF;font-size:13px">正在加载研发流程数据…</div>';
  }
  var data = await ensureRdProject(p.id);
  if(!data){ _showAlert('研发流程数据加载失败'); return; }
  var active = data.stages.find(function(s){return s.status!=='locked'&&s.status!=='passed';}) || data.stages[data.stages.length-1];
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

  // Pipeline bar
  h += renderRdPipeline(c);
  h += '</div>'; // /sticky 头部容器

  // Current stage panel
  var vs = c.stages.find(function(s){return s.stage_key===c.viewStageKey;});
  if(vs) h += renderRdStagePanel(c, vs, canReview);

  // History (other stages, collapsed)
  h += renderRdHistory(c);

  el.innerHTML = h;
}

function renderRdPipeline(c){
  var h = '<div style="display:flex;align-items:stretch;gap:0;margin-bottom:16px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:14px 12px;overflow-x:auto">';
  c.stages.forEach(function(s, i){
    var st = RD_STAGE_STATUS[s.status]||RD_STAGE_STATUS.locked;
    var isView = c.viewStageKey===s.stage_key;
    var clickable = s.status!=='locked';
    var icon = s.status==='passed'?'✓':(i+1);
    h += '<div style="flex:1;min-width:82px;display:flex;flex-direction:column;align-items:center;position:relative;'+(clickable?'cursor:pointer':'opacity:.55')+'" '
       + (clickable?('onclick="rdSwitchStage(\''+s.stage_key+'\')"'):'') + '>';
    if(i>0){
      h += '<div style="position:absolute;top:15px;left:-50%;width:100%;height:2px;background:'+(s.status==='locked'?'#E5E7EB':'#3B82F6')+';z-index:0"></div>';
    }
    h += '<div style="position:relative;z-index:1;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;'
       + 'background:'+(isView?st.color:(s.status==='passed'?'#059669':(s.status==='locked'?'#E5E7EB':st.bg)))
       + ';color:'+(isView?'#fff':(s.status==='passed'?'#fff':(s.status==='locked'?'#9CA3AF':st.color)))
       + ';border:2px solid '+(isView?st.color:(s.status==='passed'?'#059669':(s.status==='locked'?'#E5E7EB':st.color)))+'">'+icon+'</div>';
    h += '<div style="margin-top:6px;font-size:11px;font-weight:'+(isView?'600':'400')+';color:'+(isView?'#111827':'#6B7280')+'">'+_rdEsc(s.stage_name)+'</div>';
    h += '<div style="font-size:10px;color:'+st.color+'">'+st.label+'</div>';
    h += '</div>';
  });
  h += '</div>';
  return h;
}

function rdSwitchStage(key){
  if(!_rdCurrent) return;
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

  var h = '<div style="border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin-bottom:8px;'+(g.is_adhoc?'border-style:dashed;':'')+'">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
  h += '<span style="font-size:12px;font-weight:600;color:#111827">'+_rdEsc(g.gate_name)+(g.is_adhoc?' <span style="font-size:9px;color:#D97706">临时</span>':'')+'</span>';
  h += '<span style="font-size:10px;padding:1px 8px;border-radius:9px;background:'+gr.bg+';color:'+gr.color+'">'+gr.label+'</span>';
  h += '</div>';
  if(g.result==='pending'){
    // ★ V0.6.4Q: 评审人规则透明化——谁有权启动评审一眼可见
    h += '<div style="font-size:10px;color:#9CA3AF;margin-bottom:6px">评审人：'+_rdEsc(ownerName||'项目负责人')+'</div>';
    if(!g.is_adhoc){
      h += '<div style="font-size:10px;color:#6B7280;margin-bottom:6px">前置交付物 '+rc.done+'/'+rc.total+' 就绪</div>';
    }
    if(naItems.length){
      h += '<div style="font-size:10px;color:#D97706;background:#FFFBEB;border-radius:5px;padding:4px 6px;margin-bottom:6px">含 '+naItems.length+' 项 N/A（评审时请复核）：'+naItems.map(function(d){return _rdEsc(d.name);}).join('、')+'</div>';
    }
    // ★ V0.6.4Q: 入口显性化——按钮始终可见，未就绪/无权限时禁用并说明原因
    if(rc.ready && canReview){
      h += '<button onclick="rdOpenReviewForm(\''+g.id+'\')" style="width:100%;padding:7px;border:0;border-radius:6px;background:#3B82F6;color:#fff;font-size:11px;font-weight:600;cursor:pointer">启动评审</button>';
    }else{
      h += '<button disabled style="width:100%;padding:7px;border:1px solid #E5E7EB;border-radius:6px;background:#F9FAFB;color:#B0B4BA;font-size:11px;cursor:not-allowed">启动评审</button>';
      h += '<div style="font-size:9px;color:#A8A29A;text-align:center;margin-top:4px">'
         + (!canReview ? '仅评审人（'+_rdEsc(ownerName)+'）可启动' : '前置交付物全部就绪后可启动')
         + '</div>';
    }
  }else{
    h += '<div style="font-size:10px;color:#6B7280">评审人：'+_rdEsc(g.reviewed_by||'—')+'　日期：'+_rdEsc(g.review_date||'—')+'</div>';
    if(g.conclusion){ h += '<div style="font-size:10px;color:#374151;margin-top:4px;background:#F9FAFB;border-radius:5px;padding:4px 6px">'+_rdEsc(g.conclusion)+'</div>'; }
    if(g.result==='conditional'){
      h += renderRdActionItems(c, g, canReview);
    }
    // ★ V0.6.4R: 查看记录（所有人）+ 撤回评审（仅评审人）
    h += '<div style="display:flex;gap:6px;margin-top:8px">';
    h += '<button onclick="rdViewGateRecord(\''+g.id+'\')" style="flex:1;padding:4px;border:1px solid #E5E7EB;border-radius:5px;background:#fff;color:#6B7280;font-size:10px;cursor:pointer">查看记录</button>';
    if(canReview){
      h += '<button onclick="rdRevokeGate(\''+g.id+'\')" style="flex:1;padding:4px;border:1px solid #E7C4C0;border-radius:5px;background:#fff;color:#B3382C;font-size:10px;cursor:pointer">撤回评审</button>';
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
}
