// ===== HWM HR - MBO 模块 (Work Plan + 计分 + 协同 + Eisenhower Matrix) =====
// V0.5.75: 从 app.html 独立提取，首次模块拆分
// 
// 依赖（必须在此文件之前加载）：
//   config.js — APP_CONFIG, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_WP_TABLE
//   主程序 — showToast, _showAlert, _showConfirm, supabase, allEmployees, currentUser, USERS
//
// 导出（供后续模块调用）：
//   initWPModule(), renderWPTable(), getISOWeek(), getSubordinates(), _calcWeekScore()
//
// =============================================

// ==============================
// ★ V0.4.91: 中国法定节假日数据 & 工作日计算工具
// ==============================
var CN_HOLIDAYS={
  '2026':{
    holidays:[
      '2026-01-01','2026-01-02','2026-01-03',
      '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
      '2026-04-04','2026-04-05','2026-04-06',
      '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
      '2026-06-19','2026-06-20','2026-06-21',
      '2026-09-25','2026-09-26','2026-09-27',
      '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'
    ],
    workdays:['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']
  }
};
// 为每年建立 Set 加速查找
(function(){for(var y in CN_HOLIDAYS){CN_HOLIDAYS[y]._hSet=new Set(CN_HOLIDAYS[y].holidays);CN_HOLIDAYS[y]._wSet=new Set(CN_HOLIDAYS[y].workdays);}})();

function _isWorkday(dateStr){
  var d=new Date(dateStr+'T00:00:00');
  var day=d.getDay();
  var year=dateStr.slice(0,4);
  var hy=CN_HOLIDAYS[year];
  if(hy&&hy._wSet&&hy._wSet.has(dateStr))return true;
  if(hy&&hy._hSet&&hy._hSet.has(dateStr))return false;
  if(day===0||day===6)return false;
  return true;
}

function _getTodayStr(){
  var d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// ★ V0.6.1ct: 计算剩余办结天数
function _calcRemainingDays(plannedDate,actualDate){
  if(actualDate)return'<span style="color:#B0B8C1">0</span>'; // 已填写实际完成日期 → 0（浅灰）
  if(!plannedDate)return'';
  var today=_getTodayStr();
  var pd=new Date(plannedDate+'T00:00:00');
  var td=new Date(today+'T00:00:00');
  var diff=Math.floor((pd-td)/(1000*60*60*24));
  if(diff<0)return'<span style="color:#D64352;font-weight:600">已超'+Math.abs(diff)+'天</span>';
  if(diff===0)return'<span style="color:#FF9500;font-weight:600">今天截止</span>';
  return'<span style="color:#6D9D39">'+diff+'天</span>';
}

// ★ V0.4.91e: 计算任务耗时（工作日，排除周末+法定假日）
function _calcTaskDuration(task){
  if(!task||!task.startDate)return null;
  var endDate;
  if(task.status==='暂停中'&&task._pausedAt){
    // 暂停中：锁定为暂停时的工作日数
    endDate=task._pausedAt;
  }else if(task.actualDate){
    // 有实际完成日期：实际耗时
    endDate=task.actualDate;
  }else if(task.plannedDate){
    // 无实际完成日期：按"计划完成日期"显示预计耗时
    endDate=task.plannedDate;
  }else{
    return null;
  }
  // 使用工作日计数（排除周六、周日及法定节假日）
  var wd=_countWorkdays(task.startDate,endDate);
  return wd>=0?wd:0;
}

function _countWorkdays(fromDateExcl,toDateIncl){
  var cnt=0,d=new Date(fromDateExcl+'T00:00:00');
  while(true){
    d.setDate(d.getDate()+1);
    var ds=d.toISOString().slice(0,10);
    if(ds>toDateIncl)break;
    if(_isWorkday(ds))cnt++;
  }
  return cnt;
}

// ★ V0.4.91: 新积分映射表
var _TASK_SCORE_MAP={
  '重要紧急':{onTime:3,overdue:-1.5,notDone:-5},
  '重要不急':{onTime:2,overdue:-1,notDone:-4},
  '日常紧急':{onTime:1.5,overdue:-1,notDone:-3},
  '日常事项':{onTime:1,overdue:-0.5,notDone:-2}
};

// ==============================
// MBO模块 (Work Plan)
// ==============================
var _wpInited=false;
var _wpCurrent={year:null,month:null,week:null,plan:null};
var _wpData={};
var _wpViewingSubordinate=null;
var _wpViewingDeptMember=null;
var _wpViewingShared=null; // ★ V0.5.79b: 被分享查看的人
var _wpViewingMergedUrgent=false; // ★ V0.6.1df: 下属重急事项合并视图
var _wpViewingMergedIndirect=false; // ★ V0.6.1do: 间接下属标记
var _wpEditCell=null;
// 本地编辑保护：在云端确认写入前，后台加载/轮询不得用旧快照覆盖刚输入的内容。
var _wpDirtyPlanVersions={};
// 当前云端加载代次：管理员频繁切换本人/下属/授权视图时，旧请求返回不得覆盖后一次视图的数据。
var _wpLoadGeneration=0;
var _wpLastRenderKey='';
var _wpRevisionMode=false;
// ★ V0.6.1cd: 表头双击排序状态
var _wpSort=null; // {col:'priority'|'startDate'|'plannedDate'|'actualDate'|'status',dir:'asc'|'desc'|null}

// 下拉选项
var WP_GOAL_OPTIONS=['重要紧急','重要不急','日常紧急','日常事项'];
var WP_PRIORITY_ORDER={'重要紧急':1,'日常紧急':2,'重要不急':3,'日常事项':4};
var WP_GOAL_COLORS={'重要紧急':'#FF3B30','重要不急':'#007AFF','日常紧急':'#FF9500','日常事项':'#5E7080'};
var WP_STATUS_OPTIONS=['按时完成','进行中','逾期完成','暂停中','未做'];
var WP_STATUS_COLORS={'按时完成':'#92D050','进行中':'#289FB7','逾期完成':'#FFCF66','暂停中':'#9ca3af','未做':'#FF4B4B'};
var WP_PROBLEM_OPTIONS=['无','资源不足','跨部门协调','技术瓶颈','时间紧张','其他原因'];
var WP_NEEDBOSS_OPTIONS=['否','是'];

// ★ V0.6.1cd: 任务排序函数（显示层，不修改存储）
function sortWPTasks(tasks, col, dir){
  if(!dir||!col) return tasks;
  var sorted=tasks.slice();
  var asc=dir==='asc';
  if(col==='priority'){
    sorted.sort(function(a,b){ var va=WP_PRIORITY_ORDER[a.goal]||99, vb=WP_PRIORITY_ORDER[b.goal]||99; return asc?va-vb:vb-va; });
  }else if(col==='startDate'){
    sorted.sort(function(a,b){ var va=a.startDate||'9999-99-99', vb=b.startDate||'9999-99-99'; return asc?va.localeCompare(vb):vb.localeCompare(va); });
  }else if(col==='plannedDate'){
    sorted.sort(function(a,b){ var va=a.plannedDate||'9999-99-99', vb=b.plannedDate||'9999-99-99'; return asc?va.localeCompare(vb):vb.localeCompare(va); });
  }else if(col==='remainingDays'){
    // 剩余办结天数：按计划日期排序（同日期的按数值排）
    sorted.sort(function(a,b){ var va=a.plannedDate||'9999-99-99', vb=b.plannedDate||'9999-99-99'; return asc?va.localeCompare(vb):vb.localeCompare(va); });
  }else if(col==='actualDate'){
    sorted.sort(function(a,b){ var va=a.actualDate||'9999-99-99', vb=b.actualDate||'9999-99-99'; return asc?va.localeCompare(vb):vb.localeCompare(va); });
  }else if(col==='status'){
    sorted.sort(function(a,b){
      var aDone=(a.status==='✓完成'||a.status==='按时完成')?1:0;
      var bDone=(b.status==='✓完成'||b.status==='按时完成')?1:0;
      if(aDone!==bDone) return asc?aDone-bDone:bDone-aDone;
      var va=WP_PRIORITY_ORDER[a.goal]||99, vb=WP_PRIORITY_ORDER[b.goal]||99;
      return asc?va-vb:vb-va;
    });
  }
  return sorted;
}

// 双击表头切换排序
function toggleWPSort(col){
  if(!_wpSort)_wpSort={};
  if(_wpSort.col===col){
    // 同列：asc→desc→null
    if(_wpSort.dir==='asc') _wpSort.dir='desc';
    else if(_wpSort.dir==='desc') _wpSort.dir=null;
    else _wpSort.dir='asc';
  }else{
    _wpSort.col=col; _wpSort.dir='asc';
  }
  if(_wpCurrent&&_wpCurrent.plan) renderWPTable(_wpCurrent.plan);
  showToast(_wpSort.dir?'排序: '+(_wpSort.dir==='asc'?'↑ 升序':'↓ 降序'):'已恢复原始排序');
}

// 下属映射（动态从 USERS[uid].subordinates 读取，不再硬编码）

// 判断当前用户是否是指定员工（按姓名）的上级
function isBossOf(empName){
  if(!currentUser||!currentUser._uid)return false;
  var uid=currentUser._uid;
  var user=USERS[uid];
  if(!user||!user.subordinates)return false;
  for(var key in user.subordinates){
    var subUser=USERS[key];
    if(subUser&&subUser.name===empName)return true;
  }
  return false;
}

function getWPSubordinates(){
  if(!currentUser||!currentUser._uid)return[];
  return getSubordinates(currentUser._uid);
}

// 判断当前用户是否是指定员工(empName)的上级
function isMySubordinate(empName){
  if(!empName)return false;
  var subs=getWPSubordinates();
  return subs.indexOf(empName)!==-1;
}

// ★ V0.5.79b: 周计划可见性数据
var _wpVisibility={}; // { uid: { sharedTo: [name,...], sharedBy: { name: 'direct'|'peer', ... } } }
var _wpVisibilityKey=function(){return 'hwm_wp_visibility_'+(currentUser&&currentUser._uid||'');};

function loadWPVisibility(){
  try{
    var raw=localStorage.getItem(_wpVisibilityKey());
    _wpVisibility=raw?JSON.parse(raw):{};
  }catch(e){_wpVisibility={};}
}
function saveWPVisibility(){
  localStorage.setItem(_wpVisibilityKey(),JSON.stringify(_wpVisibility));
}
function _syncWPVisibility(){saveWPVisibility();}

// 判断某人授权我看他的周计划
function isSharedToMe(ownerName){
  if(!ownerName||!currentUser||!currentUser.name)return false;
  // 通过 USERS 找到 ownerName 对应的 uid
  var ownerUid=null;
  for(var uid in USERS){
    if(USERS[uid]&&USERS[uid].name===ownerName){ownerUid=uid;break;}
  }
  if(!ownerUid)return false;
  var key='hwm_wp_visibility_'+ownerUid;
  var raw=localStorage.getItem(key);
  if(!raw)return false;
  try{
    var v=JSON.parse(raw);
    return (v.sharedTo||[]).indexOf(currentUser.name)!==-1;
  }catch(e){return false;}
}

// 获取所有授权我看的人（用于下拉列表）
function getSharedToMeList(){
  if(!currentUser||!currentUser.name)return[];
  var result=[];
  for(var uid in USERS){
    var key='hwm_wp_visibility_'+uid;
    var raw=localStorage.getItem(key);
    if(!raw)continue;
    try{
      var v=JSON.parse(raw);
      if(v.sharedTo&&v.sharedTo.indexOf(currentUser.name)!==-1){
        result.push({name:USERS[uid].name, uid:uid});
      }
    }catch(e){}
  }
  return result;
}

function initWPModule(){
  try{
    // ★ j75: 每次进入模块均重置共享查看状态，防止上次浏览残留导致本周任务不持久化
    _wpViewingShared=null;
    _wpViewingDeptMember=null;
    _wpViewingSubordinate=null;
    _wpViewingMergedUrgent=false;
    _wpViewingMergedIndirect=false;
    // 确保 _wpCurrent 始终已初始化（防止跨会话状态丢失）
    if(!_wpCurrent)_wpCurrent={year:null,month:null,week:null,plan:null};
    // ★ 每次进入模块都重新加载当前用户的数据（修复切换用户后数据不刷新的bug）
    loadWPData();
    if(!_wpInited){
      _wpInited=true;
      _wpViewingSubordinate=null;
      _wpRevisionMode=false;
      var now=new Date();
      var yEl=document.getElementById('wpYear');
      var mEl=document.getElementById('wpMonth');
      if(yEl){yEl.value=now.getFullYear();syncYearLabel();}
      if(mEl){mEl.value=now.getMonth()+1;syncMonthLabel();}

      // ★ V0.1.19: 批量修复当前用户所有周计划的脏数据（name/dept/position不匹配）
      try{fixAllPlanDirtyData();}catch(e){console.warn('fixAllPlanDirtyData failed:',e);}
    }
    // 每次进入模块都刷新：信息栏 + 下属选择器 + 计划列表（各自独立容错）
    try{renderWPUserInfo();}catch(e){console.warn('renderWPUserInfo failed:',e);}
    try{renderWPSubSelect();}catch(e){console.warn('renderWPSubSelect failed:',e);}
    // ★ V0.5.79b: 加载可见性 + 分享下拉
    try{loadWPVisibility();renderWPSharedSelect();}catch(e){console.warn('renderWPSharedSelect failed:',e);}
    try{onWPMonthChange();}catch(e){console.warn('onWPMonthChange failed:',e);}
    // ★ V0.4.77: 员工本人进入MBO时自动导航到当前周（避免空白状态）
    if(_wpCurrent&&!_wpCurrent.plan&&!_wpViewingSubordinate&&!_wpViewingDeptMember){
      var _nowD=new Date();
      var _autoY=_nowD.getFullYear();
      var _autoM=_nowD.getMonth()+1;
      var _autoW=Math.min(4,Math.ceil(_nowD.getDate()/7));
      var _selY=yEl?parseInt(yEl.value):_autoY;
      var _selM=mEl?parseInt(mEl.value):_autoM;
      if(_selY===_autoY&&_selM===_autoM){
        setTimeout(function(){try{selectWP(_autoY,_autoM,_autoW);}catch(e){console.warn('auto-selectWP current week failed:',e);}},100);
      }
    }
    // 如果之前已选中周计划，重新渲染表格
    if(_wpCurrent&&_wpCurrent.plan){
      setTimeout(function(){ try{renderWPTable(_wpCurrent.plan);}catch(e){console.warn('renderWPTable failed:',e);} }, 50);
    }
  }catch(e){
    console.error('initWPModule error:',e);
    _showAlert('MBO模块初始化异常：'+e.message+'\n请尝试清除浏览器缓存后刷新页面。');
  }
}

function getWPLocalStorageKey(){
  var user=_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember||(currentUser&&currentUser.name)||getCurrentEmployee().name;
  // console.log('[DEBUG getWPLocalStorageKey] shared='+_wpViewingShared+' sub='+_wpViewingSubordinate+' dept='+_wpViewingDeptMember+' curUser='+(currentUser&&currentUser.name)+' → '+user);
  return 'hwm_workplans_'+user;
}

// ★ V0.6.1.j52: 周计划删除统一使用同一目标用户，避免“本地删了、云端仍在”
function _wpTargetUser(){
  return _wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember||(currentUser&&currentUser.name)||getCurrentEmployee().name;
}
function _wpIsForcedDeleted(user,weekId){
  var list=window.HWM_FORCED_DELETED_PLANS||[];
  for(var i=0;i<list.length;i++)if(list[i].username===user&&list[i].weekId===weekId)return true;
  return false;
}
function _wpBackupKeys(key){return ['__hwm_backup__'+key,key+'_backup'];}
function _wpRemoveBackups(key){
  var keys=_wpBackupKeys(key);
  for(var i=0;i<keys.length;i++){try{localStorage.removeItem(keys[i]);}catch(e){}}
}
function _wpCanForceDelete(){
  var u=(currentUser&&USERS&&USERS[currentUser.name])||{};
  return u.role==='admin'||u.role==='data_admin'||(currentUser&&(currentUser.role==='admin'||currentUser.role==='data_admin'));
}
async function _wpDeleteCloudPlan(user,weekId){
  if(typeof supabase==='undefined'||!supabase||!supabase.from)return {skipped:true};
  var resp=await supabase.from(SUPABASE_WP_TABLE).delete().eq('username',user).eq('week_id',weekId);
  if(resp.error)throw resp.error;
  return resp;
}

// 清除指定发起方在某周发出的全部协同请求。用于来源周计划删除，避免接收方保留孤儿协同任务。
async function _clearCollabTasksFromSource(fromUid,weekId){
  if(!fromUid||!weekId||typeof supabase==='undefined'||!supabase||!supabase.from)return 0;
  var resp=await supabase.from(SUPABASE_WP_TABLE).select('username,plan_data').eq('week_id',weekId);
  if(resp.error)throw resp.error;
  var cleaned=0;
  for(var i=0;i<(resp.data||[]).length;i++){
    var row=resp.data[i], receiverPlan=row.plan_data;
    if(!receiverPlan||!Array.isArray(receiverPlan.collab_tasks))continue;
    var before=receiverPlan.collab_tasks.length;
    receiverPlan.collab_tasks=receiverPlan.collab_tasks.filter(function(ct){
      return !(ct&&ct.collab_from_uid===fromUid);
    });
    if(receiverPlan.collab_tasks.length===before)continue;
    receiverPlan.updatedAt=new Date().toISOString();
    var saved=await supabase.from(SUPABASE_WP_TABLE).upsert([{username:row.username,week_id:weekId,plan_data:receiverPlan,updated_at:receiverPlan.updatedAt}],{onConflict:'username,week_id'});
    if(saved.error)throw saved.error;
    cleaned+=before-receiverPlan.collab_tasks.length;
  }
  return cleaned;
}

// ★ V0.1.19: 批量修复当前用户所有周计划的脏数据
// 修复场景：跨浏览器登录、UID迁移后 localStorage 中残留其他用户信息
function fixAllPlanDirtyData(){
  var correctName=_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember||(currentUser&&currentUser.name)||'';
  if(!correctName)return;
  var emp=getViewedUserEmp();
  var correctDept=emp?emp.dept:'';
  var correctPos=emp?emp.position:'';

  var fixed=0;
  var keys=[];
  for(var k in _wpData){if(_wpData.hasOwnProperty(k))keys.push(k);}
  for(var i=0;i<keys.length;i++){
    var plan=_wpData[keys[i]];
    if(!plan||!plan.name)continue;
    var dirty=false;
    if(plan.name!==correctName){plan.name=correctName;dirty=true;}
    if(correctDept&&plan.dept!==correctDept){plan.dept=correctDept;dirty=true;}
    if(correctPos&&plan.position!==correctPos){plan.position=correctPos;dirty=true;}
    if(dirty)fixed++;
  }
  if(fixed>0){
    try{localStorage.setItem(getWPLocalStorageKey(),JSON.stringify(_wpData));}catch(e){}
    console.log('[fixAllPlanDirtyData] 已修复 '+fixed+' 个周计划的脏数据 → '+correctName);
  }
}

// 协同响应状态由接收方回写云端，是独立于任务编辑时间的权威字段。
// 即使发起方本地计划的 updatedAt 更晚，也必须合并该字段，避免“已接受”长期停留在灰色待响应。
function _wpMergeCloudCollabStatuses(localPlan,cloudPlan){
  if(!localPlan||!cloudPlan||!cloudPlan._collab_statuses)return false;
  var cloudStatuses=cloudPlan._collab_statuses;
  var localStatuses=localPlan._collab_statuses||{};
  if(JSON.stringify(localStatuses)===JSON.stringify(cloudStatuses))return false;
  localPlan._collab_statuses=JSON.parse(JSON.stringify(cloudStatuses));
  return true;
}

function loadWPData(){
  // ★ V0.6.1.j74: 每次调用递增代次，异步回调只在代次匹配时生效
  var gen=++_wpLoadGeneration;
  // ① 先读 localStorage（秒出，不卡）
  try{_wpData=JSON.parse(localStorage.getItem(getWPLocalStorageKey())||'{}');}catch(e){_wpData={};}
  // ★ V0.6.1eh/j52: 备份恢复 — 仅恢复未被明确删除的周计划
  var wpKey=getWPLocalStorageKey();
  if(Object.keys(_wpData).length===0){
    var backup=localStorage.getItem(wpKey+'_backup');
    if(backup){
      try{
        var backupData=JSON.parse(backup);
        var deletedPrefix='hwm_wp_deleted_'+_wpTargetUser()+'_';
        Object.keys(backupData).forEach(function(wk){
          if(localStorage.getItem(deletedPrefix+wk)==='1')delete backupData[wk];
        });
        if(Object.keys(backupData).length>0){
          _wpData=backupData;localStorage.setItem(wpKey,JSON.stringify(backupData));
          console.warn('[WP] 从本地备份恢复了 '+Object.keys(backupData).length+' 周的数据');
          if(typeof showToast==='function')showToast('🔄 从本地备份恢复了周计划数据');
        }
      }catch(e){}
    }
  }
  // ★ j79 BUGFIX: tombstone 删除只在本地无内容时才执行
  // 旧代码无条件删除任何有 tombstone 的周，即使该周刚被用户输入了新内容
  // 这会导致：一旦某周被标记为"已删除"tombstone，后续所有操作都有名无实
  try{
    var deletedPrefix2='hwm_wp_deleted_'+_wpTargetUser()+'_';
    Object.keys(_wpData).forEach(function(wk){
      if(localStorage.getItem(deletedPrefix2+wk)==='1'||_wpIsForcedDeleted(_wpTargetUser(),wk)){
        // ★ j79: 只在本地没有任何内容时才允许 tombstone 生效
        var hasWork=!!(_wpData[wk]&&_wpData[wk].tasks&&_wpData[wk].tasks.some(function(t){return t.work&&t.work.trim();}));
        if(!hasWork){
          delete _wpData[wk];
        } else {
          // ★ 有内容的周不能死 — 清除错误的 tombstone
          try{localStorage.removeItem(deletedPrefix2+wk);}catch(e){}
          console.log('[J79 TOMBSTONE FIX] 清除 '+wk+' 的删除标记 — 该周有工作内容');
        }
      }
    });
    localStorage.setItem(wpKey,JSON.stringify(_wpData));
  }catch(e){}
  // ② 后台从 Supabase 拉取并合并（跨设备数据同步，失败不影响使用）
  // ★ j74: 冻结 user/key 在调用瞬间，防止异步回调时视图状态已变更
  var frozenUser=_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember||(currentUser&&currentUser.name)||getCurrentEmployee().name;
  if(!frozenUser||typeof frozenUser!=='string'||frozenUser.trim()===''){
    console.warn('HWM: loadWPData aborted - user is empty');
    return;
  }
  var frozenKey=getWPLocalStorageKey();
  (async function(){
    // ★ j74: 世代守卫 — 如果之后又触发了新的 loadWPData()，旧请求直接丢弃
    if(_wpLoadGeneration!==gen)return;
    try{
      var seenNewer=false;
      // 分页拉取所有记录（最多200条/人）
      var allRows=[], from=0, to=999, done=false;
      while(!done){
        var resp=await supabase.from(SUPABASE_WP_TABLE)
          .select('week_id,plan_data',{count:'exact'})
          .eq('username',frozenUser)
          .range(from,to);
        if(resp.error){console.warn('HWM: WP Supabase load failed',resp.error.message);return;}
        if(resp.data)allRows=allRows.concat(resp.data);
        if(!resp.data||resp.data.length<1000)done=true;
        else from+=1000;to+=1000;
      }
      // ★ j74: 世代再检查 — Supabase 网络请求期间可能触发了新加载
      if(_wpLoadGeneration!==gen)return;
      // ★ j74: 云端返回空 → 不主动清空本地数据（可能是网络/RLS/用户名差异等临时问题）
      // 原有 V0.3.117 逻辑过于激进：任何一次空返回都清空全部本地缓存，对人力资源负责人等高权限账号风险极大。
      if(allRows.length===0){
        console.log('[V0.6.1.j74] Cloud returned 0 rows for '+frozenUser+' — keeping local data intact');
        return;
      }
      // 合并：云端最新版本覆盖本地旧版本
      var localData=JSON.parse(localStorage.getItem(frozenKey)||'{}');
      for(var i=0;i<allRows.length;i++){
        var row=allRows[i];
        if(_wpIsForcedDeleted(frozenUser,row.week_id))continue;
        var cloudUpd=row.plan_data.updatedAt||'';
        var localUpd=(localData[row.week_id]&&localData[row.week_id].updatedAt)||'';
        // 本地输入已落盘、云端确认尚未返回时，绝不接受旧云端快照覆盖。
        if(_wpDirtyPlanVersions[row.week_id])continue;
        // ★ V0.6.1ge: 判断云端/本地是否有真实工作内容
        var cloudHasWork=!!(row.plan_data.tasks||[]).some(function(t){return t.work&&t.work.trim();});
        var localHasWork=!!(localData[row.week_id]&&(localData[row.week_id].tasks||[]).some(function(t){return t.work&&t.work.trim();}));
        // ★ V0.6.1ge: 云端空壳绝不能覆盖本地有内容的计划
        if(localHasWork&&!cloudHasWork){continue;}
        if(!localData[row.week_id]||cloudUpd>localUpd){
          localData[row.week_id]=row.plan_data;
          seenNewer=true;
        }else if(_wpMergeCloudCollabStatuses(localData[row.week_id],row.plan_data)){
          // 协同响应状态独立云端优先：不覆盖本地任务编辑，只刷新已接受/已拒绝徽章。
          seenNewer=true;
        }
      }
      // ★ j74: 世代再检查 — 合并完成后再次验证
      if(_wpLoadGeneration!==gen)return;
      // ★ j77 关键修复：云端已删除的周计划 → 本地同步删除（但有内容/有更新的本地数据绝不删除）
      // 旧版本会无脑删除所有不在云端的本地 week，导致用户刚输入的"测试测试"被云端空 W4 覆盖后丢失。
      // 新版本：先保留所有 localData 中的 week（无论云端有没有），最后再选择性删除那些：
      //   1. localStorage tombstone 标记存在（明确删除意图）
      //   2. 云端存在但 localHasWork=false 且 cloudHasWork=false（双方都空）
      //   3. 云端不存在但 localHasWork=false 且不在最近的 tombstone 备份中
      var cloudIds={};
      for(var i=0;i<allRows.length;i++){
        if(!_wpIsForcedDeleted(frozenUser,allRows[i].week_id))cloudIds[allRows[i].week_id]=true;
      }
      for(var wk in localData){
        if(!cloudIds[wk]){
          // ★ j77: 仅在本地也明确无内容时删除（防止"刚保存的周计划被云端未同步删了"）
          var wkHasContent=!!(localData[wk].tasks||[]).some(function(t){return t.work&&t.work&&t.work.trim();});
          if(!wkHasContent){
            // 进一步确认：如果是真正的空壳且有 tombstone 才删
            delete localData[wk];seenNewer=true;
            try{localStorage.setItem('hwm_wp_deleted_'+frozenUser+'_'+wk,'1');}catch(e){}
            console.log('[V0.6.1.j77] Removed stale empty cache for',wk);
          } else {
            // ★ j77: 关键保护 — 本地有内容但云端不存在，**不要删除**！等用户后续 save 推上去。
            console.log('[V0.6.1.j77] KEPT local plan with work: '+wk+' (cloud missing)');
          }
        }
      }
      // ★ j77: 第二层防护 — 即使合并时被 cloud 覆盖，也要避免丢失本地 work
      // 重新检查：cloudUpd 严格 > localUpd 才覆盖；相等时优先保留 local（防止时钟偏移导致数据回退）
      try{
        for(var i=0;i<allRows.length;i++){
          var row=allRows[i];
          if(_wpIsForcedDeleted(frozenUser,row.week_id))continue;
          var ld=localData[row.week_id];
          if(!ld)continue;
          var localHasContent=!!(ld.tasks||[]).some(function(t){return t.work&&t.work&&t.work.trim();});
          var cloudHasContent=!!(row.plan_data.tasks||[]).some(function(t){return t.work&&t.work&&t.work.trim();});
          // 如果本地有 work 而云端没有，绝对不覆盖
          if(localHasContent && !cloudHasContent){
            // 已经是 continue 状态，无需操作
            continue;
          }
          // 如果双方都有 work，且 cloudUpd 不严格大于 localUpd，不覆盖
          if(localHasContent && cloudHasContent){
            var cu=row.plan_data.updatedAt||'';
            var lu=ld.updatedAt||'';
            if(cu<=lu){
              // 保留本地
              console.log('[V0.6.1.j77] cloud not newer, keeping local for',row.week_id);
            }
          }
        }
      }catch(e){console.warn('[V0.6.1.j77] second-pass protection error',e.message);}
      // ★ V0.6.1.gi/j52: 多重备份自动恢复，但尊重明确删除标记
      try{
        for(var wk in localData){
          var hasContent=!!(localData[wk].tasks||[]).some(function(t){return t.work&&t.work&&t.work.trim();});
          if(!hasContent && localStorage.getItem('hwm_wp_deleted_'+_wpTargetUser()+'_'+wk)!=='1'){
            var bkKey=frozenKey+'_backup';
            var bkRaw=localStorage.getItem(bkKey)||localStorage.getItem('__hwm_backup__'+frozenKey);
            if(bkRaw){
              try{
                var bkData=JSON.parse(bkRaw);
                if(bkData[wk]&&(bkData[wk].tasks||[]).some(function(t){return t.work&&t.work&&t.work.trim();})){
                  localData[wk]=bkData[wk];
                  console.log('[V0.6.1.gi] 备份恢复：'+wk);
                  seenNewer=true;
                }
              }catch(e){}
            }
          }
        }
      }catch(e){console.warn('[V0.6.1.gi] 备份恢复失败',e.message);}
      // ★ j77: 第三层防护 — 如果 _wpCurrent.plan 引用了某个被合并覆盖的 plan，重新指向
      if(getWPLocalStorageKey()===frozenKey){
        // 检查 _wpCurrent.plan 是否仍然在合并后的 localData 中
        if(_wpCurrent && _wpCurrent.plan && _wpCurrent.year){
          var curId=makeWPId(_wpCurrent.year,_wpCurrent.month||(new Date().getMonth()+1),_wpCurrent.week);
          if(localData[curId] && localData[curId]!==_wpCurrent.plan){
            // 合并后数据与 _wpCurrent.plan 不一致 — 优先用合并后的（包含 latest cloud 状态）
            _wpCurrent.plan=localData[curId];
          }
        }
        _wpData=localData;
        try{if(_wpCurrent&&_wpCurrent.plan){
          var refreshed=getWP(_wpCurrent.year,_wpCurrent.month,_wpCurrent.week);
          if(refreshed)_wpCurrent.plan=refreshed;
          renderWPTable(_wpCurrent.plan);
        }}catch(e){}
        try{var y=_wpCurrent.year||new Date().getFullYear();var m=_wpCurrent.month||(new Date().getMonth()+1);renderWPPlanList(y,m);}catch(e){}
        try{renderWPUserInfo();}catch(e){}
      }
    }catch(e){console.warn('HWM: WP Supabase sync error (non-critical)',e.message);}
  })();

  // ★ V0.6.1.kb: 周计划页打开时启动云端轮询 — 解决发起方看不到接收方实时响应的问题
  if(typeof _wpPollTimer==='undefined'||!_wpPollTimer){
    _wpPollTimer=setInterval(function(){
      if(typeof supabase==='undefined'||!supabase)return;
      var curKey=getWPLocalStorageKey();
      var user=curKey.replace(/^hwm_workplans_/,'');
      if(!user)return;
      (async function(){
        try{
          var resp=await supabase.from(SUPABASE_WP_TABLE)
            .select('week_id,plan_data')
            .eq('username',user);
          if(resp.error||!resp.data||resp.data.length===0)return;
          var currentKey=getWPLocalStorageKey();
          var localData=JSON.parse(localStorage.getItem(currentKey)||'{}');
          var seenNewer=false;
          for(var i=0;i<resp.data.length;i++){
            var row=resp.data[i];
            if(_wpIsForcedDeleted(user,row.week_id))continue;
            var cloudUpd=row.plan_data.updatedAt||'';
            var localUpd=(localData[row.week_id]&&localData[row.week_id].updatedAt)||'';
            // 输入后到云端确认前不允许轮询覆盖本地最新编辑。
            if(_wpDirtyPlanVersions[row.week_id])continue;
            var cloudHasWork=!!(row.plan_data.tasks||[]).some(function(t){return t.work&&t.work.trim();});
            var localHasWork=!!(localData[row.week_id]&&(localData[row.week_id].tasks||[]).some(function(t){return t.work&&t.work.trim();}));
            if(localHasWork&&!cloudHasWork)continue;
            if(!localData[row.week_id]||cloudUpd>localUpd){
              localData[row.week_id]=row.plan_data;
              seenNewer=true;
            }else if(_wpMergeCloudCollabStatuses(localData[row.week_id],row.plan_data)){
              // 接收方响应只影响协同状态，强制以云端为准，不覆盖发起方尚未保存的任务编辑。
              seenNewer=true;
            }
          }
          if(seenNewer){
            localStorage.setItem(currentKey,JSON.stringify(localData));
            if(getWPLocalStorageKey()===currentKey){
              _wpData=localData;
              try{if(_wpCurrent&&_wpCurrent.plan){
                var refreshed=getWP(_wpCurrent.year,_wpCurrent.month,_wpCurrent.week);
                if(refreshed)_wpCurrent.plan=refreshed;
                renderWPTable(_wpCurrent.plan);
                showToast('🔄 周计划已从云端同步最新状态');
              }}catch(e){}
            }
          }
        }catch(e){/* 静默,不影响用户使用 */}
      })();
    },30000);
    console.log('[WP Poll] 启动 30s 周期云端轮询');
  }
}

var _wpCloudSaveQueue=Promise.resolve();

function saveWPData(onlyWeekId){
  // ★ j78: onlyWeekId — 只保存指定的周计划到云端，不再批量保存全部100+条。
  // 这消除了"保存时间窗口内 _wpData 被异步加载覆盖"的竞态条件。
  // 例外：commitEditCell / saveWPAndGoHome 等关键路径不传 onlyWeekId 时会兜底全量保存

  // ★ j74: 如果当前正在查看分享视图，拒绝保存
  if(_wpViewingShared){console.log('[DEBUG saveWPData] SKIPPED - _wpViewingShared='+_wpViewingShared);return _wpCloudSaveQueue;}
  var key=getWPLocalStorageKey();
  console.log('[DEBUG saveWPData] key='+key+' dataKeys='+Object.keys(_wpData).length+' onlyWeekId='+(onlyWeekId||'(all)'));
  // ★ V0.6.1eh: 保存前先备份 — 防止数据丢失
  var oldData=localStorage.getItem(key);
  if(oldData){
    // ★ V0.6.1.ia: 备份 key 用 `__hwm_backup_` 前缀，避免被当作用户名
    try{localStorage.setItem('__hwm_backup__'+key,oldData);}catch(e){}
  }
  localStorage.setItem(key,JSON.stringify(_wpData));
  // ★ j80: 保存成功后清除对应周的删除标记（防止之前错误设置的 tombstone 导致下次加载时删除）
  try{
    for(var wpId in _wpData){
      var delKey='hwm_wp_deleted_'+_wpTargetUser()+'_'+wpId;
      if(localStorage.getItem(delKey)==='1'){
        var hasWork=_wpData[wpId]&&_wpData[wpId].tasks&&_wpData[wpId].tasks.some(function(t){return t.work&&t.work.trim();});
        if(hasWork){localStorage.removeItem(delKey);console.log('[J80] 清除无效 tombstone: '+delKey);}
      }
    }
  }catch(e){}
  // 异步推送到 Supabase（静默，失败不影响使用）
  // 检查 supabase 客户端是否已初始化
  if(typeof supabase==='undefined'||!supabase||!supabase.from){
    console.warn('HWM: WP Supabase not ready, skip cloud push');
    return _wpCloudSaveQueue;
  }
  // ★ j74: 冻结云端写入用户名在调用瞬间，而非在异步回调中重新读取全局状态
  // 人力资源负责人经常切换下属视图，全局状态可能在异步执行前被 switchToMyWP() 清空
  var frozenUser=_wpViewingSubordinate||_wpViewingDeptMember||(currentUser&&currentUser.name)||getCurrentEmployee().name;
  // 防御：user 为空时绝不能保存
  if(!frozenUser||typeof frozenUser!=='string'||frozenUser.trim()===''){
    console.warn('HWM: saveWPData aborted - user is empty');
    return _wpCloudSaveQueue;
  }
  // ★ j74: 同时冻结当前计划引用 — 异步回调中的 _wpCurrent 可能已被 switchToMyWP() 置空
  var frozenCurrent=_wpCurrent&&_wpCurrent.plan&&_wpCurrent.year?{year:_wpCurrent.year,month:_wpCurrent.month||(new Date().getMonth()+1),week:_wpCurrent.week||1,plan:_wpCurrent.plan}:null;
  // ★ j78: 只深拷贝需要保存的周计划，而不是全部 _wpData
  var plans={};
  if(onlyWeekId && _wpData[onlyWeekId]){
    plans[onlyWeekId]=JSON.parse(JSON.stringify(_wpData[onlyWeekId]));
  } else if(!onlyWeekId){
    // 兜底全量保存（来自 commitEditCell / submitWPPlan 等路径）
    plans=JSON.parse(JSON.stringify(_wpData));
  }
  var dirtyVersions={};
  for(var dirtyId in plans)dirtyVersions[dirtyId]=_wpDirtyPlanVersions[dirtyId]||plans[dirtyId].updatedAt||'';
  _wpCloudSaveQueue=_wpCloudSaveQueue.catch(function(){}).then(async function(){
    try{
      // 使用 upsert 模式：只更新/插入当前保存的周计划，不影响其他周计划
      // 这样即使本地缓存不完整，也不会误删云端其他周的数据
      var rows=[], now=new Date().toISOString();
      for(var wpId in plans){
        rows.push({username:frozenUser,week_id:wpId,plan_data:plans[wpId],updated_at:now});
      }
      var cloudSaveSucceeded=true;
      if(rows.length>0){
        var batchSize=50;
        for(var i=0;i<rows.length;i+=batchSize){
          var batch=rows.slice(i,i+batchSize);
          var r=await supabase.from(SUPABASE_WP_TABLE)
            .upsert(batch,{onConflict:'username,week_id'});
          if(r.error){
            cloudSaveSucceeded=false;
            console.error('HWM: WP Supabase upsert batch',i,'failed',r.error.message);
            showToast('⚠️ 周计划云端同步失败: '+r.error.message);
          }
        }
      }
      console.log('HWM: WP pushed to cloud,',rows.length,'plans for',frozenUser);
      // 仅在云端成功确认且版本未变化时清除保护标记；网络失败必须继续保护本地草稿。
      if(cloudSaveSucceeded){
        for(var savedId in dirtyVersions){
          if(_wpDirtyPlanVersions[savedId]===dirtyVersions[savedId])delete _wpDirtyPlanVersions[savedId];
        }
      }
      // 显示成功提示
      if(rows.length>0)showToast('☁️ 周计划已同步到云端 ✓');
      // ★ 协同任务同步：发起方保存周计划时，自动同步协同任务到接收方（使用冻结的计划引用）
      if(frozenCurrent&&frozenCurrent.plan&&frozenCurrent.year){
        _syncCollabTasks(frozenCurrent.plan,frozenUser,frozenCurrent.year,frozenCurrent.month,frozenCurrent.week).catch(function(e){
          console.warn('[Collab] syncCollabTasks failed',e.message);
        });
      }
    }catch(e){
      console.error('HWM: WP Supabase save failed',e.message);
      showToast('⚠️ 云端同步失败: '+e.message,'warning');
    }
  });
  return _wpCloudSaveQueue;
}

function makeWPId(y,m,w){
  return y+'-'+('0'+m).slice(-2)+'-W'+w;
}

function getWP(y,m,w){return _wpData[makeWPId(y,m,w)]||null;}
function saveWP(y,m,w,plan){var id=makeWPId(y,m,w);console.log('[DEBUG saveWP] id='+id+' planName='+(plan&&plan.name)+' task0work="'+(plan&&plan.tasks&&plan.tasks[0]?plan.tasks[0].work.substr(0,20):'')+'"');_wpData[id]=plan;_wpDirtyPlanVersions[id]=(plan&&plan.updatedAt)||new Date().toISOString();return saveWPData(id);}

// 任务编辑采用输入即持久化：不再依赖 blur 或顶部按钮。云端写入由 saveWPData 的串行队列保证顺序。
function _wpPersistTaskInput(cell, value, syncCloud){
  var p=_wpCurrent&&_wpCurrent.plan;
  var field=cell&&cell.dataset&&cell.dataset.field;
  if(!p||!field||field.indexOf('tasks.')!==0||_wpViewingShared){
    // ★ j75 diagnostic: log early-exit reason
    if(field&&field.indexOf('tasks.')===0) console.log('[WP-DIAG] _wpPersistTaskInput SKIP: p='+!!p+' field='+field+' viewingShared='+_wpViewingShared+' viewingSub='+_wpViewingSubordinate);
    return;
  }
  var parts=field.split('.'), ti=parseInt(parts[1]), prop=parts[2];
  if(isNaN(ti)||!prop||!p.tasks||!p.tasks[ti])return;
  if(p.tasks[ti][prop]===value&&!syncCloud)return;
  console.log('[WP-DIAG] _wpPersistTaskInput WRITE: '+field+' = "'+value.substr(0,30)+'" syncCloud='+syncCloud+' weekId='+makeWPId(p.year,p.month,p.week));
  p.tasks[ti][prop]=value;
  p.updatedAt=new Date().toISOString();
  _calcWeekScore(p);
  var id=makeWPId(p.year,p.month,p.week);
  _wpData[id]=p;
  _wpDirtyPlanVersions[id]=p.updatedAt;
  // 每次输入立即写本地：关闭页面、点击表情或网络抖动都不会丢草稿。
  try{localStorage.setItem(getWPLocalStorageKey(),JSON.stringify(_wpData));}catch(e){}
  if(syncCloud)saveWP(p.year,p.month,p.week,p);
}

function _wpBindLiveTaskPersistence(cell, control){
  if(!cell||!control||!cell.dataset||cell.dataset.field.indexOf('tasks.')!==0){
    console.log('[WP-DIAG] _wpBindLiveTaskPersistence SKIP: cell='+!!cell+' dataset='+!!(cell&&cell.dataset)+' field='+(cell&&cell.dataset&&cell.dataset.field));
    return;
  }
  console.log('[WP-DIAG] _wpBindLiveTaskPersistence BOUND: field='+cell.dataset.field+' currentUser='+(currentUser&&currentUser.name));
  var timer=null;
  control.addEventListener('input',function(){
    _wpPersistTaskInput(cell,control.value,false);
    clearTimeout(timer);
    timer=setTimeout(function(){_wpPersistTaskInput(cell,control.value,true);},350);
  });
  control.addEventListener('change',function(){
    clearTimeout(timer);
    _wpPersistTaskInput(cell,control.value,true);
  });
}
async function deleteWP(y,m,w,force){
  var id=makeWPId(y,m,w), user=_wpTargetUser();
  var sourceUid=(currentUser&&currentUser._uid)||user;
  // 删除来源周计划前先撤回其协同请求；清理失败则中止删除，避免接收方遗留孤儿协同任务。
  if(typeof supabase!=='undefined'&&supabase&&supabase.from){
    try{await _clearCollabTasksFromSource(sourceUid,id);}
    catch(e){console.error('[Collab] 删除周计划前清理协同任务失败:',e.message);if(typeof showToast==='function')showToast('⚠️ 协同任务清理失败，请重试');return false;}
  }
  // 先删除云端；云端失败时保留本地，避免两端状态不一致
  if(typeof supabase!=='undefined'&&supabase&&supabase.from){
    try{await _wpDeleteCloudPlan(user,id);}
    catch(e){console.error('[WP] 云端删除失败:',e.message);if(typeof showToast==='function')showToast('⚠️ 云端删除失败，请重试');return false;}
  }
  delete _wpData[id];
  try{localStorage.setItem('hwm_wp_deleted_'+user+'_'+id,'1');}catch(e){}
  try{localStorage.setItem(getWPLocalStorageKey(),JSON.stringify(_wpData));}catch(e){}
  _wpRemoveBackups(getWPLocalStorageKey());
  return true;
}

async function forceDeleteViewedWP(){
  if(!_wpCanForceDelete()){_showAlert('只有管理员可以强制删除员工周计划','⚠️ 无权操作',true);return;}
  var p=_wpCurrent&&_wpCurrent.plan;
  if(!p){_showAlert('请先选择要删除的周计划');return;}
  var user=_wpTargetUser(), y=p.year, m=p.month, w=p.week;
  var ok=await _showConfirm('确定强制删除 '+user+' 的 '+y+'年'+m+'月第'+w+'周全部周计划吗？\\n\\n将同时删除云端、本地缓存和备份，删除后不可恢复。','管理员强制删除');
  if(!ok)return;
  var deleted=await deleteWP(y,m,w,true);
  if(!deleted)return;
  _wpCurrent={year:null,month:null,week:null,plan:null};
  showWPEmpty();
  renderWPPlanList(y,m);
  renderWPUserInfo();
  if(typeof showToast==='function')showToast('已强制删除 '+user+' 第'+w+'周全部周计划');
}

function _getPrevWeek(y,m,w){
  // 计算上一周的 (year, month, week)
  if(w>1)return {year:y,month:m,week:w-1};
  if(m>1)return {year:y,month:m-1,week:4};
  return {year:y-1,month:12,week:4};
}
function _autoCarryTasks(plan,y,m,w){
  // 仅对自有计划执行自动顺延（上级查看下属 or 分享查看时不触发）
  if(_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember)return;
  // 防重复：如果已有 carriedFrom 标记的任务，说明已执行过
  if(plan.tasks.some(function(t){return t.carriedFrom;}))return;
  var pwk=_getPrevWeek(y,m,w);
  var prevPlan=getWP(pwk.year,pwk.month,pwk.week);
  if(!prevPlan||!prevPlan.tasks)return;
  // ★ V0.1.87: 仅当上周已完成「工作小结」时才自动顺延
  if(!prevPlan.summarySubmittedAt)return;
  var carried=[];
  for(var i=0;i<prevPlan.tasks.length;i++){
    var t=prevPlan.tasks[i];
    if(!t.work || !t.work.trim())continue;   // 空任务不转
    if(t.status==='按时完成'||t.status==='逾期完成')continue;           // 已完成不转
    if(t.collab_from)continue;                // 协同任务不转
    // 去重：同一工作内容只转一次
    var dup=carried.some(function(c){return c.work===t.work;});
    if(dup)continue;
    carried.push({
      work:t.work, goal:t.goal||'', startDate:t.startDate||'', plannedDate:t.plannedDate||'',
      actualDate:'', status:'', supporters:t.supporters||'',
      problems:'', problemType:'', needBoss:'',
      bossFeedback:'', remarks:'', aiSuggestion:'',
      carriedFrom:{year:pwk.year,month:pwk.month,week:pwk.week}
    });
  }
  if(!carried.length)return;
  // 去重：避免与本周已有任务重复
  for(var ci=carried.length-1;ci>=0;ci--){
    var dup2=plan.tasks.some(function(t2){return t2.work===carried[ci].work;});
    if(dup2)carried.splice(ci,1);
  }
  if(!carried.length)return;
  // 清除末尾的空行，给转入任务腾位置（保留max(2, plan.tasks中已有实际内容数)个空行）
  var keep=2,hasContent=0;
  for(var k=0;k<plan.tasks.length;k++){if(plan.tasks[k].work&&plan.tasks[k].work.trim())hasContent++;}
  keep=Math.max(2,hasContent);
  while(plan.tasks.length>keep&&!plan.tasks[plan.tasks.length-1].work){plan.tasks.pop();}
  // 转入任务插到数组头部（本周新增在下面）
  for(var j=carried.length-1;j>=0;j--){
    plan.tasks.unshift(carried[j]);
  }
  plan.updatedAt=new Date().toISOString();
  saveWP(y,m,w,plan);
}

// ★ V0.1.45: 仅上级完成评价后，将未完成任务顺延到下周
// 上级评价时 forceResync=true，先清除旧转入再以上级修正状态重新 copy
function _carryTasksToNextWeek(sourcePlan, forceResync){
  if(!sourcePlan||!sourcePlan.tasks)return;
  // 计算下周
  var y=sourcePlan.year, m=sourcePlan.month, w=sourcePlan.week+1;
  if(w>4){w=1;m++;if(m>12){m=1;y++;}}
  var empName=sourcePlan.name;
  var nextPlan=getWP(y,m,w);
  // ★ 如果是上级评价后的修正同步，先清除下周所有旧转入任务
  if(forceResync&&nextPlan){
    nextPlan.tasks=nextPlan.tasks.filter(function(t){return !t.carriedFrom;});
    saveWP(y,m,w,nextPlan);
  }
  // 收集源计划中未完成的任务
  var carried=[];
  for(var i=0;i<sourcePlan.tasks.length;i++){
    var t=sourcePlan.tasks[i];
    if(!t.work||!t.work.trim())continue;
    if(t.status==='✓完成'||t.status==='已完成')continue;
    if(t.collab_from)continue;
    var dup=carried.some(function(c){return c.work===t.work;});
    if(dup)continue;
    carried.push({
      work:t.work, goal:t.goal||'', plannedDate:'',
      actualDate:'', status:'', supporters:t.supporters||'',
      problems:'', problemType:'', needBoss:'',
      bossFeedback:'', remarks:'', aiSuggestion:'',
      carriedFrom:{year:sourcePlan.year,month:sourcePlan.month,week:sourcePlan.week}
    });
  }
  if(!carried.length)return;
  if(!nextPlan){
    // 创建下周空白计划
    nextPlan=createEmptyPlan(y,m,w);
    nextPlan.name=empName||'';
    if(sourcePlan.dept)nextPlan.dept=sourcePlan.dept;
    if(sourcePlan.position)nextPlan.position=sourcePlan.position;
    saveWP(y,m,w,nextPlan);
  }
  // 防重复（首次转入时跳过）
  if(!forceResync&&nextPlan.tasks.some(function(t){return t.carriedFrom;}))return;
  // 去重本周已有
  for(var ci=carried.length-1;ci>=0;ci--){
    if(nextPlan.tasks.some(function(t2){return t2.work===carried[ci].work;}))carried.splice(ci,1);
  }
  if(!carried.length)return;
  // 清空末尾空行
  var keep=2,hasContent=0;
  for(var k=0;k<nextPlan.tasks.length;k++){if(nextPlan.tasks[k].work&&nextPlan.tasks[k].work.trim())hasContent++;}
  keep=Math.max(2,hasContent);
  while(nextPlan.tasks.length>keep&&!nextPlan.tasks[nextPlan.tasks.length-1].work){nextPlan.tasks.pop();}
  // 插入头部
  for(var j=carried.length-1;j>=0;j--){nextPlan.tasks.unshift(carried[j]);}
  nextPlan.updatedAt=new Date().toISOString();
  saveWP(y,m,w,nextPlan);
}

function createEmptyPlan(y,m,w){
  var emp=getViewedUserEmp();
  var tasks=[];
  // ★ V0.1.59: 新建周计划默认1行空表单，通过+按钮逐行添加
  for(var i=0;i<1;i++)tasks.push({seq:i+1,work:'',goal:'',startDate:'',plannedDate:'',actualDate:'',estimatedHours:'',status:'',supporters:'',problems:'',problemType:'',needBoss:'',bossFeedback:'',aiSuggestion:''});
  return {year:y,month:m,week:w,name:emp.name,dept:emp.dept,position:emp.position,tasks:tasks,bossEvaluated:false,bossEvaluatedAt:null,bossEvaluatedBy:'',bossOverallFeedback:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
}

function renderWPUserInfo(){
  var div=document.getElementById('wpUserInfo');
  if(!div)return;
  if(_wpViewingShared){
    var sharedName=_wpViewingShared;
    var sharedDept='', sharedPos='';
    if(_wpCurrent&&_wpCurrent.plan){
      sharedDept=_wpCurrent.plan.dept||'';
      sharedPos=_wpCurrent.plan.position||'';
    }
    div.textContent='📖 查看分享：'+sharedName+' | '+sharedDept+' | '+sharedPos;
  }else if(_wpViewingSubordinate){
    var subName=_wpViewingSubordinate;
    var subDept='', subPos='', subMood='';
    if(_wpCurrent&&_wpCurrent.plan){
      subDept=_wpCurrent.plan.dept||'';
      subPos=_wpCurrent.plan.position||'';
      subMood=_wpCurrent.plan.mood||'';
    }
    var moodDot='';
    if(subMood){
      var moodCls={happy:'mood-happy',calm:'mood-calm',tired:'mood-tired',pain:'mood-pain',silent:'mood-silent'}[subMood]||'';
      moodDot=' <span class="wp-mood-dot '+moodCls+'" title="本周心情：'+( {happy:'开心',calm:'平静',tired:'疲惫',pain:'痛苦',silent:'沉默'}[subMood]||'')+'"></span>';
    }
    div.innerHTML='查看直属下属：'+_h(subName)+' | '+_h(subDept)+' | '+_h(subPos)+moodDot;
  }else if(_wpViewingDeptMember){
    var memName=_wpViewingDeptMember;
    var memDept='', memPos='', memMood='';
    if(_wpCurrent&&_wpCurrent.plan){
      memDept=_wpCurrent.plan.dept||'';
      memPos=_wpCurrent.plan.position||'';
      memMood=_wpCurrent.plan.mood||'';
    }
    var moodDot2='';
    if(memMood){
      var moodCls2={happy:'mood-happy',calm:'mood-calm',tired:'mood-tired',pain:'mood-pain',silent:'mood-silent'}[memMood]||'';
      moodDot2=' <span class="wp-mood-dot '+moodCls2+'" title="本周心情：'+( {happy:'开心',calm:'平静',tired:'疲惫',pain:'痛苦',silent:'沉默'}[memMood]||'')+'"></span>';
    }
    div.innerHTML='查看更多下属：'+_h(memName)+' | '+_h(memDept)+' | '+_h(memPos)+moodDot2;
  }else{
    var emp=getCurrentEmployee();
    var displayName=emp.name, displayDept=emp.dept, displayPos=emp.position;
    if(_wpCurrent&&_wpCurrent.plan&&_wpCurrent.plan.name){
      displayName=_wpCurrent.plan.name;
      displayDept=_wpCurrent.plan.dept||emp.dept;
      displayPos=_wpCurrent.plan.position||emp.position;
    }
    div.innerHTML=''; // V0.3.07: 隐藏"当前：姓名|部门|职位"（与下方信息栏重复）
    div.style.display='none';
  }
}


// 递归获取所有间接下属（下属的下属，排除直属下属和当前用户）
function getAllIndirectSubordinates(uid){
  var direct=getSubordinates(uid);
  if(!direct||direct.length===0)return[];
  var allDirect={};
  for(var i=0;i<direct.length;i++)allDirect[direct[i]]=true;
  var indirect=[];
  var seen={};
  // BFS 遍历所有下属的下属
  var queue=direct.slice();
  while(queue.length>0){
    var name=queue.shift();
    if(seen[name])continue;
    seen[name]=true;
    // 通过 name 反查 uid
    var subUid=null;
    for(var id in USERS){if(USERS[id]&&USERS[id].name===name){subUid=id;break;}}
    if(!subUid)continue;
    var subs=getSubordinates(subUid);
    if(subs)for(var i=0;i<subs.length;i++){
      if(allDirect[subs[i]])continue; // 排除直属下属
      if(!seen[subs[i]]){
        indirect.push(subs[i]);
        queue.push(subs[i]);
      }
    }
  }
  return indirect;
}
function renderWPSubSelect(){
  if(!currentUser||!currentUser._uid)return;
  var div=document.getElementById('wpSubSelect');
  if(!div)return;
  var myName=(currentUser&&currentUser.name)||'';

  // 收集直属下属
  var subs=getWPSubordinates().filter(function(s){return s!==myName;});
  var subsDetail=getSubordinatesDetail(currentUser._uid);

  // 收集间接下属（排除直属和当前用户）
  var deptMembers=getAllIndirectSubordinates(currentUser._uid);
  var nonDirect=[];
  for(var i=0;i<deptMembers.length;i++){
    if(subs.indexOf(deptMembers[i])<0)nonDirect.push(deptMembers[i]);
  }

  // ★ V0.6.1j: 收集授权我阅览其周计划的同事（排除已在上级列表中的）
  var sharedList=getSharedToMeList();
  var sharedNames=[];
  for(var i=0;i<sharedList.length;i++){
    var sName=sharedList[i].name;
    if(subs.indexOf(sName)<0 && nonDirect.indexOf(sName)<0 && sName!==myName){
      sharedNames.push(sName);
    }
  }

  // 没有任何下属且无共享同事 → 隐藏
  if(subs.length===0&&nonDirect.length===0&&sharedNames.length===0){
    div.style.display='none';
    return;
  }

  div.style.display='flex';
  div.style.marginLeft='auto';

  // ★ V0.5.80: 合并下属数据（直属+间接）到同一数据源
  _wpSubData.options=[];
  _wpSubData.details={};
  for(var i=0;i<subs.length;i++){
    var rel=subsDetail[subs[i]]||'direct';
    _wpSubData.options.push({name:subs[i],rel:rel});
    _wpSubData.details[subs[i]]=rel;
  }
  for(var i=0;i<nonDirect.length;i++){
    _wpSubData.options.push({name:nonDirect[i],rel:'indirect'});
    _wpSubData.details[nonDirect[i]]='indirect';
  }
  // ★ V0.6.1j: 加入共享同事
  for(var i=0;i<sharedNames.length;i++){
    _wpSubData.options.push({name:sharedNames[i],rel:'shared'});
    _wpSubData.details[sharedNames[i]]='shared';
  }

  // 更新触发器文字
  var triggerText=document.getElementById('wpSubTriggerText');
  if(triggerText){
    if(_wpViewingSubordinate){
      triggerText.textContent=_wpViewingSubordinate;
      _wpSubData.selected=_wpViewingSubordinate;
    }else if(_wpViewingDeptMember){
      triggerText.textContent=_wpViewingDeptMember;
      _wpSubData.selected=_wpViewingDeptMember;
    }else if(_wpViewingShared){
      triggerText.textContent=_wpViewingShared;
      _wpSubData.selected=_wpViewingShared;
    }else{
      triggerText.textContent='审阅团队周行动项';triggerText.style.color='';
      _wpSubData.selected='';
    }
  }

  // ★ 分组渲染下拉内容
  var dd=document.getElementById('wpSubDropdown');
  if(dd){
    var ddHtml='';
    // ★ V0.6.1do: 先计算分组（避免后面引用未定义的变量）
    var directOpts=_wpSubData.options.filter(function(o){return o.rel==='direct';});
    // ★ V0.6.1dh: 下属重急事项放最前面（关注优先）
    if(subs.length>0){
      ddHtml+='<div class="wp-custom-option'+(_wpViewingMergedUrgent?' active':'')+'" onclick="selectWPSubOption(\'__merged_urgent_direct__\',\'直接下属重急项\',\'merged-urgent\')"><span style="margin-right:8px">⚠️</span>直接下属重急项</div>';
    }
    // ★ V0.6.1do: 间接下属重急项
    if(nonDirect.length>0){
      ddHtml+='<div class="wp-custom-option" onclick="selectWPSubOption(\'__merged_urgent_indirect__\',\'间接下属重急项\',\'merged-urgent-indirect\')"><span style="margin-right:8px">⚡</span>间接下属重急项</div>';
    }
    if(subs.length>0||nonDirect.length>0){
      ddHtml+='<div style="border-top:1px solid #e5e7eb;margin:6px 0"></div>';
    }
    // 直属下属组
    if(directOpts.length>0){
      ddHtml+='<div style="font-size:13px;color:#6b7280;padding:2px 0 4px">直属下属</div>';
      for(var i=0;i<directOpts.length;i++){
        var o=directOpts[i];
        var isActive=(o.name===_wpViewingSubordinate)?' active':'';
        ddHtml+='<div class="wp-custom-option'+isActive+'" onclick="selectWPSubOption(\''+esc(o.name)+'\',\''+esc(o.name)+'\',\'direct\')"><span style="margin-right:8px;color:#22c55e">●</span>'+esc(o.name)+'</div>';
      }
    }
    // 分隔线 + 间接下属组
    if(nonDirect.length>0){
      if(directOpts.length>0){
        ddHtml+='<div style="border-top:1px solid #e5e7eb;margin:6px 0"></div>';
      }
      ddHtml+='<div style="font-size:13px;color:#6b7280;padding:2px 0 4px">间接下属</div>';
      for(var i=0;i<nonDirect.length;i++){
        var isActive=(nonDirect[i]===_wpViewingDeptMember)?' active':'';
        ddHtml+='<div class="wp-custom-option'+isActive+'" onclick="selectWPSubOption(\''+esc(nonDirect[i])+'\',\''+esc(nonDirect[i])+'\',\'indirect\')"><span style="margin-right:8px;color:#3b82f6">●</span>'+esc(nonDirect[i])+'</div>';
      }
    }
    // ★ V0.6.1j: 分隔线 + 其他同事（授权我阅览其周计划的同事）
    if(sharedNames.length>0){
      if(directOpts.length>0||nonDirect.length>0){
        ddHtml+='<div style="border-top:1px solid #e5e7eb;margin:6px 0"></div>';
      }
      ddHtml+='<div style="font-size:13px;color:#6b7280;padding:2px 0 4px">其他同事</div>';
      for(var i=0;i<sharedNames.length;i++){
        var isActive=(sharedNames[i]===_wpViewingShared)?' active':'';
        ddHtml+='<div class="wp-custom-option'+isActive+'" onclick="selectWPSubOption(\''+esc(sharedNames[i])+'\',\''+esc(sharedNames[i])+'\',\'shared\')"><span style="margin-right:8px;color:#f59e0b">●</span>'+esc(sharedNames[i])+'</div>';
      }
    }
    ddHtml+='<div style="height:12px"></div>';
    dd.innerHTML=ddHtml;
  }

  // 「Return to My Plan」按钮：有下属时始终显示
  var myBtn=document.getElementById('wpBtnMyPlan');
  if(myBtn)myBtn.style.display='inline-block';
}

function switchToMyWP(){
  _wpViewingSubordinate=null;
  _wpViewingDeptMember=null;
  _wpViewingShared=null;
  _wpViewingMergedUrgent=false;
  _wpViewingMergedIndirect=false;
  _wpRevisionMode=false;
  _wpCurrent={year:null,month:null,week:null,plan:null};
  _wpSubData.selected='';
  _wpCurrent.mergedTasks=null;
  var triggerText=document.getElementById('wpSubTriggerText');
  if(triggerText){triggerText.textContent='审阅团队周行动项';triggerText.style.color='';}
  var sharedTriggerText=document.getElementById('wpSharedTriggerText');
  if(sharedTriggerText)sharedTriggerText.textContent='📖 查看授权我阅览其周计划的同事';
  // ★ V0.6.1dg: 清理合并视图的残留 DOM
  var content=document.getElementById('wpContent');
  if(content){
    var sc=content.querySelector('.wp-scroll-area');if(sc)sc.remove();
    var ta=content.querySelector('.wp-table-area');if(ta)ta.remove();
    var emp=content.querySelector('.wp-empty');if(emp)emp.remove();
    var infoBar=content.querySelector('.wp-info-bar');if(infoBar)infoBar.remove();
  }
  loadWPData();
  renderWPUserInfo();
  renderWPSubSelect();
  renderWPSharedSelect();
  showWPEmpty();
  
  // ★ V0.5.50: 同步计算当前周并选中，避免双重渲染导致的跳动
  var now=new Date();
  var autoY=now.getFullYear();
  var autoM=now.getMonth()+1;
  var yEl=document.getElementById('wpYear');
  var mEl=document.getElementById('wpMonth');
  if(yEl) yEl.value=autoY;
  if(mEl) mEl.value=autoM;
  syncMonthLabel();
  syncYearLabel(); // ★ V0.6.1fk: 同步年份标签（避免 createNewWP 跨年时只改了 label 文字）
  
  var currInfo=getCurrentISOWeek();
  var mapped=isoWeekToMonthWeek(currInfo.week);
  selectWP(autoY, mapped.month, mapped.week);
}

// ★ V0.2.40: 自定义下拉组件 — 替代原生select，小圆角+不遮挡
var _wpSubData={options:[],selected:'',details:{}};
// ★ V0.3.135: 智能下拉定位 — Portal模式：打开时移到body级别，关闭时归还父级
function _positionDropdown(dd,trigger){
  var GAP=8;
  var PADDING=16;
  var MAX_H=600;
  var rect=trigger.getBoundingClientRect();
  var spaceBelow=window.innerHeight-rect.bottom-GAP;
  var spaceAbove=rect.top-GAP;
  // 记录原始父节点（关闭时归还）
  if(!dd._originalParent){
    dd._originalParent=dd.parentNode;
  }
  // ★ 核心：将下拉框提升到 body 级别，脱离所有祖先层叠上下文
  if(dd.parentNode!==document.body){
    document.body.appendChild(dd);
  }
  dd.style.left=rect.left+'px';
  dd.style.width=rect.width+'px';
  // ★ V0.4.46: 始终向下展开，弹窗上边缘对齐单元格下边线，不向上溢出
  dd.style.top=(rect.bottom+GAP)+'px';
  dd.style.bottom='auto';
  dd.style.maxHeight=Math.min(Math.max(spaceBelow-PADDING,120),MAX_H)+'px';
  dd._dropDir='down';
}

function _returnDropdownToParent(dd){
  if(dd&&dd._originalParent&&dd.parentNode===document.body){
    try{dd._originalParent.appendChild(dd);}catch(e){}
    dd._originalParent=null;
    dd.style.left='';
    dd.style.top='';
    dd.style.bottom='';
    dd.style.width='';
    dd.style.maxHeight='';
  }
}

function toggleWPSubDropdown(){
  var dd=document.getElementById('wpSubDropdown');
  if(!dd)return;
  var isOpen=dd.style.display==='block';
  if(isOpen){dd.style.display='none';_returnDropdownToParent(dd);return;}
  var trigger=document.getElementById('wpSubTrigger');
  if(trigger){_positionDropdown(dd,trigger);}
  dd.style.display='block';
  _setupDropdownScrollHint(dd);
  setTimeout(function(){document.addEventListener('click',_wpCloseSubDropdown);},50);
}
function _wpCloseSubDropdown(e){
  var trigger=document.getElementById('wpSubTrigger');
  var dd=document.getElementById('wpSubDropdown');
  if(!dd)return;
  if(trigger&&trigger.contains(e.target))return;
  if(dd.contains(e.target))return;
  dd.style.display='none';
  _returnDropdownToParent(dd);
  document.removeEventListener('click',_wpCloseSubDropdown);
}
function selectWPSubOption(val,name,rel){
  var dd=document.getElementById('wpSubDropdown');
  if(dd){dd.style.display='none';_returnDropdownToParent(dd);}
  document.removeEventListener('click',_wpCloseSubDropdown);
  _wpSubData.selected=val;
  var triggerText=document.getElementById('wpSubTriggerText');
  if(triggerText){
    if(!val){triggerText.textContent='审阅团队周行动项';triggerText.style.color='';}
    else{triggerText.textContent=name||val;triggerText.style.color='';}
  }
  // ★ V0.6.1j: 根据 rel 分流到直属、间接或共享处理
  if(rel==='shared'){
    _wpViewingSubordinate=null;
    _wpViewingDeptMember=null;
    _wpViewingShared=val;
    _wpRevisionMode=false;
    _wpCurrent={year:null,month:null,week:null,plan:null};
    loadWPData();
    renderWPUserInfo();
    renderWPSubSelect();
    showWPEmpty();
    onWPMonthChange();
    var yEl=document.getElementById('wpYear');
    var mEl=document.getElementById('wpMonth');
    var autoY=yEl?parseInt(yEl.value):new Date().getFullYear();
    var autoM=mEl?parseInt(mEl.value):(new Date().getMonth()+1);
    // ★ V0.6.1dk: 与年周度网格的"当前周"一致
    var sNow=new Date();
    var sCurrISO=getCurrentISOWeek();
    var sMapped=isoWeekToMonthWeek(sCurrISO.week);
    if(sCurrISO.year!==autoY) sMapped={month:1,week:1};
    setTimeout(function(){ try{selectWP(autoY,sMapped.month,sMapped.week);}catch(e){console.warn('auto-selectWP after shared change failed:',e);} }, 100);
  }else if(rel==='merged-urgent'){
    // ★ V0.6.1do: 直接下属重急项
    var yEl2=document.getElementById('wpYear');
    var mEl2=document.getElementById('wpMonth');
    var yNow=yEl2?parseInt(yEl2.value):(_wpCurrent.year||new Date().getFullYear());
    var mNow=mEl2?parseInt(mEl2.value):(_wpCurrent.month||(new Date().getMonth()+1));
    var wNow=_wpCurrent.week||1;
    _wpViewingSubordinate=null;
    _wpViewingDeptMember=null;
    _wpViewingShared=null;
    _wpViewingMergedUrgent=true;
    _wpViewingMergedIndirect=false;
    _wpRevisionMode=false;
    _wpCurrent={year:yNow,month:mNow,week:wNow,plan:null};
    renderWPUserInfo();
    renderWPSubSelect();
    _renderMergedUrgentView();
  }else if(rel==='merged-urgent-indirect'){
    // ★ V0.6.1do: 间接下属重急项
    var yEl3=document.getElementById('wpYear');
    var mEl3=document.getElementById('wpMonth');
    var yNow3=yEl3?parseInt(yEl3.value):(_wpCurrent.year||new Date().getFullYear());
    var mNow3=mEl3?parseInt(mEl3.value):(_wpCurrent.month||(new Date().getMonth()+1));
    var wNow3=_wpCurrent.week||1;
    _wpViewingSubordinate=null;
    _wpViewingDeptMember=null;
    _wpViewingShared=null;
    _wpViewingMergedUrgent=true;
    _wpViewingMergedIndirect=true;
    _wpRevisionMode=false;
    _wpCurrent={year:yNow3,month:mNow3,week:wNow3,plan:null};
    renderWPUserInfo();
    renderWPSubSelect();
    _renderMergedUrgentView();
  }else if(rel==='indirect'){
    onWPDeptMemberChange(val);
  }else{
    onWPSubordinateChange(val);
  }
}

// ★ V0.6.1df: 下属重急事项合并视图
async function _renderMergedUrgentView(){
  var myName=(currentUser&&currentUser.name)||'';
  // ★ V0.6.1do: 根据 _wpViewingMergedIndirect 决定收集直接/间接下属
  var subs;
  if(_wpViewingMergedIndirect){
    var directSubs=getWPSubordinates();
    var allSubIds=getAllIndirectSubordinates(currentUser._uid);
    subs=allSubIds.filter(function(name){
      return directSubs.indexOf(name)<0&&name!==myName;
    });
  }else{
    subs=getWPSubordinates().filter(function(s){return s!==myName;});
  }
  if(subs.length===0){
    var content=document.getElementById('wpContent');
    if(content){
      var sc=content.querySelector('.wp-scroll-area');if(sc)sc.remove();
      var ta=content.querySelector('.wp-table-area');if(ta)ta.remove();
      var ib=content.querySelector('.wp-info-bar');if(ib)ib.remove();
      var emp=content.querySelector('.wp-empty');if(emp)emp.remove();
      var emptyDiv=document.createElement('div');
      emptyDiv.className='wp-empty';
      emptyDiv.innerHTML='<div class="wp-empty-title" style="font-size:15px">本周暂无'+( _wpViewingMergedIndirect?'间接':'直接')+'下属重要紧急事项</div><div class="wp-empty-desc">你的'+( _wpViewingMergedIndirect?'间接':'直接')+'下属本周没有标记为"重要紧急"的行动项，团队节奏良好 👍<div style="font-size:12px;color:var(--text-hint);margin-top:4px">No urgent & important items from your '+( _wpViewingMergedIndirect?'indirect':'direct')+' subordinates this week</div></div>';
      content.appendChild(emptyDiv);
    }
    return;
  }

  // 收集所有直属下属当前周的重要紧急事项
  var allTasks=[];
  var now=new Date();now.setHours(0,0,0,0);
  var cy=_wpCurrent.year||now.getFullYear();
  var cm=_wpCurrent.month||(now.getMonth()+1);
  var cw=_wpCurrent.week||getISOWeek(now);

  // ★ V0.6.1dh: 从 Supabase 拉取每个下属的数据（数据可能在云端）
  // 先尝试在内存中聚合所有下属的 data（localStorage + Supabase）
  try{
    if(typeof supabase!=='undefined'&&supabase&&supabase.from){
      var fetchPromises=subs.map(function(sname){
        return supabase.from(SUPABASE_WP_TABLE).select('week_id,plan_data').eq('username',sname)
          .then(function(r){
            if(r.error){console.warn('[merged] Supabase fetch failed for '+sname+':',r.error.message);return;}
            if(r.data&&r.data.length>0){
              var localKey='hwm_workplans_'+sname;
              var local={};
              try{local=JSON.parse(localStorage.getItem(localKey)||'{}');}catch(e){}
              for(var i=0;i<r.data.length;i++){
                var row=r.data[i];
                if(!local[row.week_id]||(row.plan_data.updatedAt||'')>(local[row.week_id].updatedAt||'')){
                  local[row.week_id]=row.plan_data;
                }
              }
              try{localStorage.setItem(localKey,JSON.stringify(local));}catch(e){}
              console.log('[merged] Synced '+r.data.length+' weeks for '+sname);
            }
          }).catch(function(e){console.warn('[merged] Network error for '+sname+':',e);});
      });
      await Promise.all(fetchPromises);
    }
  }catch(e){console.warn('[merged] Supabase batch fetch failed:',e);}

  for(var si=0;si<subs.length;si++){
    var sname=subs[si];
    var sData={};
    try{sData=JSON.parse(localStorage.getItem('hwm_workplans_'+sname)||'{}');}catch(e){}
    var weekId=cy+'-'+(cm<10?'0':'')+cm+'-W'+cw;
    var plan=sData[weekId];
    if(!plan||!plan.tasks)continue;
    for(var ti=0;ti<plan.tasks.length;ti++){
      var t=plan.tasks[ti];
      if(!t.work||!t.work.trim())continue;
      // ★ V0.6.1dk: 优先级实际存储在 goal 字段（值如 '重要紧急'）
      if(t.goal!=='重要紧急')continue;
      var clone=JSON.parse(JSON.stringify(t));
      clone._empName=sname;clone._empId=sname;
      clone._isOverdue=false;clone._daysOverdue=0;
      if(clone.plannedDate){
        var pd=new Date(clone.plannedDate+'T00:00:00');
        clone._isOverdue=(pd<now)&&(!clone.actualDate);
        if(clone._isOverdue)clone._daysOverdue=Math.floor((now-pd)/(1000*60*60*24));
        if(pd.getTime()===now.getTime()&&!clone.actualDate)clone._isDueToday=true;
      }
      allTasks.push(clone);
    }
  }

  if(allTasks.length===0){
    var content=document.getElementById('wpContent');
    if(content){
      var sc=content.querySelector('.wp-scroll-area');if(sc)sc.remove();
      var ta=content.querySelector('.wp-table-area');if(ta)ta.remove();
      var ib=content.querySelector('.wp-info-bar');if(ib)ib.remove();
      var tb=content.querySelector('.wp-toolbar');if(tb)tb.remove();
      var emp=content.querySelector('.wp-empty');if(emp)emp.remove();
      var emptyDiv=document.createElement('div');
      emptyDiv.className='wp-empty';
      emptyDiv.innerHTML='<div class="wp-empty-title" style="font-size:15px">本周暂无'+( _wpViewingMergedIndirect?'间接':'直接')+'下属重要紧急事项</div><div class="wp-empty-desc">你的'+( _wpViewingMergedIndirect?'间接':'直接')+'下属本周没有标记为"重要紧急"的行动项，团队节奏良好 👍<div style="font-size:12px;color:var(--text-hint);margin-top:4px">No urgent & important items from your '+( _wpViewingMergedIndirect?'indirect':'direct')+' subordinates this week</div></div>';
      content.appendChild(emptyDiv);
    }
    return;
  }

  // 排序：逾期>今天截止>未逾期按计划日期
  allTasks.sort(function(a,b){
    if(a._isOverdue&&!b._isOverdue)return -1;
    if(!a._isOverdue&&b._isOverdue)return 1;
    if(a._isOverdue&&b._isOverdue)return b._daysOverdue-a._daysOverdue;
    if(a._isDueToday&&!b._isDueToday)return -1;
    if(!a._isDueToday&&b._isDueToday)return 1;
    var da=a.plannedDate||'9999';var db=b.plannedDate||'9999';
    return da.localeCompare(db);
  });

  // 分层截取：逾期必显，剩余按计划日期
  var overdueItems=[],dueTodayItems=[],normalItems=[];
  for(var i=0;i<allTasks.length;i++){
    if(allTasks[i]._isOverdue)overdueItems.push(allTasks[i]);
    else if(allTasks[i]._isDueToday)dueTodayItems.push(allTasks[i]);
    else normalItems.push(allTasks[i]);
  }
  var merged=[],limit=20;
  for(var i=0;i<overdueItems.length&&merged.length<limit;i++)merged.push(overdueItems[i]);
  for(var i=0;i<dueTodayItems.length&&merged.length<limit;i++)merged.push(dueTodayItems[i]);
  for(var i=0;i<normalItems.length&&merged.length<limit;i++)merged.push(normalItems[i]);

  var content=document.getElementById('wpContent');
  if(!content)return;
  // ★ V0.6.1dp: 只清理 merged-urgent 相关元素，不能误删主视图的 info-bar/toolbar
  var oldSc=content.querySelectorAll('.wp-scroll-area');oldSc.forEach(function(el){el.remove();});
  var oldTa=content.querySelectorAll('.wp-table-area');oldTa.forEach(function(el){el.remove();});
  var oldIb=content.querySelectorAll('.wp-info-bar.merged-urgent');oldIb.forEach(function(el){el.remove();});
  var oldTb=content.querySelectorAll('.wp-toolbar.merged-urgent');oldTb.forEach(function(el){el.remove();});
  // ★ V0.6.1fe: 切视图前清掉之前的 wp-empty，避免与新数据共存
  var oldEmpty=content.querySelectorAll('.wp-empty');oldEmpty.forEach(function(el){el.remove();});

  var weekLabel=cy+'年'+cm+'月 第'+cw+'周';
  var infoBar=document.createElement('div');
  infoBar.className='wp-info-bar merged-urgent';
  var prefixLabel=_wpViewingMergedIndirect?'间接下属重急项':'直接下属重急项';
  // ★ V0.6.1dl: 全部统一 13px 字体 + padding-left 让位侧栏
  infoBar.innerHTML='<strong style="color:'+(_wpViewingMergedIndirect?'#D97706':'#FF3B30')+';font-size:13px">'+( _wpViewingMergedIndirect?'⚡':'⚠️')+' '+prefixLabel+'</strong> '+
    '<span style="color:#475569;font-size:13px">'+weekLabel+'</span> '+
    '<span style="color:#6b7280;font-size:13px">共 <strong>'+merged.length+'</strong> 项，来自 '+subs.length+' 位'+( _wpViewingMergedIndirect?'间接':'直接')+'下属</span>'+
    (allTasks.length>limit?'<span style="color:#D64352;font-size:13px;margin-left:12px">显示前'+limit+'项（共'+allTasks.length+'项）</span>':'')+
    (overdueItems.length>0&&allTasks.length<=limit?'<span style="color:#D64352;font-size:13px;margin-left:12px">其中 <strong>'+overdueItems.length+'</strong> 项已逾期</span>':'');
  content.appendChild(infoBar);

  // 工具栏
  var toolbar=document.createElement('div');
  toolbar.className='wp-toolbar merged-urgent';
  toolbar.id='wpToolbar';
  // ★ V0.6.1do: 工具栏文字统一 13px；导出按钮 margin-left:auto 让其靠右
  toolbar.innerHTML='<span style="color:#3B7DB4;font-weight:600;font-size:13px">📋 合并视图 — 只读模式</span>'+
    '<button class="wp-btn-export" onclick="exportMergedUrgent()" style="margin-left:auto"><span>📥</span> 导出合并表</button>';
  content.appendChild(toolbar);

  // 表格容器
  var scrollArea=document.createElement('div');
  scrollArea.className='wp-scroll-area';
  var tableWrap=document.createElement('div');
  tableWrap.className='wp-table-wrap';
  var table=document.createElement('table');
  table.className='wp-table merged-urgent';
  table.style.minWidth='1350px';

  // 表头
  var thead=document.createElement('thead');
  var tr=document.createElement('tr');
  var thNum=document.createElement('th');
  thNum.textContent='#';thNum.style.cssText='position:sticky;left:0;z-index:6;background:#E8EAED;border-left:1px solid var(--border);min-width:56px';
  tr.appendChild(thNum);
  var thEmp=document.createElement('th');
  thEmp.textContent='员工';thEmp.style.cssText='position:sticky;left:56px;z-index:6;min-width:70px;background:#E8EAED';
  tr.appendChild(thEmp);
  var thWork=document.createElement('th');
  thWork.textContent='本周重点行动项';thWork.style.cssText='position:sticky;left:126px;z-index:6;min-width:180px;background:#E8EAED';
  tr.appendChild(thWork);
  // ★ V0.6.1fv: 可排序列加 ⇅ 提示图标 + title
  var headers=['优先级','启动日期','计划完成','剩余天数','实际完成','耗时','状态','协同','问题','需要上级','上级建议'];
  var hWids=['80px','80px','80px','80px','80px','56px','56px','80px','56px','56px','120px'];
  var sortableKeys=['priority','startDate','plannedDate','daysLeft',null,null,null,null,null,null,null];
  for(var hi=0;hi<headers.length;hi++){
    var th=document.createElement('th');
    if(sortableKeys[hi]){
      th.innerHTML=headers[hi]+' <span style="opacity:.4;font-size:10px;margin-left:2px">⇅</span>';
      th.ondblclick=function(k){return function(){toggleWPSort(k);};}(sortableKeys[hi]);
      th.title='💡 双击表头切换排序';
      th.style.cssText='cursor:pointer;min-width:'+hWids[hi]+';user-select:none';
    }else{
      th.textContent=headers[hi];th.style.minWidth=hWids[hi];
    }
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  table.appendChild(thead);

  // 数据行
  var tbody=document.createElement('tbody');
  for(var i=0;i<merged.length;i++){
    var t=merged[i];
    var bg=t._isOverdue?'#FFF5F5':t._isDueToday?'#FFF8E1':'#FBF8F3';
    var tr2=document.createElement('tr');
    tr2.style.background=bg;
    // # 列
    var td1=document.createElement('td');
    td1.textContent=(i+1);td1.className='col-num';
    td1.style.cssText='position:sticky;left:0;z-index:2;background:'+bg+';border-left:1px solid var(--border);min-width:56px';
    tr2.appendChild(td1);
    // 员工
    var td2=document.createElement('td');
    td2.textContent=t._empName;
    td2.style.cssText='position:sticky;left:56px;z-index:2;background:'+bg+';min-width:70px;text-align:center;font-weight:500;font-size:11px';
    tr2.appendChild(td2);
    // 事项
    var td3=document.createElement('td');
    td3.textContent=t.work||'';
    td3.style.cssText='position:sticky;left:126px;z-index:2;background:'+bg+';min-width:180px;text-align:left;font-weight:600';
    tr2.appendChild(td3);
    // 优先级
    // 优先级 — ★ V0.6.1dk: 实际字段是 goal，不是 pri
    tr2.innerHTML+='<td style="color:#FF3B30;font-weight:600;min-width:80px;text-align:center;background:'+bg+'">重要紧急</td>';
    // 启动日期
    tr2.innerHTML+='<td style="min-width:80px;text-align:center;background:'+bg+'">'+_h(t.startDate||'')+'</td>';
    // 计划完成
    tr2.innerHTML+='<td style="min-width:80px;text-align:center;background:'+bg+'">'+_h(t.plannedDate||'')+'</td>';
    // 剩余天数
    tr2.innerHTML+='<td style="min-width:80px;text-align:center;background:'+bg+'">'+_calcRemainingDays(t.plannedDate,t.actualDate)+'</td>';
    // 实际完成
    tr2.innerHTML+='<td style="min-width:80px;text-align:center;background:'+bg+'">'+_h(t.actualDate||'')+'</td>';
    // 耗时
    tr2.innerHTML+='<td style="min-width:56px;text-align:center;background:'+bg+'">'+_h(t.estimatedHours||'')+'</td>';
    // 状态
    tr2.innerHTML+='<td style="min-width:56px;text-align:center;background:'+bg+'">'+_h(t.status||'')+'</td>';
    // 协同
    tr2.innerHTML+='<td style="min-width:80px;text-align:center;background:'+bg+'">'+_h((t.supporters||'').replace(/,/g,'、'))+'</td>';
    // 问题
    tr2.innerHTML+='<td style="min-width:56px;text-align:center;font-size:12px;background:'+bg+'">'+(t.problems?t.problems:'-')+'</td>';
    // 需要上级
    tr2.innerHTML+='<td style="min-width:56px;text-align:center;background:'+bg+'">'+_h(t.needBoss||'')+'</td>';
    // 上级建议
    tr2.innerHTML+='<td style="min-width:120px;text-align:left;background:'+bg+'">'+_h(t.bossFeedback||'')+'</td>';
    tbody.appendChild(tr2);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  scrollArea.appendChild(tableWrap);
  content.appendChild(scrollArea);

  // 存储供导出
  _wpCurrent.mergedTasks=merged;
}

// 部门成员自定义下拉（V0.5.80 已合并到主下拉）
// toggleWPDeptDropdown, _wpCloseDeptDropdown, selectWPDeptOption — removed

// ★ V0.3.134: 下拉滚动提示
function _setupDropdownScrollHint(dd){
  if(!dd)return;
  // 移除已有提示
  var existing=dd.querySelector('.wp-dropdown-scroll-hint');
  if(existing)existing.remove();
  dd.removeEventListener('scroll',dd._scrollHintHandler);
  // 检查是否需要提示
  var needsHint=dd.scrollHeight>dd.clientHeight+2;
  if(!needsHint)return;
  var isUp=(dd._dropDir==='up');
  // 添加提示条（向上弹出时放在顶部，向下时放底部）
  var hint=document.createElement('div');
  hint.className='wp-dropdown-scroll-hint';
  if(isUp){
    hint.innerHTML='<span>▲</span> 向上滚动查看更多';
    hint.style.cssText='position:sticky;top:0;';
    // 插入到最前面
    dd.insertBefore(hint,dd.firstChild);
    // 滚动到顶部隐藏
    dd._scrollHintHandler=function(){
      var atTop=dd.scrollTop<=4;
      var h=dd.querySelector('.wp-dropdown-scroll-hint');
      if(h)h.style.display=atTop?'none':'flex';
    };
  }else{
    hint.innerHTML='<span>▼</span> 向下滚动查看更多';
    dd.appendChild(hint);
    // 滚动到底部隐藏
    dd._scrollHintHandler=function(){
      var atBottom=dd.scrollTop+dd.clientHeight>=dd.scrollHeight-4;
      var h=dd.querySelector('.wp-dropdown-scroll-hint');
      if(h)h.style.display=atBottom?'none':'flex';
    };
  }
  dd.addEventListener('scroll',dd._scrollHintHandler);
}
// selectWPDeptOption removed (V0.5.80: merged into selectWPSubOption with rel param)

function onWPSubordinateChange(val){
  // ★ V0.6.1fc: 从重急合并视图点下属名 → 重置标记，进入该下属正常周行动项
  _wpViewingMergedUrgent=false;
  _wpViewingMergedIndirect=false;
  // ★ V0.6.1fd: 切到直属时清掉部门成员选中状态，避免两个高亮
  _wpViewingDeptMember=null;
  var v=(typeof val==='string')?val:_wpSubData.selected;
  var myName=(currentUser&&currentUser.name)||'';
  // 选中自己 = 切换回自己的周计划
  if(v&&v===myName)v=null;
  _wpViewingSubordinate=v;
  _wpRevisionMode=false;
  _wpCurrent={year:null,month:null,week:null,plan:null};
  loadWPData();
  renderWPUserInfo();
  renderWPSubSelect();
  showWPEmpty();
  onWPMonthChange();
  // ★ V0.1.21: 切换下属后自动选中当前日历对应的周
  var yEl=document.getElementById('wpYear');
  var mEl=document.getElementById('wpMonth');
  var autoY=yEl?parseInt(yEl.value):new Date().getFullYear();
  var autoM=mEl?parseInt(mEl.value):(new Date().getMonth()+1);
  // ★ V0.6.1dk: 与年周度网格的"当前周"一致 — 用 getCurrentISOWeek (内部已 week-1)
  var now=new Date();
  var currISO=getCurrentISOWeek();
  var mapped=isoWeekToMonthWeek(currISO.week);
  // 修正：currISO.week 是相对于所选年份的"内部年周"(4/4/5 体系)
  // 需先确认 autoY/currISO.year 匹配
  if(currISO.year!==autoY){
    // 跨年：取该年第一周对应的内部月周
    mapped={month:1,week:1};
  }
  setTimeout(function(){ try{selectWP(autoY,mapped.month,mapped.week);}catch(e){console.warn('auto-selectWP after subordinate change failed:',e);} }, 100);
}

function onWPYearChange(){onWPMonthChange();}

function onWPMonthChange(){
  var yEl=document.getElementById('wpYear');
  var mEl=document.getElementById('wpMonth');
  var year=yEl?parseInt(yEl.value):new Date().getFullYear();
  var month=mEl?parseInt(mEl.value):(new Date().getMonth()+1);
  syncMonthLabel();
  loadWPData();
  // ★ V0.5.33: 月份切换逻辑优化——当前月→当前周，非当前月→该月第一周
  var now=new Date();
  var currYear=now.getFullYear();
  var currMonth=now.getMonth()+1;
  var targetMonth,targetWeek;
  if(year===currYear && month===currMonth){
    var currInfo=getCurrentISOWeek();
    var mapped=isoWeekToMonthWeek(currInfo.week);
    targetMonth=mapped.month;targetWeek=mapped.week;
  }else{
    var isoWeek=getFirstDayISOWeek(year,month);
    var mapped=isoWeekToMonthWeek(isoWeek);
    targetMonth=mapped.month;targetWeek=mapped.week;
  }
  _wpCurrent={year:year,month:targetMonth,week:targetWeek,plan:null};
  var plan=getWP(year,targetMonth,targetWeek);
  if(plan)_wpCurrent.plan=plan;
  renderWPPlanList(year,month);
  if(_wpCurrent.plan) renderWPTable(_wpCurrent.plan);
}

// V0.4.50: 同步月份触发器标签
function syncMonthLabel(){
  var mEl=document.getElementById('wpMonth');
  var lb=document.getElementById('wpMonthLabel');
  if(mEl&&lb)lb.textContent=mEl.options[mEl.selectedIndex]?mEl.options[mEl.selectedIndex].text:(mEl.value+'月');
}

// V0.4.50: 月份自定义下拉面板（替换原生select）
function toggleMonthDropdown(){
  var existing=document.getElementById('__wpMonthDD');
  if(existing){existing.remove();return;}
  var mEl=document.getElementById('wpMonth');
  var trig=document.getElementById('wpMonthTrigger');
  if(!mEl||!trig)return;
  // 创建下拉面板
  var dd=document.createElement('div');
  dd.id='__wpMonthDD';
  dd.className='wp-month-dropdown';
  dd.style.display='grid';
  for(var i=0;i<mEl.options.length;i++){
    (function(opt){
      var odiv=document.createElement('div');
      odiv.className='wp-month-opt'+(opt.selected?' active':'');
      odiv.textContent=opt.text;
      odiv.onclick=function(){
        mEl.value=opt.value;
        syncMonthLabel();
        dd.remove();
        onWPMonthChange();
      };
      dd.appendChild(odiv);
    })(mEl.options[i]);
  }
  document.body.appendChild(dd);
  var cr=trig.getBoundingClientRect();
  dd.style.left=cr.left+'px';
  dd.style.top=(cr.bottom+4)+'px';
  dd.style.width=Math.max(cr.width,140)+'px';
  // 点击外部关闭
  setTimeout(function(){
    document.addEventListener('click',function _c(e){
      if(!dd.contains(e.target)&&e.target!==trig&&!trig.contains(e.target)){
        dd.remove();document.removeEventListener('click',_c);
      }
    });
  },0);
}

// V0.4.52: 年度选择器自定义下拉面板（同月份方案）
function syncYearLabel(){
  var yEl=document.getElementById('wpYear');
  var lb=document.getElementById('wpYearLabel');
  if(yEl&&lb)lb.textContent=yEl.options[yEl.selectedIndex]?yEl.options[yEl.selectedIndex].text:(yEl.value+'年');
}
function toggleYearDropdown(){
  var existing=document.getElementById('__wpYearDD');
  if(existing){existing.remove();return;}
  var yEl=document.getElementById('wpYear');
  var trig=document.getElementById('wpYearTrigger');
  if(!yEl||!trig)return;
  var dd=document.createElement('div');
  dd.id='__wpYearDD';
  dd.className='wp-year-dropdown';
  dd.style.display='block';
  for(var i=0;i<yEl.options.length;i++){
    (function(opt){
      var odiv=document.createElement('div');
      odiv.className='wp-year-opt'+(opt.selected?' active':'');
      odiv.textContent=opt.text;
      odiv.onclick=function(){
        yEl.value=opt.value;
        syncYearLabel();
        dd.remove();
        onWPYearChange();
      };
      dd.appendChild(odiv);
    })(yEl.options[i]);
  }
  document.body.appendChild(dd);
  var cr=trig.getBoundingClientRect();
  dd.style.left=cr.left+'px';
  dd.style.top=(cr.bottom+4)+'px';
  dd.style.width=Math.max(cr.width,120)+'px';
  setTimeout(function(){
    document.addEventListener('click',function _c(e){
      if(!dd.contains(e.target)&&e.target!==trig&&!trig.contains(e.target)){
        dd.remove();document.removeEventListener('click',_c);
      }
    });
  },0);
}

function onWPDeptMemberChange(val){
  // ★ V0.6.1fc: 从重急合并视图点部门成员 → 重置标记，进入该成员正常周行动项
  _wpViewingMergedUrgent=false;
  _wpViewingMergedIndirect=false;
  var v=val||'';
  if(!v){switchToMyWP();return;}
  if(!val){switchToMyWP();return;}
  _wpViewingSubordinate=null;
  _wpViewingDeptMember=v;
  _wpRevisionMode=false;
  _wpCurrent={year:null,month:null,week:null,plan:null};
  loadWPData();
  renderWPUserInfo();
  renderWPSubSelect();
  showWPEmpty();
  onWPMonthChange();
  // ★ V0.6.1dk: 与年周度网格的"当前周"一致
  var yEl=document.getElementById('wpYear');
  var mEl=document.getElementById('wpMonth');
  var autoY=yEl?parseInt(yEl.value):new Date().getFullYear();
  var autoM=mEl?parseInt(mEl.value):(new Date().getMonth()+1);
  var dmNow=new Date();
  var dmCurrISO=getCurrentISOWeek();
  var dmMapped=isoWeekToMonthWeek(dmCurrISO.week);
  if(dmCurrISO.year!==autoY) dmMapped={month:1,week:1};
  setTimeout(function(){ try{selectWP(autoY,dmMapped.month,dmMapped.week);}catch(e){console.warn('auto-selectWP after deptMember change failed:',e);} }, 100);
}

function renderWPPlanList(year,month){
  var list=document.getElementById('wpPlanList');
  if(!list)return;
  var html='';
  var weekLabels=['第一周','第二周','第三周','第四周'];
  for(var w=1;w<=4;w++){
    var plan=getWP(year,month,w);
    var active=(_wpCurrent&&_wpCurrent.year===year&&_wpCurrent.month===month&&_wpCurrent.week===w);
    var taskCount=plan?plan.tasks.filter(function(t){return t.work;}).length:0;
    // 删除入口统一收敛至周行动项页面工具栏，导航仅负责周次切换。
    html+='<div class="wp-sidebar-plan-item'+(active?' active':'')+'" onclick="selectWP('+year+','+month+','+w+')"><div class="week-label">'+weekLabels[w-1]+'</div><div class="task-count">('+taskCount+')</div></div>';
  }
  list.innerHTML=html;
  // ★ V0.4.91s: 同步渲染全年周度导航网格
  renderWPYearGrid(year);
}

// ★ V0.4.91s: 全年53周快速导航网格
function _absWeek(y,m,w){
  var WEEKS=[4,4,5,4,4,5,4,4,5,4,4,5];
  var sum=0;
  for(var i=1;i<m;i++){sum+=WEEKS[i-1];}
  return sum+w;
}
function _fromAbsWeek(aw){
  var WEEKS=[4,4,5,4,4,5,4,4,5,4,4,5];
  // ★ V0.6.1fj: 处理第53周（年网格渲染53周，_fromAbsWeek必须能反向映射）
  if(aw>52)return{month:12,week:aw-47};
  if(aw<1)return{month:1,week:1};
  var month=1, week=aw;
  for(var i=0;i<12;i++){
    if(week<=WEEKS[i]){month=i+1;break;}
    week-=WEEKS[i];
  }
  return{month:month,week:week};
}

// ★ V0.5.8: 获取系统当前日期的ISO周数（用于年周度网格标识当前周）
function getISOWeek(date){
  var d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));
  d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));
  var yearStart=new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil(((d-yearStart)/86400000+1)/7);
}
function getCurrentISOWeek(){
  var d=new Date();
  var week=getISOWeek(d);
  return{year:d.getFullYear(),week:Math.max(1,week-1)};
}

// ★ V0.5.21: 月份切换时自动定位到该月1日对应的ISO周
function getFirstDayISOWeek(year,month){
  return getISOWeek(new Date(year,month-1,1));
}
function isoWeekToMonthWeek(isoWeek){
  var WEEKS=[4,4,5,4,4,5,4,4,5,4,4,5];
  var month=1, week=isoWeek;
  for(var i=0;i<12;i++){
    if(week<=WEEKS[i]){month=i+1;break;}
    week-=WEEKS[i];
  }
  if(month>12){month=12;week=Math.min(week,4);}
  return{month:month,week:week};
}

function renderWPYearGrid(year){
  var grid=document.getElementById('wpYearGrid');
  if(!grid)return;grid.style.display='block';
  // 收集全年各周数据状态
  var dataMap={};
  for(var m=1;m<=12;m++){
    for(var w=1;w<=4;w++){
      var p=getWP(year,m,w);
      if(p && p.tasks.some(function(t){return t.work;})) dataMap[_absWeek(year,m,w)]=true;
    }
  }
  // 当前选中的绝对周号
  var currAbs=null;
  if(_wpCurrent&&_wpCurrent.year===year) currAbs=_absWeek(year,_wpCurrent.month,_wpCurrent.week);
  // ★ V0.5.8: 系统当前周（基于真实日期）
  var nowInfo=getCurrentISOWeek();
  var sysWeek=(nowInfo.year===year)?nowInfo.week:null;
  // 构建网格
  var toggleIcon = _yearGridExpanded ? '▲' : '▼';
  var contentStyle = _yearGridExpanded ? 'transition:max-height 0.6s cubic-bezier(.25,.1,.25,1),opacity 0.6s cubic-bezier(.25,.1,.25,1);overflow:hidden' : 'transition:max-height 0.6s cubic-bezier(.25,.1,.25,1),opacity 0.6s cubic-bezier(.25,.1,.25,1);overflow:hidden;max-height:0;opacity:0';
  var html='<div class="wp-year-grid-title" onclick="toggleYearGrid()">'+year+'年全年周度 <span id="wpYearGridToggle" style="font-size:13px;color:#D9D9D9;cursor:pointer">'+toggleIcon+'</span></div>';
  html+='<div id="wpYearGridContent" style="'+contentStyle+'">';
  html+='<div class="wp-year-grid-grid">';
  for(var i=1;i<=53;i++){
    var cls='wp-yg-cell';
    if(i===currAbs)cls+=' active';
    if(i===sysWeek)cls+=' current-week';
    if(dataMap[i])cls+=' has-data';
    html+='<div class="'+cls+'" data-aw="'+i+'" title="第'+i+'周">'+i+'</div>';
  }
  html+='</div>';
  html+='</div>';
  grid.innerHTML=html;
  // 绑定点击事件
  setTimeout(function(){
    grid.querySelectorAll('.wp-yg-cell').forEach(function(cell){
      cell.onclick=function(){
        var aw=parseInt(cell.getAttribute('data-aw'));
        var mw=_fromAbsWeek(aw);
        // 切换月份下拉到目标月
        var mEl=document.getElementById('wpMonth');
        if(mEl){mEl.value=mw.month;syncMonthLabel();}
        selectWP(year,mw.month,mw.week);
      };
    });
  },10);
}

async function delWPFromSidebar(y,m,w){
  var p=getWP(y,m,w);
  var myName=(currentUser&&currentUser.name)||'';
  // ★ V0.6.1as: 删除安全机制——已提交/已锁定/已评价时禁止删除
  if(p && (p.submittedAt || p.summarySubmittedAt || (p.frozen && p.frozenBy && p.frozenBy !== myName) || p.bossEvaluated)){
    _showAlert('要删除本周行动项请先解除上级锁定或撤回提交周小结及周计划','⚠️ 无法删除',true);
    return;
  }
  var ok=await _showConfirm('确定删除 '+y+'年'+m+'月第'+w+'周的工作计划吗？\n\n此操作不可撤销。'+'\n\n—\n\n'+'Confirm deletion of Week '+w+', '+m+'/'+y+'?\n\nThis action cannot be undone.','注意 / Attention');
  if(!ok)return;
  deleteWP(y,m,w);
  if(_wpCurrent&&_wpCurrent.year===y&&_wpCurrent.month===m&&_wpCurrent.week===w){
    _wpCurrent={year:null,month:null,week:null,plan:null};
    showWPEmpty();
  }
  renderWPPlanList(y,m);
  renderWPUserInfo();
}

function selectWP(y,m,w){
  // ★ V0.6.1dn: 退出合并视图时清理残留 DOM
  _wpViewingMergedUrgent=false;
  _wpViewingMergedIndirect=false;
  _wpCurrent.mergedTasks=null;
  var content=document.getElementById('wpContent');
  if(content){
    var oldInfo=content.querySelector('.wp-info-bar.merged-urgent');if(oldInfo)oldInfo.remove();
    var oldToolbar=content.querySelector('.wp-toolbar.merged-urgent');if(oldToolbar)oldToolbar.remove();
  }
  _wpCurrent={year:y,month:m,week:w,plan:null};
  loadWPData();
  var plan=getWP(y,m,w);
  // ★ 确定当前正在查看的用户名（自己 or 下属 or 分享查看）
  var correctName=_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember||(currentUser&&currentUser.name)||'';
  // ★ 获取正在查看用户的正确部门/职位（自己 or 下属）
  var emp=getViewedUserEmp();
  var correctDept=emp?emp.dept:'';
  var correctPos=emp?emp.position:'';

  if(plan){
    // ★ 全面修复脏数据：name / dept / position 必须与当前查看用户一致
    var dirty=false;
    if(correctName && plan.name !== correctName){ plan.name = correctName; dirty=true; }
    if(correctDept && plan.dept !== correctDept){ plan.dept = correctDept; dirty=true; }
    if(correctPos && plan.position !== correctPos){ plan.position = correctPos; dirty=true; }
    if(_clearProblemPlaceholderData(plan))dirty=true;
    // ★ V0.1.59: 确保至少1行（旧数据可能只有0行）
    while(plan.tasks.length<1){
      plan.tasks.push({seq:plan.tasks.length+1,work:'',goal:'',startDate:'',plannedDate:'',actualDate:'',estimatedHours:'',status:'',supporters:'',problems:'',problemType:'',needBoss:'',bossFeedback:'',aiSuggestion:''});
      dirty=true;
    }
    if(dirty) saveWP(y,m,w,plan);
    _wpCurrent.plan=plan;
    // ★ V0.5.55: 自动清理旧数据中错误设置的 bossEvaluated（有值但无 bossEvaluatedAt）
    if(plan.bossEvaluated && !plan.bossEvaluatedAt){
      plan.bossEvaluated=false;
      saveWP(y,m,w,plan);
    }
    _autoCarryTasks(plan,y,m,w); // ★ V0.1.87b: 已有计划也尝试顺延(防旧代码空壳+首次部署遗漏)
    _calcWeekScore(plan); // ★ V0.4.91b: 选择周计划时重新计算状态
    renderWPTable(plan);
  }else{
    // ★ 自动创建空白周计划并渲染表单（用户无需手动点「新建周计划」）
    var newPlan=createEmptyPlan(y,m,w);
    if(correctName) newPlan.name = correctName;
    if(correctDept) newPlan.dept = correctDept;
    if(correctPos) newPlan.position = correctPos;
    saveWP(y,m,w,newPlan);
    _autoCarryTasks(newPlan,y,m,w); // ★ V0.1.87: 从上周自动顺延未完成任务
    _wpCurrent.plan=newPlan;
    renderWPTable(newPlan);
  }
  renderWPPlanList(y,m);
  renderWPUserInfo();
  // ★ V0.5.34: 选择周计划后同步刷新年周度网格高亮
  renderWPYearGrid(y);
}

function createNewWP(){
  // ★ V0.6.1fj: 直接 y/m/w +1，年末特殊处理 52→53→下年W1
  var y = (_wpCurrent && _wpCurrent.year) || parseInt(document.getElementById('wpYear').value)||new Date().getFullYear();
  var m = (_wpCurrent && _wpCurrent.month) || parseInt(document.getElementById('wpMonth').value)||(new Date().getMonth()+1);
  var w = (_wpCurrent && _wpCurrent.week) || 1;
  var newYear=y, newM, newW;
  if(m===12 && w===5){
    // 年末52周 → 虚拟53周（同年12月第6周）
    newYear=y; newM=12; newW=6;
  }else if(m===12 && w===6){
    // 虚拟53周 → 下年第1周
    newYear=y+1; newM=1; newW=1;
  }else{
    // 正常情况：ISO周+1
    var mw=_fromAbsWeek(_absWeek(y,m,w)+1);
    newM=mw.month; newW=mw.week; newYear=y;
  }
  // 跨年时自动添加年份 option
  var yEl = document.getElementById('wpYear');
  if (yEl && !Array.from(yEl.options).find(function(o){return parseInt(o.value)===newYear;})) {
    var newOpt = document.createElement('option');
    newOpt.value = String(newYear); newOpt.textContent = newYear + '年';
    yEl.appendChild(newOpt);
  }
  // 同步下拉框和标签
  if (yEl) yEl.value = String(newYear);
  var mEl = document.getElementById('wpMonth'); if (mEl) mEl.value = String(newM);
  var yLbl = document.getElementById('wpYearLabel'); if (yLbl) yLbl.textContent = newYear + '年';
  var mLbl = document.getElementById('wpMonthLabel'); if (mLbl) mLbl.textContent = newM + '月';
  // 找或建计划
  var plan = getWP(newYear, newM, newW);
  if (plan) {
    _wpCurrent = {year:newYear, month:newM, week:newW, plan:plan};
  } else {
    plan = createEmptyPlan(newYear, newM, newW);
    saveWP(newYear, newM, newW, plan);
    _autoCarryTasks(plan, newYear, newM, newW);
    _wpCurrent = {year:newYear, month:newM, week:newW, plan:plan};
  }
  renderWPPlanList(newYear, newM);
  renderWPTable(plan);
  renderWPUserInfo();
  if (typeof renderWPYearGrid === 'function') renderWPYearGrid(newYear);
}

function showWPEmpty(){
  var content=document.getElementById('wpContent');
  if(!content)return;
  var dd=document.getElementById('wpDefault');
  if(!dd)return;
  var tb=content.querySelector('#wpToolbar');
  var ta=content.querySelector('.wp-table-area');
  var ib=content.querySelector('.wp-info-bar');
  var sb=content.querySelector('.wp-summary-bar');
  var emp=content.querySelector('.wp-empty');
  if(tb)tb.remove();
  if(ta)ta.remove();
  if(ib)ib.remove();
  if(sb)sb.remove();
  if(emp)emp.remove();
  var sc=content.querySelector('.wp-scroll-area');if(sc)sc.remove();
  dd.style.display='flex';
}

// ★ V0.4.46: 状态彩色圆点渲染
function _renderStatusDot(status){
  if(!status) return '';
  // 兼容旧值映射
  var map={'✓完成':'按时完成','⚙推进中':'进行中','⏸暂停':'逾期完成','❌未完成':'未做'};
  var s=map[status]||status;
  var c=WP_STATUS_COLORS[s]||'#9ca3af';
  return '<span style="color:'+c+';font-size:10px;margin-right:4px">●</span>'+_h(s);
}

function renderWPCellValue(plan, fieldKey, originalValue){
  // ★ V0.6.1cf: 修订红色文字已取消 — 上级修改内容后不再以红色标注
  if(plan._revisions&&plan._revisions[fieldKey]&&plan._revisions[fieldKey].value){
    return _h(plan._revisions[fieldKey].value);
  }
  return _h(originalValue||'');
}

// ===== 渲染协同任务独立区域 =====
function _renderCollabTasksSection(plan){
  var collabTasks=[];
  if(plan&&plan.collab_tasks&&Array.isArray(plan.collab_tasks)){
    collabTasks=plan.collab_tasks;
    // ★ V0.6.1.ka: 过滤掉来自自己的协同任务 — 同时匹配 name + _uid + case-insensitive
    var myName=((currentUser&&currentUser.name)||'').toString().trim().toLowerCase();
    var myUid=((currentUser&&currentUser._uid)||'').toString().trim().toLowerCase();
    collabTasks=collabTasks.filter(function(ct){
      if(!ct)return false;
      var cfName=(ct.collab_from||'').toString().trim().toLowerCase();
      var cfUid=(ct.collab_from_uid||'').toString().trim().toLowerCase();
      // 排除: 协同人=自己(name 或 uid 任一匹配), 或没有 collab_from 字段(脏数据)
      if(!cfName&&!cfUid)return false;
      if(cfName&&cfName===myName)return false;
      if(cfUid&&cfUid===myUid)return false;
      return true;
    });
    // ★ V0.1.34: 按 collab_from+work 内容去重
    var seen={};
    collabTasks=collabTasks.filter(function(ct){
      if(!ct||!ct.work)return false;
      var key=(ct.collab_from||'')+'|'+ct.work;
      if(seen[key])return false;
      seen[key]=true;
      return true;
    });
  }

  var html='';
  // ★ 用 table 作为最外层 — table 默认 display:table 不会被 flex 压缩成0高度
  html+='<table id="collabTaskArea" cellspacing="0" cellpadding="0" style="width:100%;margin:20px 0 0 0;border:2px solid #f59e0b;border-radius:8px;background:#fffbeb;border-spacing:0">';
  // header 行
  html+='<tr><td style="padding:12px 16px;background:#fef3c7;border-bottom:2px solid #f59e0b">';
  html+='<div style="display:flex;align-items:center;justify-content:space-between">';
  html+='<span style="font-size:14px;color:#0F2C4B;font-weight:600">🤝 协同任务</span>';
  if(collabTasks.length>0){
    html+='<span style="font-size:12px;color:#b45309;background:#fde68a;padding:2px 8px;border-radius:10px;font-weight:600">'+collabTasks.length+' 项</span>';
  }
  html+='</div></td></tr>';

  // 内容行
  html+='<tr><td style="padding:0">';
  if(collabTasks.length===0){
    html+='<div style="padding:28px;text-align:center;color:#9ca3af;font-size:14px;font-weight:500">📭 本周暂无协同任务</div>';
  }else{
    html+='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#fff">';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">序号</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">来自</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;border-bottom:1px solid #f59e0b">协同工作内容</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">优先级</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">计划完成日期</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">实际完成日期</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">协同状态</th>';
    html+='<th style="padding:10px 8px;text-align:left;color:#92400e;font-weight:600;font-size:11px;white-space:nowrap;border-bottom:1px solid #f59e0b">操作</th>';
    html+='</tr></thead><tbody>';
    for(var i=0;i<collabTasks.length;i++){
      var ct=collabTasks[i];
      var pri=ct.goal||'';
      var priStyle=pri==='重要紧急'?'background:#FF3B30;color:#fff':pri==='重要不急'?'background:#007AFF;color:#fff':pri==='日常紧急'?'background:#FF9500;color:#fff':pri==='日常事项'?'background:#5E7080;color:#fff':'background:#9ca3af;color:#fff';
      var st=ct.status||'pending';
      var stText=st==='accepted'?'已接受':st==='rejected'?'已拒绝':'待响应';
      var stColor=st==='accepted'?'#16a34a':st==='rejected'?'#dc2626':'#9ca3af';
      html+='<tr>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle">'+(i+1)+'</td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:#6366f1">'+_h(ct.collab_from||'')+'</span></td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle">'+_h(ct.work||'(无任务描述)')+'</td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle">'+(pri?'<span style="'+priStyle+';padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600">'+_h(pri)+'</span>':'')+'</td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle;white-space:nowrap">'+_h(ct.plannedDate||'')+'</td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle;white-space:nowrap">'+_h(ct.actualDate||'')+'</td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle"><span style="color:'+stColor+';font-weight:600;font-size:11px">'+stText+'</span></td>';
      html+='<td style="padding:10px 8px;border-bottom:1px solid #fef3c7;vertical-align:middle"><div style="display:flex;gap:4px;flex-wrap:wrap">';
      if(st==='accepted'){
        html+='<button onclick="_collabRespond(this)" data-args="'+_h(ct.collab_from_uid||'')+'|'+_h(ct.collab_req_id||'')+'|'+i+'" data-status="pending" style="padding:3px 8px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:#f5f5f5;color:#666;border:1px solid #ddd">撤销接受</button>';
      }else if(st==='rejected'){
        html+='<button onclick="_collabRespond(this)" data-args="'+_h(ct.collab_from_uid||'')+'|'+_h(ct.collab_req_id||'')+'|'+i+'" data-status="pending" style="padding:3px 8px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:#f5f5f5;color:#666;border:1px solid #ddd">重新考虑</button>';
      }else{
        html+='<button onclick="_collabRespond(this)" data-args="'+_h(ct.collab_from_uid||'')+'|'+_h(ct.collab_req_id||'')+'|'+i+'" data-status="accepted" style="padding:3px 8px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:#16a34a;color:#fff">✅ 接受</button>';
        html+='<button onclick="_collabRespond(this)" data-args="'+_h(ct.collab_from_uid||'')+'|'+_h(ct.collab_req_id||'')+'|'+i+'" data-status="rejected" style="padding:3px 8px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:#dc2626;color:#fff">❌ 拒绝</button>';
        html+='<button onclick="_collabRespond(this)" data-args="'+_h(ct.collab_from_uid||'')+'|'+_h(ct.collab_req_id||'')+'|'+i+'" data-status="pending" style="padding:3px 8px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:#f5f5f5;color:#666;border:1px solid #ddd">⏸ 待定</button>';
      }
      html+='</div></td>';
      html+='</tr>';
    }
    html+='</tbody></table></div>';
  }
  html+='</td></tr></table>';
  return html;
}

// ===== 协同任务系统（第2步：发起方写入 + 接收方读取）=====

// ★ V0.6.1.j84: 通用占位符文字清洗 — 仅清洗"协同人"chip 编辑器污染的 UI 文字
// 之前 j83 包含"无"导致误伤真实数据（如"无资源"→"资源"），已撤掉
var WP_PLACEHOLDER_TEXT = /协同人|⏳|待响应|已接受|已拒绝|✅|❌/gi;
function _cleanPlaceholderText(val){
  if(!val)return '';
  return String(val).replace(WP_PLACEHOLDER_TEXT,'').replace(/^[,，;；、\s]+|[,，;；、\s]+$/g,'').trim();
}

// “填写”是问题列的默认提示，不是用户输入。仅精确匹配时才清空，避免误伤真实内容。
function _normalizeProblemPlaceholder(val){
  return typeof val==='string'&&val.trim()==='填写'?'':val;
}
function _clearProblemPlaceholderData(plan){
  if(!plan||!Array.isArray(plan.tasks))return false;
  var changed=false;
  for(var i=0;i<plan.tasks.length;i++){
    var task=plan.tasks[i];
    if(task&&typeof task.problems==='string'&&task.problems.trim()==='填写'){
      task.problems='';
      changed=true;
    }
    var fieldKey='tasks.'+i+'.problems';
    if(plan._revisions&&plan._revisions[fieldKey]&&typeof plan._revisions[fieldKey].value==='string'&&plan._revisions[fieldKey].value.trim()==='填写'){
      delete plan._revisions[fieldKey];
      changed=true;
    }
  }
  return changed;
}

// 解析 supporters 字符串为结构化数组 [{uid,name,dept,status}]
function _parseSupporters(s){
  if(!s)return [];
  if(Array.isArray(s))return s;
  var parts=String(s).split(/[,，;；、\s]+/).map(function(p){return p.trim();}).filter(Boolean);
  var result=[];
  for(var i=0;i<parts.length;i++){
    var p=parts[i];
    var uid='';
    if(typeof USERS!=='undefined'){
      for(var uk in USERS){if(USERS[uk].name===p){uid=uk;break;}}
    }
    result.push({uid:uid,name:p,dept:'',status:'pending'});
  }
  return result;
}

// ★ 渲染协同人单元格（含响应状态徽章）— 发起方视角
function _renderSupportersCell(plan,taskIndex,rawSupporters){
  // ★ V0.3.71: 优先使用上级修订值（如有）
  var fieldKey='tasks.'+taskIndex+'.supporters';
  var displayVal=rawSupporters;
  if(plan._revisions&&plan._revisions[fieldKey]&&plan._revisions[fieldKey].value){
    displayVal=plan._revisions[fieldKey].value;
  }
  // ★ j83: 使用通用清洗函数，去除历史脏数据中保存的占位符文字
  displayVal=_cleanPlaceholderText(displayVal);
  if(!displayVal)return '<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">协同人</span>';
  var sups=_parseSupporters(displayVal);
  if(sups.length===0)return '<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">协同人</span>';
  // 检查是否有协同状态信息
  var hasStatuses=plan._collab_statuses&&Object.keys(plan._collab_statuses).length>0;
  // ★ V0.6.1cf: 修订红色文字已取消
  var revPrefix='';
  if(plan._revisions&&plan._revisions[fieldKey]&&plan._revisions[fieldKey].value){
    var rev=plan._revisions[fieldKey];
    revPrefix='<span title="原值：'+_h(rawSupporters||'')+'&#10;修订人：'+_h(rev.by||'')+'&#10;时间：'+_h(rev.at||'')+'">';
  }
  var revSuffix=revPrefix?'</span>':'';
  // ★ V0.3.118: 始终显示协同状态徽章（无状态数据时默认"待响应"）
  var html='<div style="display:flex;flex-direction:column;gap:2px;width:100%">';
  for(var i=0;i<sups.length;i++){
    var s=sups[i];
    var st='pending';
    if(hasStatuses){
      var statusKey=taskIndex+'_'+s.uid;
      st=plan._collab_statuses[statusKey]||'pending';
    }
    var badgeColor='',badgeIcon='',badgeText='';
    if(st==='accepted'){badgeColor='#16a34a';badgeIcon='✅';badgeText='已接受';}
    else if(st==='rejected'){badgeColor='#dc2626';badgeIcon='❌';badgeText='已拒绝';}
    else{badgeColor='#9ca3af';badgeIcon='⏳';badgeText='待响应';}
    // ★ V0.6.1.gn: 姓名左对齐 + 徽章右对齐（flex space-between）
    html+='<div style="display:flex;align-items:center;justify-content:space-between;gap:4px">';
    html+='<span style="font-weight:500;text-align:left">'+_h(s.name)+'</span>';
    html+='<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:'+badgeColor+';color:#fff;font-weight:600;line-height:1.4;white-space:nowrap">'+badgeIcon+' '+badgeText+'</span>';
    html+='</div>';
  }
  html+='</div>';
  return revPrefix+html+revSuffix;
}

// 获取员工档案库（allEmployees 优先，兜底 __PRELOADED_EMPLOYEES__）
function _getEmpDB(){
  if(typeof allEmployees!=='undefined'&&allEmployees&&allEmployees.length>0)return allEmployees;
  if(window.__PRELOADED_EMPLOYEES__&&window.__PRELOADED_EMPLOYEES__.length>0)return window.__PRELOADED_EMPLOYEES__;
  return [];
}

// ★ V0.6.1.gj: 刷新协同人 datalist — 从 allEmployees 动态生成立即可用
function _refreshEmpDatalist(){
  var dl=document.getElementById('empDatalist');
  if(!dl){
    dl=document.createElement('datalist');
    dl.id='empDatalist';
    document.body.appendChild(dl);
  }
  var emps=_getEmpDB();
  if(emps.length===0)return;
  var names=[]; var seen={};
  for(var i=0;i<emps.length;i++){
    var n=emps[i].name||emps[i]['姓名'];
    if(n&&!seen[n]){seen[n]=true;names.push(n);}
  }
  dl.innerHTML=names.map(function(n){return '<option value="'+_h(n)+'">';}).join('');
  console.log('[V0.6.1.gj] empDatalist refreshed: '+names.length+' names');
}

// 生成协同任务的唯一 ID
function _collabReqId(fromUid,weekId,taskSeq,supporterUid){
  return fromUid+'_'+weekId+'_'+taskSeq+'_'+supporterUid;
}

// 生成 week_id（与 makeWPId 格式一致）
function _collabWeekId(year,month,week){return year+'-'+('0'+month).slice(-2)+'-W'+week;}

// ★ 核心函数：发起方保存周计划后，只把含协同人的那一条任务同步到接收方的 collab_tasks[]
// 关键修复：绝不复制整个周计划，只追加一条协同任务到 collab_tasks[]
async function _syncCollabTasks(plan,fromName,year,month,week){
  if(!plan||!plan.tasks||typeof supabase==='undefined'||!supabase)return;
  var weekId=_collabWeekId(year,month,week);
  var fromUid=(currentUser&&currentUser._uid)||fromName;
  var fromDept=(currentUser&&currentUser._dept)||'';
  console.log('[Collab] 开始同步协同任务 from='+fromName+' week='+weekId);

  // 收集当前所有有效的协同请求 ID（用于清理已撤回的）
  var activeReqIds={};

  for(var i=0;i<plan.tasks.length;i++){
    var t=plan.tasks[i];
    if(!t.supporters)continue;
    var sups=_parseSupporters(t.supporters);
    for(var j=0;j<sups.length;j++){
      var s=sups[j];
      // ★ 严格检查：s.uid 必须非空，否则跳过（防止 PostgREST 忽略空值返回全表）
      if(!s.uid||s.uid===fromUid){
        console.log('[Collab] 跳过协同人:',s.name,'(uid为空或为自己)');
        continue;
      }

      var reqId=_collabReqId(fromUid,weekId,i,s.uid);
      activeReqIds[reqId]=true;

      try{
        // ★ 读取接收方的周计划 - 同时查 username 字段用于验证
        var resp=await supabase.from(SUPABASE_WP_TABLE)
          .select('username,week_id,plan_data')
          .eq('username',s.uid)
          .eq('week_id',weekId)
          .limit(1);

        var receiverPlan=null;
        var receiverExists=false;
        if(resp.data&&resp.data.length>0){
          // ★ 验证返回的 username 确实等于 s.uid（防止 PostgREST 空值问题）
          if(resp.data[0].username!==s.uid){
            console.warn('[Collab] username 不匹配! 期望:'+s.uid+' 实际:'+resp.data[0].username+'，跳过');
            continue;
          }
          receiverPlan=resp.data[0].plan_data;
          receiverExists=true;
        }

        // ★ 如果接收方没有这一周的周计划，新建一个空壳（tasks 必须为空数组！）
        if(!receiverPlan||!receiverPlan.tasks||!Array.isArray(receiverPlan.tasks)){
          receiverPlan={
            year:year,
            month:month,
            week:week,
            name:s.name,
            dept:s.dept||'',
            tasks:[],          // ★ 必须空数组，绝不引用发起方的 tasks！
            collab_tasks:[],
            aiAnalysis:'',weekSummary:'',
            createdAt:new Date().toISOString(),
            updatedAt:new Date().toISOString()
          };
          console.log('[Collab] 为 '+s.name+' 自动新建空壳周计划 '+weekId+' (tasks为空)');
        }

        // 确保 collab_tasks 数组存在
        if(!receiverPlan.collab_tasks||!Array.isArray(receiverPlan.collab_tasks)){
          receiverPlan.collab_tasks=[];
        }

        // ★ 查找是否已有此协同任务（按 reqId 匹配）
        var foundIdx=-1;
        for(var k=0;k<receiverPlan.collab_tasks.length;k++){
          if(receiverPlan.collab_tasks[k].collab_req_id===reqId){foundIdx=k;break;}
        }

        // ★ 只构造这一条协同任务（绝不复制整个周计划）
        var collabTask={
          collab_req_id:reqId,
          collab_from_uid:fromUid,
          collab_from:fromName,
          collab_from_dept:fromDept,
          collab_owner_task_seq:i,
          collab_week_id:weekId,
          work:t.work||'',
          goal:t.goal||'',
          plannedDate:t.plannedDate||'',
          actualDate:'',
          status:'pending'
        };

        if(foundIdx>=0){
          // 更新任务内容，但保留接收方已填写的 actualDate 和响应 status
          var existing=receiverPlan.collab_tasks[foundIdx];
          collabTask.actualDate=existing.actualDate||'';
          collabTask.status=existing.status||'pending';
          receiverPlan.collab_tasks[foundIdx]=collabTask;
          console.log('[Collab] 更新 '+s.name+' 的协同任务 (reqId='+reqId+')');
        }else{
          receiverPlan.collab_tasks.push(collabTask);
          console.log('[Collab] 追加1条协同任务到 '+s.name+' 的 '+weekId+' (reqId='+reqId+')');
        }

        // ★ 保存回 Supabase - 只更新这一个周计划
        receiverPlan.updatedAt=new Date().toISOString();
        var upsertResult=await supabase.from(SUPABASE_WP_TABLE)
          .upsert([{username:s.uid,week_id:weekId,plan_data:receiverPlan,updated_at:new Date().toISOString()}],{onConflict:'username,week_id'});

        if(upsertResult.error){
          console.error('[Collab] 保存到 '+s.name+' 失败:',upsertResult.error.message);
        }else{
          console.log('[Collab] ✅ 成功保存协同任务到 '+s.name+' 的 '+weekId);
        }
      }catch(e){
        console.warn('[Collab] syncCollab for',s.name,'failed',e.message);
      }
    }
  }

  // 清理已撤回的协同任务：扫描本周所有接收计划，而非只扫描当前仍在 supporters 里的员工。
  // 否则 A 删除 B 这个协同人后，B 不再出现在当前名单中，旧协同任务就永远无法被清理。
  try{
    var cleanupResp=await supabase.from(SUPABASE_WP_TABLE).select('username,plan_data').eq('week_id',weekId);
    if(cleanupResp.error)throw cleanupResp.error;
    for(var i2=0;i2<(cleanupResp.data||[]).length;i2++){
      var cleanupRow=cleanupResp.data[i2], rp=cleanupRow.plan_data;
      if(!rp||!Array.isArray(rp.collab_tasks))continue;
      var beforeCount=rp.collab_tasks.length;
      rp.collab_tasks=rp.collab_tasks.filter(function(ct){
        return !(ct&&ct.collab_from_uid===fromUid&&ct.collab_req_id&&!activeReqIds[ct.collab_req_id]);
      });
      if(rp.collab_tasks.length===beforeCount)continue;
      rp.updatedAt=new Date().toISOString();
      var cleanupSave=await supabase.from(SUPABASE_WP_TABLE)
        .upsert([{username:cleanupRow.username,week_id:weekId,plan_data:rp,updated_at:rp.updatedAt}],{onConflict:'username,week_id'});
      if(cleanupSave.error)throw cleanupSave.error;
      console.log('[Collab] 已清理 '+(beforeCount-rp.collab_tasks.length)+' 条撤回协同任务，接收方='+cleanupRow.username);
    }
  }catch(e){
    console.warn('[Collab] 清理撤回协同任务失败:',e.message);
  }
  // ★ 初始化发起方自己的 _collab_statuses（在 Supabase 中），供接收方响应时回写
  try{
    var initResp=await supabase.from(SUPABASE_WP_TABLE)
      .select('plan_data')
      .eq('username',fromUid)
      .eq('week_id',weekId)
      .limit(1);
    if(initResp.data&&initResp.data.length>0){
      var initPlan=initResp.data[0].plan_data;
      if(!initPlan._collab_statuses){initPlan._collab_statuses={};}
      var initChanged=false;
      for(var i3=0;i3<plan.tasks.length;i3++){
        var t3=plan.tasks[i3];
        if(!t3.supporters)continue;
        var sups3=_parseSupporters(t3.supporters);
        for(var j3=0;j3<sups3.length;j3++){
          var s3=sups3[j3];
          if(!s3.uid||s3.uid===fromUid)continue;
          var statusKey=i3+'_'+s3.uid;
          if(!initPlan._collab_statuses.hasOwnProperty(statusKey)){
            initPlan._collab_statuses[statusKey]='pending';
            initChanged=true;
          }
        }
      }
      // 清理已不存在的协同人状态
      var activeKeys={};
      for(var i4=0;i4<plan.tasks.length;i4++){
        var t4=plan.tasks[i4];
        if(!t4.supporters)continue;
        var sups4=_parseSupporters(t4.supporters);
        for(var j4=0;j4<sups4.length;j4++){
          var s4=sups4[j4];
          if(!s4.uid||s4.uid===fromUid)continue;
          activeKeys[i4+'_'+s4.uid]=true;
        }
      }
      for(var key in initPlan._collab_statuses){
        if(!activeKeys[key]){delete initPlan._collab_statuses[key];initChanged=true;}
      }
      if(initChanged){
        initPlan.updatedAt=new Date().toISOString();
        await supabase.from(SUPABASE_WP_TABLE)
          .upsert([{username:fromUid,week_id:weekId,plan_data:initPlan,updated_at:new Date().toISOString()}],{onConflict:'username,week_id'});
        console.log('[Collab] 已初始化发起方 _collab_statuses ('+Object.keys(initPlan._collab_statuses).length+' 条)');
      }
    }
  }catch(e){console.warn('[Collab] 初始化 _collab_statuses 失败',e.message);}
  console.log('[Collab] 同步完成，共处理 '+Object.keys(activeReqIds).length+' 个有效协同请求');
}

// 协同响应 wrapper（第2步：更新本地 + 第3步：回写发起方 Supabase）
async function _collabRespond(btn){
  var parts=(btn.getAttribute('data-args')||'').split('|');
  if(parts.length<3)return;
  var fromUid=parts[0];
  var reqId=parts[1];
  var newStatus=btn.getAttribute('data-status')||'pending';

  if(!_wpCurrent||!_wpCurrent.plan){
    showToast('⚠️ 未找到周计划数据,请稍后再试');
    return;
  }
  if(!_wpCurrent.plan.collab_tasks||!Array.isArray(_wpCurrent.plan.collab_tasks)){
    // ★ 极端边界:collab_tasks 数组被破坏时尝试初始化
    _wpCurrent.plan.collab_tasks=[];
  }
  // ★ V0.6.1.kc: 用 reqId 查找任务,不再依赖 index(防多设备同步后数组顺序变化导致点不到)
  var ct=null;
  var realIdx=-1;
  for(var k=0;k<_wpCurrent.plan.collab_tasks.length;k++){
    if(_wpCurrent.plan.collab_tasks[k]&&_wpCurrent.plan.collab_tasks[k].collab_req_id===reqId){
      ct=_wpCurrent.plan.collab_tasks[k];
      realIdx=k;
      break;
    }
  }
  if(!ct){
    showToast('⚠️ 协同任务不匹配(reqId='+reqId+'),已尝试重新加载...');
    // ★ 自愈:数据被外部清空,主动拉云端最新
    setTimeout(function(){try{loadWPData();}catch(e){}},500);
    return;
  }
  // 更新本地状态
  ct.status=newStatus;
  _wpCurrent.plan.collab_tasks[realIdx]=ct;
  // 保存到 localStorage
  try{saveWPData();}catch(e){console.warn('[Collab] saveWPData failed',e);}
  // 刷新表格（协同区域会重新渲染）
  renderWPTable(_wpCurrent.plan);
  // 提示
  if(newStatus==='accepted')showToast('✅ 已接受协同任务');
  else if(newStatus==='rejected')showToast('❌ 已拒绝协同任务');
  else showToast('⏸ 已标记待定');
  console.log('[Collab] 响应协同任务 reqId='+reqId+' status='+newStatus);

  // ★ 第3步：同步响应状态到 Supabase（发起方加载时自动读取）
  _collabRespondSyncToCloud(ct,newStatus,fromUid,reqId).catch(function(e){
    console.warn('[Collab] 云端响应同步失败',e.message);
  });
}

// ★ 第3步实现：接收方响应 → 保存到 Supabase → 回写发起方 plan 的 _collab_statuses
async function _collabRespondSyncToCloud(ct,newStatus,fromUid,reqId){
  if(typeof supabase==='undefined'||!supabase)return;
  var now=new Date().toISOString();
  var myUid=(currentUser&&currentUser._uid)||getCurrentEmployee().name;

  // ① 保存接收方（自己）的周计划到 Supabase
  if(_wpCurrent&&_wpCurrent.plan){
    var wpId=_collabWeekId(_wpCurrent.year,_wpCurrent.month||(new Date().getMonth()+1),_wpCurrent.week||1);
    _wpCurrent.plan.updatedAt=now;
    var selfResult=await supabase.from(SUPABASE_WP_TABLE)
      .upsert([{username:myUid,week_id:wpId,plan_data:_wpCurrent.plan,updated_at:now}],{onConflict:'username,week_id'});
    if(selfResult.error){
      console.error('[Collab] 保存自身周计划失败:',selfResult.error.message);
    }else{
      console.log('[Collab] ✅ 自身周计划已同步到 Supabase');
    }
  }

  // ② 更新发起方的 _collab_statuses（在发起方 plan_data 中）
  //    key 格式: taskSeq_supporterUid → status
  var ownerTaskSeq=ct.collab_owner_task_seq;
  var weekId=ct.collab_week_id||reqId.split('_')[1]||'';
  if(!weekId||!fromUid||ownerTaskSeq===undefined){
    console.warn('[Collab] 缺少回写信息: weekId='+weekId+' fromUid='+fromUid+' taskSeq='+ownerTaskSeq);
    return;
  }

  try{
    // 读取发起方的周计划
    var initResp=await supabase.from(SUPABASE_WP_TABLE)
      .select('plan_data')
      .eq('username',fromUid)
      .eq('week_id',weekId)
      .limit(1);

    if(!initResp.data||initResp.data.length===0){
      console.log('[Collab] 发起方周计划不存在，跳过回写');
      return;
    }
    var initPlan=initResp.data[0].plan_data;
    if(!initPlan){return;}

    // 确保 _collab_statuses 存在
    if(!initPlan._collab_statuses){initPlan._collab_statuses={};}
    var statusKey=ownerTaskSeq+'_'+myUid;
    initPlan._collab_statuses[statusKey]=newStatus;
    initPlan.updatedAt=now;

    // 写回发起方的 Supabase
    var updateResult=await supabase.from(SUPABASE_WP_TABLE)
      .upsert([{username:fromUid,week_id:weekId,plan_data:initPlan,updated_at:now}],{onConflict:'username,week_id'});

    if(updateResult.error){
      console.error('[Collab] 回写发起方失败:',updateResult.error.message);
    }else{
      console.log('[Collab] ✅ 已回写发起方 '+fromUid+' 的 _collab_statuses['+statusKey+']='+newStatus);
    }
  }catch(e){
    console.warn('[Collab] 回写发起方异常:',e.message);
  }
}

// ★ V0.1.49: 渲染任务积分单元格
function _renderTaskScoreCell(plan,taskIdx){
  var tt=plan.tasks[taskIdx];
  if(!tt)return '<td class="col-score" style="text-align:center;font-size:12px;color:#9ca3af">—</td>';

  // ★ V0.4.91: 无实际日期但有计划日期+优先级 → 按计分规则算出pts
  var pts=0;
  if(plan._taskScores&&typeof plan._taskScores[taskIdx]!=='undefined'){
    pts=plan._taskScores[taskIdx]||0;
  }
  // 如果没有taskScore（比如还没调用过_calcWeekScore），回退到显示"—"
  if(!plan._taskScores||plan._taskScores.length<=taskIdx){
    return '<td class="col-score" style="text-align:center;font-size:12px;color:#9ca3af">—</td>';
  }

  if(pts===0&&tt.status==='暂停中'){
    return '<td class="col-score" style="text-align:center;font-size:12px;color:#9ca3af">—</td>';
  }
  if(pts===0&&tt.status==='未做'&&tt._manualNotDone){
    return '<td class="col-score" style="text-align:center;font-size:12px;color:#9ca3af">0</td>';
  }
  if(pts===0){
    return '<td class="col-score" style="text-align:center;font-size:12px;color:#9ca3af">—</td>';
  }

  var scLabel=pts>0?'+'+pts:''+pts;
  return '<td class="col-score" style="text-align:center;font-size:12px;font-weight:600;color:#2A476A">'+scLabel+'</td>';
}

// ★ V0.1.59: 渲染 # 操作列（序号 + +/- 按钮）
function _renderTaskOpCell(taskIdx,seq,plan){
  var isFrozen=plan.frozen&&!_wpViewingSubordinate&&!_wpViewingDeptMember;
  var isCollab=!!plan.tasks[taskIdx].collab_from;
  var isLast=taskIdx===plan.tasks.length-1;
  var total=plan.tasks.length;

  // 锁定状态：序号前加🔒图标
  if(isFrozen)return '<td class="col-num" style="text-align:center"><span style="display:inline-flex;align-items:center;gap:2px"><span style="font-size:11px;color:#3b82f6">🔒</span><span style="font-size:11px;line-height:1">'+seq+'</span></span></td>';

  var btns='';
  // + 添加按钮：所有行都显示（总数<15，非协同）
  if(total<15 && !isCollab){
    btns+='<span onclick="event.stopPropagation();addTaskRow('+taskIdx+')" style="display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;background:#3498db;color:#fff;font-size:12px;font-weight:bold;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.15);user-select:none" title="在此后添加一行">+</span>';
  }
  // ★ V0.6.1dv: − 按钮：所有非协同行都显示
  // total>1 时为删除整行；total=1 时为清空该行所有字段
  if(!isCollab){
    var isOnlyOne=total===1;
    var minusTitle=isOnlyOne?'清空该行所有字段（保留行结构）':'删除此行';
    btns+='<span onclick="event.stopPropagation();'+(isOnlyOne?'clearTaskRow('+taskIdx+')':'deleteTaskRow('+taskIdx+')')+'" style="display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;background:#9ca3af;color:#fff;font-size:12px;font-weight:bold;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.15);user-select:none;margin-top:2px" title="'+minusTitle+'">−</span>';
  }

  // ★ V0.3.70: 序号列垂直排列 — 序号在上，+号居中，-号在下
  var dragCls=(!isFrozen&&!isCollab)?' drag-handle':'';
  var html='<div style="display:flex;flex-direction:column;align-items:center;gap:1px;padding:2px 0">';
  html+='<span style="font-size:11px;line-height:1">'+seq+'</span>';
  if(btns)html+=btns;
  html+='</div>';
  return '<td class="col-num'+dragCls+'" style="text-align:center;padding:2px 4px;vertical-align:middle" draggable="true">'+html+'</td>';
}

// ★ V0.5.67: 拖拽排序 — 核心拖拽逻辑
var _wpDragIdx=-1;
function _onWPDragStart(e){
  var cell=e.target.closest('td.col-num.drag-handle');
  if(!cell)return;
  var tr=cell.closest('tr');
  if(!tr)return;
  var idx=parseInt(tr.getAttribute('data-task-idx'));
  if(isNaN(idx))return;
  _wpDragIdx=idx;
  tr.classList.add('wp-row-dragging');
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',''+idx);
}
function _onWPDragEnd(e){
  var trs=document.querySelectorAll('.wp-table tbody tr');
  for(var i=0;i<trs.length;i++)trs[i].classList.remove('wp-row-dragging','wp-row-drag-over');
  _wpDragIdx=-1;
}
function _onWPDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
  var tr=e.target.closest('tr');
  if(!tr)return;
  var idx=parseInt(tr.getAttribute('data-task-idx'));
  if(isNaN(idx)||idx===_wpDragIdx)return;
  // 清除之前的标记
  var trs=document.querySelectorAll('.wp-table tbody tr.wp-row-drag-over');
  for(var i=0;i<trs.length;i++)trs[i].classList.remove('wp-row-drag-over');
  tr.classList.add('wp-row-drag-over');
}
function _onWPDragLeave(e){
  var tr=e.target.closest('tr');
  if(!tr)return;
  tr.classList.remove('wp-row-drag-over');
}
function _onWPDrop(e){
  e.preventDefault();
  var tr=e.target.closest('tr');
  if(!tr)return _onWPDragEnd(e);
  var toIdx=parseInt(tr.getAttribute('data-task-idx'));
  if(isNaN(toIdx)||toIdx===_wpDragIdx)return _onWPDragEnd(e);
  // 检查目标是否为协作/转入任务行
  var p=_wpCurrent.plan;if(!p)return _onWPDragEnd(e);
  if(toIdx>=0&&toIdx<p.tasks.length&&p.tasks[toIdx]){
    if(p.tasks[toIdx].collab_from){_onWPDragEnd(e);showToast('⚠️ 协作任务位置不可拖拽');return;}
    if(p.tasks[toIdx].carriedFrom){_onWPDragEnd(e);showToast('⚠️ 上周转入任务位置不可拖拽');return;}
  }
  reorderTasks(_wpDragIdx,toIdx);
  _onWPDragEnd(e);
}
function reorderTasks(fromIdx,toIdx){
  var p=_wpCurrent.plan;if(!p)return;
  var tasks=p.tasks;
  if(fromIdx<0||fromIdx>=tasks.length||toIdx<0||toIdx>=tasks.length)return;
  if(tasks[fromIdx]&&tasks[fromIdx].collab_from)return;
  var moved=tasks.splice(fromIdx,1)[0];
  // 调整插入索引：如果 from < to，splice 后 to 已经前移了一位
  var insertAt=fromIdx<toIdx?toIdx:toIdx;
  tasks.splice(insertAt,0,moved);
  for(var i=0;i<tasks.length;i++)tasks[i].seq=i+1;
  saveWP(p.year,p.month,p.week,p);
  renderWPTable(p);
  showToast('✅ 已调整次序');
}
// ★ V0.5.67: 在 renderWPTable 后自动绑定拖拽事件
function _bindWPDragEvents(){
  var tbodies=document.querySelectorAll('.wp-table tbody');
  for(var bi=0;bi<tbodies.length;bi++){
    var tb=tbodies[bi];
    tb.removeEventListener('dragstart',_onWPDragStart);
    tb.removeEventListener('dragend',_onWPDragEnd);
    tb.removeEventListener('dragover',_onWPDragOver);
    tb.removeEventListener('dragleave',_onWPDragLeave);
    tb.removeEventListener('drop',_onWPDrop);
    tb.addEventListener('dragstart',_onWPDragStart);
    tb.addEventListener('dragend',_onWPDragEnd);
    tb.addEventListener('dragover',_onWPDragOver);
    tb.addEventListener('dragleave',_onWPDragLeave);
    tb.addEventListener('drop',_onWPDrop);
  }
}

// ★ V0.1.59: 在指定行后新增一行
function addTaskRow(afterIdx){
  var p=_wpCurrent.plan;if(!p)return;
  var tasks=p.tasks;
  // ★ V0.1.89: 上限从8改为15，与 _renderTaskOpCell 中的显示逻辑一致
  if(tasks.length>=15){showToast('⚠️ 最多15项工作任务');return;}
  tasks.splice(afterIdx+1,0,{seq:0,work:'',goal:'',plannedDate:'',actualDate:'',estimatedHours:'',status:'',supporters:'',problems:'',problemType:'',needBoss:'',bossFeedback:'',aiSuggestion:''});
  // 重新编号
  for(var i=0;i<tasks.length;i++)tasks[i].seq=i+1;
  saveWP(p.year,p.month,p.week,p);
  renderWPTable(p);
  showToast('✅ 已添加新行');
}

async function deleteTaskRow(idx){
  var p=_wpCurrent.plan;if(!p)return;
  var tasks=p.tasks;
  if(tasks.length<=1){showToast('⚠️ 至少保留一行工作计划');return;}
  // ★ V0.3.109: 防御性校验 — idx 越界保护
  if(idx<0||idx>=tasks.length){console.error('[deleteTaskRow] invalid idx='+idx+', tasks.length='+tasks.length);showToast('⚠️ 索引越界，无法删除');return;}
  var t=tasks[idx];
  if(!t){console.error('[deleteTaskRow] tasks['+idx+'] is empty/undefined');showToast('⚠️ 目标行为空，无法删除');return;}
  if(t.collab_from){showToast('⚠️ 协同任务不能删除');return;}
  var taskLabel=(t.work||'第'+(idx+1)+'项').substring(0,20);
  var ok=await _showConfirm('确定要删除「'+taskLabel+'」吗？\n\n此操作不可恢复'+'\n\n—\n\n'+'Are you sure you want to delete "'+taskLabel+'"?\n\nThis action cannot be undone.','注意 / Attention');
  if(!ok)return;
  console.log('[deleteTaskRow] removing idx='+idx+' work='+(t.work||''));
  tasks.splice(idx,1);
  // 重新编号
  for(var i=0;i<tasks.length;i++)tasks[i].seq=i+1;
  _calcWeekScore(p);
  saveWP(p.year,p.month,p.week,p);
  renderWPTable(p);
  showToast('🗑 已删除并重新编号');
}

// ★ V0.6.1dv: 清空单行所有字段（保留行结构）
// 用于 total=1 时，无法删除整行时清空内容重新填写
async function clearTaskRow(idx){
  var p=_wpCurrent.plan;if(!p||!p.tasks)return;
  var tasks=p.tasks;
  if(idx<0||idx>=tasks.length)return;
  var t=tasks[idx];
  if(!t)return;
  if(t.collab_from){showToast('⚠️ 协同任务不能清空');return;}
  var hasContent=t.work||t.goal||t.startDate||t.plannedDate||t.actualDate||
    t.estimatedHours||t.status||t.needBoss||t.problems||t.problemType||
    (t.supporters&&t.supporters.length>0)||t.aiSuggestion||t.bossFeedback;
  // ★ V0.6.1em: 关键修复 — hasContent 必须同时检查 _revisions！renderWPCellValue 实际读的是 _revisions
  if(!hasContent&&p._revisions){
    var _prefix='tasks.'+idx+'.';
    for(var _rk in p._revisions){
      if(_rk.indexOf(_prefix)===0&&p._revisions[_rk]&&p._revisions[_rk].value){hasContent=true;break;}
    }
  }
  if(!hasContent){showToast('该行已经是空行，无需清空');return;}
  var taskLabel=(t.work||'第'+(idx+1)+'项').substring(0,20);
  var ok=await _showConfirm('确定要清空「'+taskLabel+'」的所有内容吗？\n\n行结构和序号将保留。','清空该行 / Clear Row');
  if(!ok)return;
  // ★ V0.6.1el: 最直接方案 — 同时更新数据+DOM+刷新页面
  // 1. 清空数据（所有字段）
  var newTask={seq:1,goal:'',work:'',status:'',needBoss:'',problems:'',
    startDate:'',actualDate:'',supporters:'',plannedDate:'',problemType:'',
    aiSuggestion:'',bossFeedback:'',estimatedHours:'',remarks:''};
  tasks.splice(idx,1,newTask);
  // 2. 清空 _revisions
  if(p._revisions){
    var prefix='tasks.'+idx+'.';
    for(var key in p._revisions){if(key.indexOf(prefix)===0)delete p._revisions[key];}
  }
  p.updatedAt=new Date().toISOString();
  // 3. 同步到 _wpData（保存数据）
  if(_wpCurrent&&_wpCurrent.year){
    var k=makeWPId(_wpCurrent.year,_wpCurrent.month,_wpCurrent.week);
    if(_wpData)_wpData[k]=p;
  }
  // 4. 保存到 localStorage
  saveWP(p.year,p.month,p.week,p);
  renderWPTable(p);
  showToast('✨ 已清空第 '+(idx+1)+' 行所有内容');
}

// 在任务表原表头离开可视区后显示克隆表头，避免纵向浏览时丢失字段语义。
function _bindWPStickyTableHeader(content){
  if(!content)return;
  if(content._wpStickyHeaderCleanup)content._wpStickyHeaderCleanup();
  var old=document.getElementById('wpStickyTableHeader');
  if(old)old.remove();
  var pageScroll=content.querySelector('.wp-page-scroll');
  var tableScroll=content.querySelector('.wp-table-x-scroll');
  var sourceTable=tableScroll&&tableScroll.querySelector('.wp-table');
  var sourceHead=sourceTable&&sourceTable.querySelector('thead');
  if(!pageScroll||!tableScroll||!sourceTable||!sourceHead)return;

  var sticky=document.createElement('div');
  sticky.id='wpStickyTableHeader';
  sticky.className='wp-sticky-table-header';
  sticky.setAttribute('aria-hidden','true');
  sticky.innerHTML='<div class="wp-table-wrap"><table class="wp-table">'+(sourceTable.querySelector('colgroup')?sourceTable.querySelector('colgroup').outerHTML:'')+'<thead>'+sourceHead.innerHTML+'</thead></table></div>';
  content.appendChild(sticky);

  var sourceCells=sourceHead.querySelectorAll('th');
  var stickyCells=sticky.querySelectorAll('th');
  for(var i=0;i<sourceCells.length&&i<stickyCells.length;i++){
    var w=Math.ceil(sourceCells[i].getBoundingClientRect().width);
    stickyCells[i].style.width=w+'px';
    stickyCells[i].style.minWidth=w+'px';
    stickyCells[i].style.maxWidth=w+'px';
  }

  var ticking=false;
  function sync(){
    ticking=false;
    var topbar=document.querySelector('.wp-topbar');
    var topbarRect=topbar?topbar.getBoundingClientRect():null;
    var fixedTop=topbarRect?Math.round(topbarRect.bottom):0;
    var tableRect=tableScroll.getBoundingClientRect();
    var headRect=sourceHead.getBoundingClientRect();
    var canStick=headRect.top<=fixedTop && tableRect.bottom>fixedTop+headRect.height;
    if(canStick){
      sticky.style.left=Math.round(tableRect.left)+'px';
      sticky.style.top=fixedTop+'px';
      sticky.style.width=Math.round(tableRect.width)+'px';
      sticky.style.height=Math.ceil(headRect.height)+'px';
      sticky.classList.add('is-visible');
      if(Math.abs(sticky.scrollLeft-tableScroll.scrollLeft)>1)sticky.scrollLeft=tableScroll.scrollLeft;
    }else{
      sticky.classList.remove('is-visible');
    }
  }
  function requestSync(){if(!ticking){ticking=true;requestAnimationFrame(sync);}}
  function onTableScroll(){
    if(sticky.scrollLeft!==tableScroll.scrollLeft)sticky.scrollLeft=tableScroll.scrollLeft;
    requestSync();
  }
  pageScroll.addEventListener('scroll',requestSync,{passive:true});
  tableScroll.addEventListener('scroll',onTableScroll,{passive:true});
  window.addEventListener('resize',requestSync,{passive:true});
  content._wpStickyHeaderCleanup=function(){
    pageScroll.removeEventListener('scroll',requestSync);
    tableScroll.removeEventListener('scroll',onTableScroll);
    window.removeEventListener('resize',requestSync);
    content._wpStickyHeaderCleanup=null;
  };
  requestSync();
}

function renderWPTable(plan){
  if(!plan)return;
  var content=document.getElementById('wpContent');
  if(!content)return;
  // 页面纵向滚动与表格横向滚动分离，避免用 JS transform 补偿造成顶部区域抖动。
  var _oldPageScroll=content.querySelector('.wp-page-scroll');
  var _oldTableScroll=content.querySelector('.wp-table-x-scroll');
  var _savedScrollTop=_oldPageScroll?_oldPageScroll.scrollTop:0;
  var _savedScrollLeft=_oldTableScroll?_oldTableScroll.scrollLeft:0;
  var dd=document.getElementById('wpDefault');
  var oldPage=content.querySelector('.wp-page-scroll');
  if(oldPage)oldPage.remove();
  var tb=content.querySelector('#wpToolbar');
  var ta=content.querySelector('.wp-table-area');
  var ib=content.querySelector('.wp-info-bar');
  var sb=content.querySelector('.wp-summary-bar');
  var fb=content.querySelector('.wp-feedback-sections');
  var cb=content.querySelector('#collabTaskArea');
  if(tb)tb.remove();if(ta)ta.remove();if(ib)ib.remove();if(sb)sb.remove();if(fb)fb.remove();if(cb)cb.remove();
  var sc=content.querySelector('.wp-scroll-area');if(sc)sc.remove();
  var mp=content.querySelector('#wpTimeMgmtPanel');if(mp)mp.remove();
  if(dd)dd.style.display='none';

  var isManager=(getWPSubordinates().length>0);
  var myName=(currentUser&&currentUser.name)||'';
  if(!plan.year||!plan.month||!plan.week){console.warn('renderWPTable: plan missing year/month/week',plan);return;}
    var weekLabel=plan.year+'年'+plan.month+'月 第'+plan.week+'周';
  var html='';
  html+='<div class="wp-page-scroll">';

  html+='<div class="wp-info-bar"><strong>当前员工：</strong><strong>'+_h(plan.name)+'</strong>&nbsp;'+_h(plan.dept)+' | '+_h(plan.position)+'<span class="sep">|</span>'+weekLabel;
  if(_wpViewingSubordinate)html+='<span style="color:#E8622A;font-weight:500;margin-left:8px">（查看直属下属周计划）</span>';
  else if(_wpViewingDeptMember)html+='<span style="color:#E8622A;font-weight:500;margin-left:8px">（查看更多下属周计划）</span>';
  if(plan.frozen && plan.frozenBy && plan.frozenBy !== myName && !_wpViewingShared && !_wpViewingSubordinate && !_wpViewingDeptMember){
    html+='<span style="color:#3B7DB4;font-weight:600;margin-left:8px">🔐 上级锁定（蓝线单元不可修改）</span>';
    if(plan.frozenBy)/* removed by attribution */;
  }
  // ★ V0.6.1cf: 修订模式红色文字机制已取消，上级修改下属内容后不再变红

  if(plan.bossEvaluated)html+='<span style="color:#059669;margin-left:8px">✓ 上级已评价</span>';
  html+='</div>';

  html+='<div class="wp-toolbar" id="wpToolbar" style="display:flex;flex-wrap:wrap;gap:8px;padding:8px 0;margin-bottom:4px;border-bottom:1px solid var(--border)">';
  if(_wpViewingShared){
    // ★ V0.5.79b: 只读模式 — 被授权查看他人周计划
    html+='<span style="color:#3B7DB4;font-weight:600">📖 只读模式 — 您正在查看 '+esc(_wpViewingShared)+' 分享的周计划</span>';
    html+='<button class="wp-btn-export" onclick="exportCurrentWP()" style="margin-left:auto"><span>📥</span> 导出周行动项</button>';
  }else if(_wpViewingDeptMember){
    // 部门成员视图：审核锁定 + 上级评价（同直属下属）
    // ★ V0.6.1af: 上级锁定按钮只反映上级自己锁定的状态，员工提交锁定不显示为已锁定
    var myName=(currentUser&&currentUser.name)||'';
    var isFrozen = _wpCurrent.plan && _wpCurrent.plan.frozen && _wpCurrent.plan.frozenBy===myName;
    html+='<button class="'+(isFrozen?'wp-btn-freeze':'')+'" onclick="toggleWPFreeze()" title="锁定后下属不能修改本周重点/优先级/计划完成日期">';
    html+=isFrozen?'🔐 解除锁定':'🔐 锁定周计划';
    html+='</button>';
    // ★ V0.6.1ad: 完成评价 Toggle（部门成员视图）
    if(_wpCurrent.plan && _wpCurrent.plan.bossEvaluated){
      html+='<button onclick="revokeBossEval()">↩️ 撤销评价</button>';
    }else{
      html+='<button onclick="openBossEval()">⭐ 完成评价</button>';
    }
  }else if(_wpViewingSubordinate){
    // 查看下属：审核锁定 + 上级评价编辑（V0.6.1cf: 修订模式已取消，上级修改不再标红）
    // ★ V0.1.23: 锁定周计划 — 上级点击后下属不能修改 本周重点行动项/优先级/计划完成时间
    // ★ V0.6.1af: 上级锁定按钮只反映上级自己锁定的状态
    var myName=(currentUser&&currentUser.name)||'';
    var isFrozen = _wpCurrent.plan && _wpCurrent.plan.frozen && _wpCurrent.plan.frozenBy===myName;
    html+='<button class="'+(isFrozen?'wp-btn-freeze':'')+'" onclick="toggleWPFreeze()" title="锁定后下属不能修改本周重点、优先级、计划完成日期">';
    html+=isFrozen?'🔐 解除锁定':'🔐 锁定周计划';
    html+='</button>';
    // ★ V0.6.1ad: 完成评价 Toggle（直属下属视图）
    if(_wpCurrent.plan && _wpCurrent.plan.bossEvaluated){
      html+='<button onclick="revokeBossEval()">↩️ 撤销评价</button>';
    }else{
      html+='<button onclick="openBossEval()">⭐ 完成评价</button>';
    }
  }else{
    // 自己的计划：完整编辑功能（去掉新增+转发，左下角已有新建）
    // ★ V0.6.1ad: Toggle 按钮 + 撤回约束逻辑（协同上级锁定/评价）
    //   规则：上级已评价 → 两者皆锁定；上级已锁定 → 撤回周计划锁定；小结已提交 → 必须先撤回小结
    var myName=(currentUser&&currentUser.name)||'';
    var isLockedByBoss=plan.frozen && plan.frozenBy && plan.frozenBy!==myName;
    if(plan.firstSubmittedAt){
      if(plan.bossEvaluated){
        html+='<button disabled class="wp-btn-toggle-locked" title="上级已评价，无法撤回"><span>🔒</span> 周行动项已提交</button>';
      }else if(plan.summarySubmittedAt){
        html+='<button disabled class="wp-btn-toggle-locked" title="请先撤回周小结"><span>🔒</span> 周行动项已提交</button>';
      }else if(isLockedByBoss){
        html+='<button disabled class="wp-btn-toggle-locked" title="上级已锁定周计划，请联系上级解除锁定"><span>🔒</span> 周行动项已提交</button>';
      }else{
        html+='<button onclick="undoWPSubmit()" class="wp-btn-toggle-submitted"><span>↩</span> 撤回周行动项</button>';
      }
    }else{
      html+='<button onclick="submitWPPlan()" class="wp-btn-primary"><span>📋</span> 提交周行动项</button>';
    }
    if(plan.summarySubmittedAt){
      if(plan.bossEvaluated){
        html+='<button disabled class="wp-btn-toggle-locked" title="上级已评价，无法撤回"><span>🔒</span> 周小结已提交</button>';
      }else{
        html+='<button onclick="undoWPWeekSummary()" class="wp-btn-toggle-submitted"><span>↩</span> 撤回周小结</button>';
      }
    }else{
      html+='<button onclick="submitWPWeekSummary()" class="wp-btn-summary"><span>✅</span> 提交周小结</button>';
    }
    var isDeleteLocked=plan.firstSubmittedAt||plan.summarySubmittedAt||isLockedByBoss||plan.bossEvaluated;
    if(isDeleteLocked){
      html+='<button class="wp-btn-delete wp-btn-disabled" title="如要删除本周行动项请先解除上级锁定或撤回提交周小结及周计划" onclick="deleteCurrentWPPlan()"><span>🗑</span> 删除周行动项</button>';
    }else{
      html+='<button class="wp-btn-delete" onclick="deleteCurrentWPPlan()"><span>🗑</span> 删除周行动项</button>';
    }
  // ★ j81: 工具操作前加分隔线 — 视觉分组（工作流 / 工具）
  html+='<span class="wp-toolbar-divider" aria-hidden="true"></span>';
  html+='<button class="wp-btn-export" onclick="exportCurrentWP()" title="导出周行动项"><span>📥</span> 导出</button>';
  if(plan.bossEvaluated){
      html+='<button onclick="viewBossEval()"><span style="color:#2A476A">📋</span> 查看上级评价</button>';
    }
    html+='<button id="wpAiAssessBtn" class="wp-btn-ai" onclick="aiAssessWP()" style="margin-left:auto" title="生成本周 AI 建议"><span style="font-size:14px;font-weight:700">AI</span><span>建议</span></button>';
  }
  // 安全兜底：确保工具栏至少有一个可见按钮（防止所有分支都未命中导致空白）
  if(html.indexOf('<button', html.lastIndexOf('wpToolbar')) < 0){
    html+='<button class="wp-btn-export" onclick="exportCurrentWP()"><span>📥</span> 导出周行动项</button>';
  }
  html+='</div>';

  // 填写参考默认收纳，避免规则与统计信息抢占任务首屏。
  html+=_renderTimeManagementPanel(plan);

  // 任务表合计行仍需使用这些统计值；不再渲染独立状态摘要栏。
  var hasPlan=0,hasActual=0,overdue=0;
  var todayStr=_getTodayStr();
  for(var i=0;i<plan.tasks.length;i++){
    var summaryTask=plan.tasks[i]||{};
    var plannedDate=summaryTask.plannedDate||'';
    if(plannedDate){
      hasPlan++;
      if(plannedDate<todayStr&&summaryTask.status!=='✓完成'&&summaryTask.status!=='按时完成')overdue++;
    }
    if(summaryTask.actualDate)hasActual++;
  }
  var _taskTotal=0;
  if(plan._taskScores){
    for(var tsi=0;tsi<plan._taskScores.length;tsi++)_taskTotal+=plan._taskScores[tsi]||0;
  }
  var taskScoreDisplay='';
  if(_taskTotal!==0||plan.bossEvaluated)taskScoreDisplay=(_taskTotal>0?'+':'')+_taskTotal;

  // ★ V0.6.1cd: 表头双击排序 — 临时替换plan.tasks为排序副本
  var _wpOrigTasks=null;
  if(_wpSort && _wpSort.col && _wpSort.dir){
    _wpOrigTasks=plan.tasks;
    plan.tasks=sortWPTasks(plan.tasks.slice(),_wpSort.col,_wpSort.dir);
  }

  // ★ V0.1.39: 区分「上周转入」和「本周新增」（移到表格生成前）
  var carriedTasks=[], newTasks=[];
  for(var j=0;j<plan.tasks.length;j++){
    if(plan.tasks[j].carriedFrom)carriedTasks.push(j);
    else newTasks.push(j);
  }

  html+='<div class="wp-table-x-scroll"><div class="wp-table-area"><div class="wp-table-wrap"><table class="wp-table"><colgroup><col style="width:56px"><col style="width:180px"><col style="width:80px"><col style="width:115px"><col style="width:115px"><col style="width:80px"><col style="width:115px"><col style="width:56px"><col style="width:90px"><col style="width:48px"><col style="width:80px"><col style="width:150px"><col style="width:90px"><col style="width:56px"><col style="width:150px"><col style="width:150px"></colgroup><thead><tr>';
  var _sPri='',_sSd='',_sPd='',_sRd='',_sAd='',_sSt='';
  if(_wpSort && _wpSort.col && _wpSort.dir){
    var _arr=_wpSort.dir==='asc'?' ↑':' ↓';
    switch(_wpSort.col){case'priority':_sPri=_arr;break;case'startDate':_sSd=_arr;break;case'plannedDate':_sPd=_arr;break;case'remainingDays':_sRd=_arr;break;case'actualDate':_sAd=_arr;break;case'status':_sSt=_arr;break;}
  }
  html+='<th class="col-num">#</th><th class="col-work">本周重点行动项</th>';
  html+='<th class="col-goal wp-sortable" ondblclick="toggleWPSort(\'priority\')" title="💡 双击表头切换排序" style="cursor:pointer">优先级 <span style="opacity:.75;font-size:9px;color:#3B7DB4">⇅</span>'+_sPri+'</th>';
  html+='<th class="col-hours wp-sortable" ondblclick="toggleWPSort(\'startDate\')" title="💡 双击表头切换排序" style="cursor:pointer">启动日期 <span style="opacity:.75;font-size:9px;color:#3B7DB4">⇅</span>'+_sSd+'</th>';
  html+='<th class="col-hours wp-sortable" ondblclick="toggleWPSort(\'plannedDate\')" title="💡 双击表头切换排序" style="cursor:pointer">计划完成日期 <span style="opacity:.75;font-size:9px;color:#3B7DB4">⇅</span>'+_sPd+'</th>';
  html+='<th class="col-remaining wp-sortable" ondblclick="toggleWPSort(\'remainingDays\')" title="💡 双击表头切换排序" style="cursor:pointer;min-width:80px">剩余办结天数 <span style="opacity:.75;font-size:9px;color:#3B7DB4">⇅</span>'+_sRd+'</th>';
  html+='<th class="col-hours wp-sortable" ondblclick="toggleWPSort(\'actualDate\')" title="双击排序" style="cursor:pointer">实际完成日期'+_sAd+'</th>';
  html+='<th class="col-hours dur-tooltip" style="min-width:80px">计划/实际耗时</th>';
  html+='<th class="col-status wp-sortable" ondblclick="toggleWPSort(\'status\')" title="双击排序" style="cursor:pointer">完成状态'+_sSt+'</th>';
  html+='<th class="col-score">积分</th><th class="col-supporters">协同人</th><th class="col-wide">遇到的问题/挑战</th><th class="col-problemtype">问题类型</th><th class="col-needboss">需上级介入</th><th class="col-remarks">备注</th><th class="col-boss" style="white-space:normal;overflow:visible">主管点评</th>';
  html+='</tr></thead><tbody>';

  var seq=0;

  // 上周转入区块
  if(carriedTasks.length>0){
    html+='<tr class="wp-section-header" style="background:#FFF8E7"><td colspan="16" style="padding:6px 12px;font-size:12px;font-weight:600;color:#8B6914;border-bottom:2px solid #F0E6C8">📥 上周转入（'+carriedTasks.length+'项）</td></tr>';
    for(var ci=0;ci<carriedTasks.length;ci++){
      var jj=carriedTasks[ci]; seq++;
      var tt=plan.tasks[jj];
      var cf=tt.carriedFrom;
      var cfTag=cf?'<div style="font-size:9px;color:#8B6914;background:#FFF8E7;padding:1px 4px;border-radius:3px;display:block;margin-top:2px">来源:'+cf.year+'年'+cf.month+'月第'+cf.week+'周</div>':'';
      // ★ V0.1.88: 转入任务可编辑
      var edCls=(plan.bossEvaluated?'':' editable');
      var edClick=(plan.bossEvaluated?'':' onclick="startEditCell(this)"');
      html+='<tr style="background:#FFFDF5" data-task-idx="'+jj+'">';
      // ★ V0.1.59: 上周转入的不可删除，只显示序号
      html+='<td class="col-num" style="text-align:center;color:#8B6914">'+seq+'</td>';
      html+='<td class="'+edCls+' col-work" data-field="tasks.'+jj+'.work" data-type="textarea"'+edClick+'>'+(tt.work?_hWork(tt.work):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击填写</span>')+cfTag+'</td>';
      var __goalRaw=tt.goal||'';
      var __goalVal=renderWPCellValue(plan,'tasks.'+jj+'.goal',tt.goal);
      var __goalPriClass=__goalRaw==='重要紧急'?'pri-urgent':__goalRaw==='重要不急'?'pri-important':__goalRaw==='日常紧急'?'pri-daily-urgent':__goalRaw==='日常事项'?'pri-daily-routine':'';
      html+='<td class="'+edCls+' col-goal '+__goalPriClass+'" data-field="tasks.'+jj+'.goal" data-type="select" data-opts="'+WP_GOAL_OPTIONS.join(',')+'"'+edClick+'>'+(__goalVal||'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">选择</span>')+'</td>';
      var _sd=renderWPCellValue(plan,'tasks.'+jj+'.startDate',tt.startDate||'');
      html+='<td class="'+edCls+' col-hours" data-field="tasks.'+jj+'.startDate" data-type="date"'+edClick+'>'+(_sd?_sd:'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击选择日期</span>')+'</td>';
      var _pd=renderWPCellValue(plan,'tasks.'+jj+'.plannedDate',tt.plannedDate||'');
      html+='<td class="'+edCls+' col-hours" data-field="tasks.'+jj+'.plannedDate" data-type="date"'+edClick+'>'+(_pd?_pd:'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击选择日期</span>')+'</td>';
      html+='<td class="col-remaining" style="text-align:center;font-size:12px">'+_calcRemainingDays(tt.plannedDate||'',tt.actualDate||'')+'</td>';
      var _ad=renderWPCellValue(plan,'tasks.'+jj+'.actualDate',tt.actualDate||'');
      html+='<td class="'+edCls+' col-hours" data-field="tasks.'+jj+'.actualDate" data-type="date"'+edClick+'>'+(_ad?_ad:'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击选择日期</span>')+'</td>';
      // ★ V0.4.91d/Q: 耗时列（自动计算，只读）+ 蓝色角标 + tooltip数据
      var _dur=_calcTaskDuration(tt);
      var _durTip='';
      if(_dur){
        _durTip='启动: '+tt.startDate+'&#10;';
        if(tt.actualDate)_durTip+='实际完成: '+tt.actualDate+'&#10;实际耗时: '+_dur+'个工作日';
        else if(tt.status==='暂停中')_durTip+='暂停: '+(tt._pausedAt||'—')+'&#10;已锁定: '+_dur+'个工作日';
        else _durTip+='计划完成: '+(tt.plannedDate||'—')+'&#10;预计耗时: '+_dur+'个工作日';
      }
      html+='<td class="col-duration' + (_dur?' has-duration':'') + '"' + (_durTip?' data-dur-tip="'+_durTip+'"':'') + ' style="text-align:center;font-variant-numeric:tabular-nums;color:#6b7280;font-size:12px">'+(_dur?_dur+'天':'—')+'</td>';
      // ★ V0.1.49: 每行任务得分 — 完成状态在前，积分在后(与表头一致)
      html+='<td class="'+edCls+' col-status" data-field="tasks.'+jj+'.status" data-type="select" data-opts="'+WP_STATUS_OPTIONS.join(',')+'"'+edClick+'>'+(tt.status?_renderStatusDot(tt.status):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">选择</span>')+'</td>';
      html+=_renderTaskScoreCell(plan,jj);
      html+='<td class="'+edCls+' col-supporters" data-field="tasks.'+jj+'.supporters" data-type="text"'+edClick+'>'+_renderSupportersCell(plan,jj,tt.supporters)+'</td>';
      // ★ j83: 清洗 col-problems 脏数据 — 历史数据可能有"填写"作为实际值
      var _cleanProblems=_cleanPlaceholderText(tt.problems);
      html+='<td class="'+edCls+' col-wide" data-field="tasks.'+jj+'.problems" data-type="textarea"'+edClick+'>'+(_cleanProblems?(plan._revisions&&plan._revisions['tasks.'+jj+'.problems']?renderWPCellValue(plan,'tasks.'+jj+'.problems',_cleanProblems):_h(_cleanProblems)):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">填写</span>')+'</td>';
      html+='<td class="'+edCls+' col-problemtype" data-field="tasks.'+jj+'.problemType" data-type="select" data-opts="'+WP_PROBLEM_OPTIONS.join(',')+'"'+edClick+'>'+(tt.problemType||plan._revisions&&plan._revisions['tasks.'+jj+'.problemType']?renderWPCellValue(plan,'tasks.'+jj+'.problemType',tt.problemType):(tt.problemType?_h(tt.problemType):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">选择</span>'))+'</td>';
      html+='<td class="'+edCls+' col-needboss" data-field="tasks.'+jj+'.needBoss" data-type="select" data-opts="'+WP_NEEDBOSS_OPTIONS.join(',')+'"'+edClick+'>'+renderWPCellValue(plan,'tasks.'+jj+'.needBoss',tt.needBoss||'')+'</td>';
      // ★ j83: 清洗 col-remarks 脏数据
      var _cleanRemarks=_cleanPlaceholderText(tt.remarks);
      html+='<td class="'+edCls+' col-remarks" data-field="tasks.'+jj+'.remarks" data-type="textarea"'+edClick+'>'+(_cleanRemarks?(plan._revisions&&plan._revisions['tasks.'+jj+'.remarks']?renderWPCellValue(plan,'tasks.'+jj+'.remarks',_cleanRemarks):_h(_cleanRemarks)):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">备注</span>')+'</td>';
      var bossCanEdit=isMySubordinate(plan.name) || !!_wpViewingDeptMember;
      // ★ j83: 清洗 col-bossFeedback 脏数据
      var _cleanBossFb=_cleanPlaceholderText(tt.bossFeedback);
      html+='<td class="col-boss'+(bossCanEdit?' editable':'')+'"'+(bossCanEdit?' data-field="tasks.'+jj+'.bossFeedback" data-type="textarea" onclick="startEditCell(this)"':'')+'>'+(_cleanBossFb?_h(_cleanBossFb):(plan._revisions&&plan._revisions['tasks.'+jj+'.bossFeedback']?renderWPCellValue(plan,'tasks.'+jj+'.bossFeedback',tt.bossFeedback):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">上级建议</span>'))+'</td>';
      html+='</tr>';
    }
    html+='<tr class="wp-section-header" style="background:#F0F9FF"><td colspan="16" style="padding:6px 12px;font-size:12px;font-weight:600;color:#0369A1;border-bottom:2px solid #BAE6FD">📝 本周新增（'+newTasks.length+'项）</td></tr>';
  }

  // 本周新增区块
  for(var ni=0;ni<newTasks.length;ni++){
    var j=newTasks[ni]; seq++;
    var t=plan.tasks[j];
    var _frozenCls=(plan.frozen&&!_wpViewingSubordinate&&!_wpViewingDeptMember?' wp-cell-frozen':'');
    var _summaryFrozenCls=(plan.summarySubmittedAt&&!_wpViewingSubordinate&&!_wpViewingDeptMember?' wp-cell-frozen':'');
    html+='<tr data-task-idx="'+j+'">';
    // ★ V0.1.59: # 列 — +/- 操作按钮
    html+=_renderTaskOpCell(j,seq,plan);
    html+='<td class="editable col-work'+_frozenCls+'" data-field="tasks.'+j+'.work" data-type="textarea" onclick="startEditCell(this)">'+(t.work||plan._revisions&&plan._revisions['tasks.'+j+'.work']?renderWPCellValue(plan,'tasks.'+j+'.work',t.work):(t.work?_hWork(t.work):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击填写</span>'))+'</td>';
    var _goalRaw=t.goal||'';
    var _goalVal=renderWPCellValue(plan,'tasks.'+j+'.goal',t.goal);
    var _goalPriClass=_goalRaw==='重要紧急'?'pri-urgent':_goalRaw==='重要不急'?'pri-important':_goalRaw==='日常紧急'?'pri-daily-urgent':_goalRaw==='日常事项'?'pri-daily-routine':'';
    html+='<td class="editable col-goal '+_goalPriClass+_frozenCls+'" data-field="tasks.'+j+'.goal" data-type="select" data-opts="'+WP_GOAL_OPTIONS.join(',')+'" onclick="startEditCell(this)">'+(_goalVal||'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">选择</span>')+'</td>';
    var startDateDisplay=renderWPCellValue(plan,'tasks.'+j+'.startDate',t.startDate||'');
    html+='<td class="editable col-hours'+_frozenCls+'" data-field="tasks.'+j+'.startDate" data-type="date" onclick="startEditCell(this)">'+(startDateDisplay?startDateDisplay:'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击选择日期</span>')+'</td>';
    var plannedDateDisplay=renderWPCellValue(plan,'tasks.'+j+'.plannedDate',t.plannedDate||'');
    html+='<td class="editable col-hours'+_frozenCls+'" data-field="tasks.'+j+'.plannedDate" data-type="date" onclick="startEditCell(this)">'+(plannedDateDisplay?plannedDateDisplay:'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击选择日期</span>')+'</td>';
    html+='<td class="col-remaining" style="text-align:center;font-size:12px">'+_calcRemainingDays(t.plannedDate||'',t.actualDate||'')+'</td>';
    var actualDateDisplay=renderWPCellValue(plan,'tasks.'+j+'.actualDate',t.actualDate||'');
    // ★ V0.4.91: 自动"未做"时锁定实际完成日期，显示"—"
    // ★ V0.6.1ac: actualDate 由小结提交控制冻结（非计划提交）
    if(t.status==='未做'&&!t._manualNotDone){
      html+='<td class="col-hours'+_summaryFrozenCls+'" style="color:#9ca3af;cursor:not-allowed;text-align:center">—</td>';
    }else{
      html+='<td class="editable col-hours'+_summaryFrozenCls+'" data-field="tasks.'+j+'.actualDate" data-type="date" onclick="startEditCell(this)">'+(actualDateDisplay?actualDateDisplay:'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">点击选择日期</span>')+'</td>';
    }
    // ★ V0.4.91d/Q: 耗时列（自动计算，只读）+ 蓝色角标 + tooltip数据
    var _durNew=_calcTaskDuration(t);
    var _durTip='';
    if(_durNew){
      _durTip='启动: '+t.startDate+'&#10;';
      if(t.actualDate)_durTip+='实际完成: '+t.actualDate+'&#10;实际耗时: '+_durNew+'个工作日';
      else if(t.status==='暂停中')_durTip+='暂停: '+(t._pausedAt||'—')+'&#10;已锁定: '+_durNew+'个工作日';
      else _durTip+='计划完成: '+(t.plannedDate||'—')+'&#10;预计耗时: '+_durNew+'个工作日';
    }
    html+='<td class="col-duration' + (_durNew?' has-duration':'') + '"' + (_durTip?' data-dur-tip="'+_durTip+'"':'') + ' style="text-align:center;font-variant-numeric:tabular-nums;color:#6b7280;font-size:12px">'+(_durNew?_durNew+'天':'—')+'</td>';
    // ★ V0.1.49: 每行任务积分
    html+='<td class="editable col-status" data-field="tasks.'+j+'.status" data-type="select" data-opts="'+WP_STATUS_OPTIONS.join(',')+'" onclick="startEditCell(this)">'+(t.status?_renderStatusDot(t.status):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">选择</span>')+'</td>';
    html+=_renderTaskScoreCell(plan,j);
    html+='<td class="editable col-supporters" data-field="tasks.'+j+'.supporters" data-type="text" onclick="startEditCell(this)">'+_renderSupportersCell(plan,j,t.supporters)+'</td>';
    var _problemKey='tasks.'+j+'.problems';
    var _problemRevision=plan._revisions&&plan._revisions[_problemKey];
    var _problemDisplay=_normalizeProblemPlaceholder(_problemRevision?_problemRevision.value:t.problems);
    html+='<td class="editable col-wide" data-field="'+_problemKey+'" data-type="textarea" onclick="startEditCell(this)">'+(_problemDisplay?_h(_problemDisplay):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">填写</span>')+'</td>';
    html+='<td class="editable col-problemtype" data-field="tasks.'+j+'.problemType" data-type="select" data-opts="'+WP_PROBLEM_OPTIONS.join(',')+'" onclick="startEditCell(this)">'+(t.problemType||plan._revisions&&plan._revisions['tasks.'+j+'.problemType']?renderWPCellValue(plan,'tasks.'+j+'.problemType',t.problemType):(t.problemType?_h(t.problemType):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">选择</span>'))+'</td>';
    html+='<td class="editable col-needboss" data-field="tasks.'+j+'.needBoss" data-type="select" data-opts="'+WP_NEEDBOSS_OPTIONS.join(',')+'" onclick="startEditCell(this)">'+renderWPCellValue(plan,'tasks.'+j+'.needBoss',t.needBoss||'')+'</td>';
    // ★ V0.3.36: 备注说明(员工自填，新列)
    // ★ j83: 清洗脏数据
    var _cleanNewRemarks=_cleanPlaceholderText(t.remarks);
    html+='<td class="editable col-remarks" data-field="tasks.'+j+'.remarks" data-type="textarea" onclick="startEditCell(this)">'+(_cleanNewRemarks?(plan._revisions&&plan._revisions['tasks.'+j+'.remarks']?renderWPCellValue(plan,'tasks.'+j+'.remarks',_cleanNewRemarks):_h(_cleanNewRemarks)):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">备注</span>')+'</td>';
    var bossCanEdit=isMySubordinate(plan.name) || !!_wpViewingDeptMember;
    var _cleanNewBossFb=_cleanPlaceholderText(t.bossFeedback);
    html+='<td class="col-boss'+(bossCanEdit?' editable':'')+'"'+(bossCanEdit?' data-field="tasks.'+j+'.bossFeedback" data-type="textarea" onclick="startEditCell(this)"':'')+'>'+(_cleanNewBossFb?_h(_cleanNewBossFb):(plan._revisions&&plan._revisions['tasks.'+j+'.bossFeedback']?renderWPCellValue(plan,'tasks.'+j+'.bossFeedback',t.bossFeedback):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">上级建议</span>'))+'</td>';
    html+='</tr>';
  }

  html+='<tr class="wp-total-row">';
  html+='<td colspan="3" style="text-align:right;padding-right:12px;background:#FBF8F3">📊 本周合计</td>';
  html+='<td style="background:#FBF8F3"></td>'; // 启动日期
  html+='<td class="wp-total-num">'+hasPlan+' 项排期</td>'; // 计划完成日期
  html+='<td style="background:#FBF8F3"></td>'; // 剩余办结天数
  html+='<td class="wp-total-num">'+hasActual+' 项完成</td>'; // 实际完成日期
  html+='<td style="background:#FBF8F3"></td>'; // 耗时
  html+='<td style="text-align:center;background:#FBF8F3"></td>'; // 状态
  html+='<td style="text-align:center;background:#FBF8F3;font-weight:600;font-size:12px;color:#2A476A">'+(taskScoreDisplay||'')+'</td>'; // 积分
  html+='<td colspan="2" style="text-align:right;padding-right:12px;background:#FBF8F3">逾期任务</td>'; // 协同+问题
  html+='<td class="wp-total-num" style="color:'+(overdue>0?'var(--danger)':'var(--success)')+'">'+overdue+' 项</td>'; // 问题类型
  html+='<td colspan="3" style="background:#FBF8F3"></td>'; // 需上级+备注+上级评价
  html+='</tr>';
  html+='</tbody></table></div></div></div>';

  // ===== 协同任务区域（独立表格，来自其他同事的协同请求）=====
  html+=_renderCollabTasksSection(plan);

  // ===== Feedback Sections =====
  html+='<div class="wp-feedback-sections">';
  
  // Section 1: Employee Weekly Summary
  var isEmployee = (currentUser && currentUser.name === plan.name);
  var isSupervisor = (_wpViewingSubordinate || _wpViewingDeptMember);
  var summaryContent = plan.weekSummary || '';
  var summaryUpdatedAt = plan.weekSummaryUpdatedAt || '';
  
  html+='<div class="wp-feedback-section ai-section-collapsed" id="aiFeedbackSection">';
  html+='<div class="ai-header-bar" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--card-alt);flex-wrap:wrap;gap:8px">';
    html+='<div style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:#0F2C4B">🤖 AI 综合分析</div>';
    html+='<button type="button" onclick="toggleAIAnalysis()" id="aiAnalysisToggleBtn" style="padding:3px 12px;border:1px solid #d4c8f0;border-radius:8px;background:#fff;color:#6b5b95;font-size:11px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:3px;transition:all .25s ease;white-space:nowrap"><span id="aiToggleIcon">▼</span><span id="aiToggleText">展开</span></button>';
    html+='</div>';
  if(plan.aiAnalysis && plan.aiAnalysis.trim()){
    html+='<div class="wp-feedback-textarea" id="aiAnalysisContent" style="background:#F4F0FF;border:1px solid #d4c8f0;font-size:13px;line-height:1.8;white-space:pre-wrap;transition:max-height 0.6s cubic-bezier(.25,.1,.25,1),opacity 0.6s cubic-bezier(.25,.1,.25,1),padding 0.6s cubic-bezier(.25,.1,.25,1);overflow:hidden;max-height:0;opacity:0;padding:0;margin-top:0">'+_h(plan.aiAnalysis)+'</div>';
  }else{
    html+='<div class="wp-feedback-empty" id="aiAnalysisContent" style="background:#F4F0FF;border:1px dashed #d4c8f0;transition:max-height 0.6s cubic-bezier(.25,.1,.25,1),opacity 0.6s cubic-bezier(.25,.1,.25,1),padding 0.6s cubic-bezier(.25,.1,.25,1);max-height:0;opacity:0;padding:0">点击上方「AI 建议」按钮，生成本周整体分析报告</div>';
  }
  html+='</div>';

  html+='<div class="wp-feedback-section">';
  html+='<div class="wp-feedback-header">';
  html+='<span class="wp-feedback-title">📝 一周工作小结</span>';
  html+='<span class="wp-feedback-meta">（必填，员工填写）</span>';
  if(summaryUpdatedAt) html+='<span class="wp-feedback-reviewer">更新于：'+summaryUpdatedAt+'</span>';
  html+='</div>';
  if(isEmployee){
    html+='<textarea class="wp-feedback-textarea" id="wpWeekSummary" placeholder="请总结本周工作完成情况、主要产出、遇到的问题及下周计划..." onblur="saveWPFeedback(\'weekSummary\',this.value)">'+_h(summaryContent)+'</textarea>';
    // ★ V0.6.1.hd: 心情选择器 — 员工点击选择本周真实感受（最多2种）
    var currentMoods=[];
    if(Array.isArray(plan.moods)) currentMoods=plan.moods;
    else if(typeof plan.mood==='string' && plan.mood) currentMoods=plan.mood.split(',');
    var moods=[{key:'happy',emoji:'😊',label:'成就',cls:'mood-happy'},{key:'calm',emoji:'😌',label:'平静',cls:'mood-calm'},{key:'tired',emoji:'😩',label:'困顿',cls:'mood-tired'},{key:'aggrieved',emoji:'😢',label:'委屈',cls:'mood-aggrieved'},{key:'silent',emoji:'😶',label:'难言',cls:'mood-silent'}];
    html+='<div class="wp-mood-selector"><span class="wp-mood-label">本周心情：</span><span style="font-size:11px;color:var(--text-hint);margin-left:4px">（最多选 2 种）</span>';
    for(var mi=0;mi<moods.length;mi++){
      var m=moods[mi];
      var isSel=currentMoods.indexOf(m.key)>=0;
      html+='<span class="wp-mood-emoji '+m.cls+(isSel?' mood-selected':'')+'" data-mood-key="'+m.key+'" data-tip="'+m.label+'" onmousedown="event.preventDefault()" onclick="saveWPMood(\''+m.key+'\',this)" title="'+m.label+'">'+m.emoji+'</span>';
    }
    html+='</div>';
  }else if(summaryContent){
    html+='<div class="wp-feedback-textarea" style="background:var(--card-alt);cursor:default">'+_h(summaryContent)+'</div>';
    // 上级看下属时显示其心情
    var moodRead=plan.mood||'';
    if(moodRead){
      var moodMap={happy:{emoji:'😊',label:'开心'},calm:{emoji:'😌',label:'平静'},tired:{emoji:'😩',label:'疲惫'},pain:{emoji:'😭',label:'痛苦'},silent:{emoji:'😶',label:'沉默'}};
      var md=moodMap[moodRead];
      if(md) html+='<div class="wp-mood-display"><span class="wp-mood-display-emoji">'+md.emoji+'</span> '+md.label+'</div>';
    }
  }else{
    html+='<div class="wp-feedback-empty">员工暂未填写工作小结</div>';
  }
  html+='</div>';
  
  // Section 2: Supervisor Review
  var reviewContent = (plan.supervisorReview&&plan.supervisorReview.content)||'';
  var reviewReviewer = (plan.supervisorReview&&plan.supervisorReview.reviewerName)||'';
  var reviewUpdatedAt = (plan.supervisorReview&&plan.supervisorReview.updatedAt)||'';
  
  html+='<div class="wp-feedback-section">';
  html+='<div class="wp-feedback-header">';
  html+='<span class="wp-feedback-title">⭐ 一周工作评价</span>';
  html+='<span class="wp-feedback-meta">（必填，直属上级填写）</span>';
  if(reviewReviewer) html+='<span class="wp-feedback-reviewer">评价人：'+_h(reviewReviewer)+'</span>';
  else if(isSupervisor&&!isEmployee) html+='<span class="wp-feedback-reviewer">（您可在此填写评价）</span>';
  html+='</div>';
  if(isSupervisor&&!isEmployee){
    html+='<textarea class="wp-feedback-textarea" id="wpSupervisorReview" placeholder="请对下属本周工作表现进行评价，包括工作质量、效率、态度等方面..." onblur="saveWPFeedback(\'supervisorReview\',this.value)">'+_h(reviewContent)+'</textarea>';
    // ★ V0.6.1.hh: 奖牌选择器 — 上级点击选择整体评级
    var currentRating=plan.weeklyRating||'';
    var medals=[{key:'gold',emoji:'🥇',label:'金牌 +2',cls:'rating-gold'},{key:'silver',emoji:'🥈',label:'银牌 +1',cls:'rating-silver'},{key:'bronze',emoji:'🥉',label:'铜牌 0',cls:'rating-bronze'},{key:'warn',emoji:'⚠️',label:'待改进 -1',cls:'rating-warn'},{key:'danger',emoji:'⛔',label:'严重偏离 -2',cls:'rating-danger'}];
    html+='<div class="wp-rating-selector"><span class="wp-rating-label">整体评级：</span>';
    for(var ri=0;ri<medals.length;ri++){
      var md=medals[ri];
      html+='<span class="wp-rating-emoji '+md.cls+(currentRating===md.key?' rating-selected':'')+'" data-tip="'+md.label+'" onclick="saveWPRating(\''+md.key+'\',this)" title="'+md.label+'">'+md.emoji+'</span>';
    }
    html+='</div>';
  }else if(reviewContent){
    html+='<div class="wp-feedback-textarea" style="background:var(--card-alt);cursor:default">'+_h(reviewContent)+'</div>';
    // 非上级看下属时显示其评级
    var ratingRead=plan.weeklyRating||'';
    if(ratingRead){
      var ratingMap={gold:{emoji:'🥇',label:'金牌（优秀）'},silver:{emoji:'🥈',label:'银牌（良好）'},bronze:{emoji:'🥉',label:'铜牌（合格）'},warn:{emoji:'⚠️',label:'待改进'},danger:{emoji:'⛔',label:'严重偏离'}};
      var rd=ratingMap[ratingRead];
      if(rd) html+='<div class="wp-rating-display"><span class="wp-rating-display-emoji">'+rd.emoji+'</span> '+rd.label+'</div>';
    }
  }else{
    html+='<div class="wp-feedback-empty">领导暂未评价</div>';
  }
  html+='</div>';
  
  // Section 3: Skip-level Suggestion
  var suggestionContent = (plan.skipLevelSuggestion&&plan.skipLevelSuggestion.content)||'';
  var suggestionReviewer = (plan.skipLevelSuggestion&&plan.skipLevelSuggestion.reviewerName)||'';
  var suggestionUpdatedAt = (plan.skipLevelSuggestion&&plan.skipLevelSuggestion.updatedAt)||'';
  
  html+='<div class="wp-feedback-section">';
  html+='<div class="wp-feedback-header">';
  html+='<span class="wp-feedback-title">💡 一周工作评价与建议</span>';
  html+='<span class="wp-feedback-meta">（选填，上级填写）</span>';
  if(suggestionReviewer) html+='<span class="wp-feedback-reviewer">建议人：'+_h(suggestionReviewer)+'</span>';
  else if(isSupervisor&&!isEmployee) html+='<span class="wp-feedback-reviewer">（您可在此填写建议）</span>';
  html+='</div>';
  if(isSupervisor&&!isEmployee){
    html+='<textarea class="wp-feedback-textarea" id="wpSkipLevelSuggestion" placeholder="如有其他建议或评价，请在此填写..." onblur="saveWPFeedback(\'skipLevelSuggestion\',this.value)">'+_h(suggestionContent)+'</textarea>';
  }else if(suggestionContent){
    html+='<div class="wp-feedback-textarea" style="background:var(--card-alt);cursor:default">'+_h(suggestionContent)+'</div>';
  }else{
    html+='<div class="wp-feedback-empty">暂无评价与建议</div>';
  }
  html+='</div>';
  
  html+='</div>';

  html+='</div>'; /* close wp-page-scroll */

  // ★ V0.6.1cd: 恢复排序前的原始plan.tasks
  if(_wpOrigTasks)plan.tasks=_wpOrigTasks;

  content.insertAdjacentHTML('beforeend',html);

  // 恢复各自滚动位置：页面仅纵向滚动，表格仅横向滚动。
  var _newPageScroll=content.querySelector('.wp-page-scroll');
  var _newTableScroll=content.querySelector('.wp-table-x-scroll');
  if(_newPageScroll&&_savedScrollTop>0)_newPageScroll.scrollTop=_savedScrollTop;
  if(_newTableScroll&&_savedScrollLeft>0)_newTableScroll.scrollLeft=_savedScrollLeft;

  // 周计划表头吸顶：克隆表头，随页面纵滚显示并与任务表横滚同步。
  _bindWPStickyTableHeader(content);

  // ★ V0.5.67: 绑定拖拽事件
  setTimeout(function(){_bindWPDragEvents();},50);

  // ★ V0.4.91n: 绑定耗时表头的自定义 tooltip
  setTimeout(function(){
    var th=content.querySelector('.dur-tooltip');
    if(!th)return;
    var tip=null;
    th.addEventListener('mouseenter',function(e){
      tip=document.createElement('div');
      tip.className='wp-tooltip';
      tip.textContent='注意：耗时统计系统已自动剔除周末及法定节假日。\n员工个人事假、病假等因素，由上级通过调整「计划完成时间」平衡。';
      document.body.appendChild(tip);
      var r=th.getBoundingClientRect();
      tip.style.left=Math.max(8, r.left+r.width/2-tip.offsetWidth/2)+'px';
      tip.style.top=(r.top-tip.offsetHeight-8)+'px';
    });
    th.addEventListener('mouseleave',function(){
      if(tip){tip.remove();tip=null;}
    });
    th.style.cursor='default';
  },10);

  // ★ V0.4.91q: 绑定耗时单元格蓝色角标的自定义 tooltip
  setTimeout(function(){
    var cells=content.querySelectorAll('.col-duration.has-duration[data-dur-tip]');
    cells.forEach(function(cell){
      var cellTip=null;
      cell.addEventListener('mouseenter',function(e){
        var tipText=cell.getAttribute('data-dur-tip')||'';
        if(!tipText)return;
        cellTip=document.createElement('div');
        cellTip.className='wp-tooltip';
        cellTip.style.whiteSpace='pre-line';
        cellTip.textContent=tipText.replace(/&#10;/g,'\n');
        document.body.appendChild(cellTip);
        var r=cell.getBoundingClientRect();
        cellTip.style.left=Math.max(8, r.left+r.width/2-cellTip.offsetWidth/2)+'px';
        cellTip.style.top=(r.top-cellTip.offsetHeight-8)+'px';
      });
      cell.addEventListener('mouseleave',function(){
        if(cellTip){cellTip.remove();cellTip=null;}
      });
    });
  },10);

  // ★ V0.5.68: 绑定计分规则宽限期 tooltip
  setTimeout(function(){
    var graceEl=content.querySelector('.wp-grace-tip');
    if(!graceEl)return;
    var graceTip=null;
    graceEl.addEventListener('mouseenter',function(){
      graceTip=document.createElement('div');
      graceTip.className='wp-tooltip';
      graceTip.textContent='当工作逾期未完成，逾期未到5个工作日时 → 系统状态标注为「逾期完成」，超过5个工作日 → 系统自动判定为「未做」并扣较高分值。具体分值参见右侧「评分标准」。';
      document.body.appendChild(graceTip);
      var r=graceEl.getBoundingClientRect();
      graceTip.style.left=Math.max(8, r.left+r.width/2-graceTip.offsetWidth/2)+'px';
      graceTip.style.top=(r.top-graceTip.offsetHeight-8)+'px';
      graceEl.style.cursor='help';
    });
    graceEl.addEventListener('mouseleave',function(){
      if(graceTip){graceTip.remove();graceTip=null;}
    });
  },10);

  // ★ V0.5.0: 艾森豪威尔矩阵圆点点击跳转
  setTimeout(function(){
    content.querySelectorAll('.wp-em-dot').forEach(function(dot){
      dot.addEventListener('click',function(e){
        e.stopPropagation();
        var y=parseInt(dot.getAttribute('data-y'));
        var m=parseInt(dot.getAttribute('data-m'));
        var w=parseInt(dot.getAttribute('data-w'));
        if(!y||!m||!w)return;
        var yEl=document.getElementById('wpYear');
        if(yEl){yEl.value=y;syncYearLabel();}
        var mEl=document.getElementById('wpMonth');
        if(mEl){mEl.value=m;syncMonthLabel();}
        selectWP(y,m,w);
      });
    });
  },10);
  // ★ V0.6.1.gj: 周计划表格渲染完成后，更新协同人输入建议列表
  _refreshEmpDatalist();
}

// ★ V0.1.23: 审核并锁定 — 上级锁定下属周计划的核心三列
// ★ V0.6.1af: 上级锁定按钮独立状态，不直接 toggle 员工的提交锁定
function toggleWPFreeze(){
  if(!_wpCurrent||!_wpCurrent.plan){_showAlert('请先选择一个周计划');return;}
  var plan=_wpCurrent.plan;
  var myName=(currentUser&&currentUser.name)||'';
  if(plan.frozen && plan.frozenBy===myName){
    // 当前是上级自己锁定的，解除
    plan.frozen=false;
    plan.frozenBy=null;
    plan.frozenAt=null;
    showToast('⚠️ 已解除锁定：下属可重新修改');
  }else{
    // 当前未锁定或员工锁定的，上级接管锁定
    plan.frozen=true;
    plan.frozenAt=new Date().toISOString();
    plan.frozenBy=myName;
    showToast('✅ 已锁定：下属不能修改本周重点/优先级/计划完成日期');
  }
  plan.updatedAt=new Date().toISOString();
  saveWP(plan.year,plan.month,plan.week,plan);
  renderWPTable(plan); // 刷新按钮状态和视觉提示
}

// ★ V0.1.23: 判断某个字段是否被锁定（员工查看自己被上级锁定的计划时）
function isFieldFrozen(cell){
  // 锁定保护只对「员工查看自己的计划」生效
  if(_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember)return false; // 上级/分享查看不受限
  var plan=_wpCurrent?_wpCurrent.plan:null;
  if(!plan)return false;
  var field=cell.dataset.field||'';
  // ★ V0.6.1ac: 双阶段锁定
  //   提交周行动项 → frozen=true → 锁定 work/goal/startDate/plannedDate（4列）
  //   提交周小结 → summarySubmittedAt 存在 → 额外锁定 actualDate
  if(field.indexOf('.actualDate')>0){
    return !!(plan.summarySubmittedAt); // 小结已提交 → actualDate 冻结
  }
  return !!(plan.frozen) && (field.indexOf('.work')>0||field.indexOf('.goal')>0||field.indexOf('.startDate')>0||field.indexOf('.plannedDate')>0);
}

// ========== 单元格编辑 ==========
function startEditCell(cell){
  // ★ V0.5.79b: 只读模式（被分享查看）
  if(_wpViewingShared){
    showToast('📖 只读模式 — 您仅能查看此周计划');
    return;
  }
  // ★ V0.5.55: 上级已完成评价，所有人锁定（直属/间接下属均不可修改）
  if(_wpCurrent.plan && _wpCurrent.plan.bossEvaluated){
    showToast('⚠️ 上级已完成评价，无法再修改');
    return;
  }
  // ★ V0.6.1cf: 修订模式已取消，上级查看下属时可编辑所有字段（锁定保护仍生效）
  // ★ V0.3.127: 锁定保护 — 员工查看自己的计划时，锁定的三列（工作内容/优先级/计划完成日期）不可编辑
  if(isFieldFrozen(cell)){showToast('⚠️ 该列已被锁定，无法修改');return;}
  // 查看下属时且修订模式开启：允许编辑所有字段
  if(_wpEditCell&&_wpEditCell!==cell)commitEditCell();
  // ★ V0.4.91: 自动"未做"时锁定实际完成日期列（手动"未做"不锁定）
  if(field&&field.indexOf('.actualDate')>=0&&_wpCurrent.plan&&_wpCurrent.plan.tasks){
    var _tfParts=field.split('.');
    if(_tfParts[0]==='tasks'){
      var _tfi=parseInt(_tfParts[1]);
      var _tft=_wpCurrent.plan.tasks[_tfi];
      if(_tft&&_tft.status==='未做'&&!_tft._manualNotDone){
        showToast('⚠️ 逾期超5个工作日，系统自动判定为"未做"，实际完成日期已锁定');
        return;
      }
    }
  }
  if(cell.classList.contains('editing'))return;
  var type=cell.dataset.type;
  var field=cell.dataset.field;
  // 如果是修订模式，先读取修订后的值
  // ★ V0.3.103: supporters 字段用原始数据值，避免渲染后的徽章文字(如"⏳ 待响应")污染原始值
  var cur;
  if(field&&field.indexOf('.supporters')>=0&&_wpCurrent.plan&&_wpCurrent.plan.tasks){
    var sfParts=field.split('.');
    cur=(_wpCurrent.plan.tasks[parseInt(sfParts[1])]&&_wpCurrent.plan.tasks[parseInt(sfParts[1])].supporters)||'';
  }else{
    cur=cell.textContent.replace(/来源[：:]\d{4}年\d{1,2}月第[1-4]周|点击填写|填写|选择|上级建议|备注|●/g,'').trim();
    // ★ V0.4.46: 旧状态值映射
    var _oldStatusMap={'✓完成':'按时完成','⚙推进中':'进行中','⏸暂停':'逾期完成','❌未完成':'暂停中'};
    if(_oldStatusMap[cur])cur=_oldStatusMap[cur];
  }
  // ★ V0.6.1cf: 修订值加载已取消，始终使用当前值

  var opts=cell.dataset.opts?cell.dataset.opts.split(','):[];

  cell.classList.add('editing');
  _wpEditCell=cell;

  if(type==='select'){
    var _isStatusField=field&&field.indexOf('.status')>=0;
    if(_isStatusField){
      // V0.4.49: 自定义彩色下拉（原生select无法显示彩色圆点）
      cell.innerHTML='<span style="color:'+((cur&&WP_STATUS_COLORS[cur])||'var(--text-hint)')+';font-size:11px">'+(cur||'--')+'</span>';
      var _dd=document.createElement('div');
      _dd.className='wp-custom-dropdown';
      _dd.style.cssText='display:block;position:fixed;z-index:9999;padding:6px 4px;border-radius:8px;border:1px solid rgba(200,205,212,.4);background:rgba(252,252,253,.95);backdrop-filter:blur(20px) saturate(1.4);box-shadow:0 4px 6px rgba(0,0,0,.04),0 10px 24px rgba(0,0,0,.08)';
      for(var si=0;si<opts.length;si++){
        (function(opt,clr){
          var _optDiv=document.createElement('div');
          _optDiv.className='wp-custom-option'+(opt===cur?' active':'');
          _optDiv.style.cssText='height:28px;font-size:12px;color:#0F2C4B;border-radius:6px;margin:1px 0;padding:0 10px;cursor:pointer;display:flex;align-items:center';
          _optDiv.innerHTML='<span style="color:'+clr+';margin-right:6px;font-size:12px">●</span>'+opt;
          _optDiv.onclick=function(){
            _dd.style.display='none';if(_dd.parentNode)_dd.parentNode.removeChild(_dd);
            var _dot=document.createElement('span');_dot.style.color=clr;_dot.style.marginRight='4px';_dot.textContent='●';_dot.style.fontSize='11px';
            cell.innerHTML='';cell.appendChild(_dot);cell.appendChild(document.createTextNode(opt));
            cell.classList.remove('editing');_wpEditCell=null;commitEditCell();
          };
          _dd.appendChild(_optDiv);
        })(opts[si],WP_STATUS_COLORS[opts[si]]||'#9ca3af');
      }
      document.body.appendChild(_dd);
      var _cr=cell.getBoundingClientRect();_dd.style.left=(_cr.left-2)+'px';_dd.style.width=Math.max(_cr.width,120)+'px';
      _dd.style.top=(_cr.bottom+4)+'px';_dd.style.maxHeight=Math.min(window.innerHeight-_cr.bottom-8,200)+'px';
      setTimeout(function(){document.addEventListener('click',function _onBody(e){if(!_dd.contains(e.target)&&!cell.contains(e.target)){_dd.style.display='none';if(_dd.parentNode)_dd.parentNode.removeChild(_dd);document.removeEventListener('click',_onBody);cell.classList.remove('editing');_wpEditCell=null;if(_wpCurrent.plan)renderWPTable(_wpCurrent.plan);}});},0);
      return;
    }
    // 非状态字段：原生 select
    var _isGoalField=field&&field.indexOf('.goal')>=0;
    if(_isGoalField){
      // V0.4.56: 优先级自定义下拉 — 三色圆点，position:fixed 不遮挡触发器
      var _goalColor=WP_GOAL_COLORS[cur]||'';
      cell.innerHTML='<span style="color:'+(_goalColor||'var(--text-hint)')+';font-size:11px;font-weight:'+(cur?'500':'400')+'">'+(cur||'--')+'</span>';
      var _gdd=document.createElement('div');
      _gdd.className='wp-custom-dropdown';
      _gdd.style.cssText='display:block;position:fixed;z-index:9999;padding:6px 4px;border-radius:8px;border:1px solid rgba(200,205,212,.4);background:rgba(252,252,253,.95);backdrop-filter:blur(20px) saturate(1.4);box-shadow:0 4px 6px rgba(0,0,0,.04),0 10px 24px rgba(0,0,0,.08);min-width:130px';
      for(var gi=0;gi<opts.length;gi++){
        (function(opt,gclr){
          var _gOptDiv=document.createElement('div');
          _gOptDiv.className='wp-custom-option'+(opt===cur?' active':'');
          _gOptDiv.style.cssText='height:28px;font-size:12px;color:#0F2C4B;border-radius:6px;margin:1px 0;padding:0 10px;cursor:pointer;display:flex;align-items:center';
          _gOptDiv.innerHTML='<span style="color:'+gclr+';margin-right:6px;font-size:12px">●</span>'+opt;
          _gOptDiv.onclick=function(){
            _gdd.style.display='none';if(_gdd.parentNode)_gdd.parentNode.removeChild(_gdd);
            cell.innerHTML='<span style="color:'+gclr+';font-size:11px;font-weight:500">'+opt+'</span>';
            cell.classList.remove('editing');_wpEditCell=null;
            // 手动更新 plan 数据并保存
            var _gf=cell.dataset.field;
            if(_gf&&_wpCurrent.plan){var _gp=_gf.split('.');if(_gp[0]==='tasks'){var _gti=parseInt(_gp[1]);if(_wpCurrent.plan.tasks[_gti]){var _t=_wpCurrent.plan.tasks[_gti];_t[_gp[2]]=opt;if(_gp[2]==='status'){if(opt==='未做'){_t._manualNotDone=true;}else{delete _t._manualNotDone;}if(opt==='暂停中'){_t._pausedAt=_getTodayStr();}else{delete _t._pausedAt;}}_wpCurrent.plan.updatedAt=new Date().toISOString();_calcWeekScore(_wpCurrent.plan);saveWP(_wpCurrent.plan.year,_wpCurrent.plan.month,_wpCurrent.plan.week,_wpCurrent.plan);setTimeout(function(){if(!_wpEditCell&&_wpCurrent.plan)renderWPTable(_wpCurrent.plan);},0);}}}
          };
          _gdd.appendChild(_gOptDiv);
        })(opts[gi],WP_GOAL_COLORS[opts[gi]]||'#9ca3af');
      }
      document.body.appendChild(_gdd);
      var _gcr=cell.getBoundingClientRect();_gdd.style.left=(_gcr.left-2)+'px';_gdd.style.width=Math.max(_gcr.width,130)+'px';
      _gdd.style.top=(_gcr.bottom+4)+'px';_gdd.style.maxHeight=Math.min(window.innerHeight-_gcr.bottom-8,160)+'px';
      setTimeout(function(){document.addEventListener('click',function _onGBody(e){if(!_gdd.contains(e.target)&&!cell.contains(e.target)){_gdd.style.display='none';if(_gdd.parentNode)_gdd.parentNode.removeChild(_gdd);document.removeEventListener('click',_onGBody);cell.classList.remove('editing');_wpEditCell=null;if(_wpCurrent.plan)renderWPTable(_wpCurrent.plan);}});},0);
      return;
    }
    var s='<select class="wp-cell-select" onchange="commitEditCell(this)"><option value="">--</option>';
    for(var i=0;i<opts.length;i++){
      s+='<option value="'+opts[i]+'"'+(opts[i]===cur?' selected':'')+'>'+opts[i]+'</option>';
    }
    s+='</select>';
    cell.innerHTML=s;
    var selEl=cell.querySelector('select');if(selEl){selEl.focus();selEl.addEventListener('blur',function(){commitEditCell(this);});}
  }else if(type==='textarea'){
    cell.innerHTML='<textarea class="wp-cell-textarea" onblur="commitEditCell()">'+_h(cur)+'</textarea>';
    var ta=cell.querySelector('textarea');if(ta){_wpBindLiveTaskPersistence(cell,ta);ta.focus();}
  }else if(type==='number'){
    cell.innerHTML='<input class="wp-cell-input" type="number" step="0.5" min="0" value="'+_h(cur)+'" onblur="commitEditCell()">';
    var inp=cell.querySelector('input');if(inp){_wpBindLiveTaskPersistence(cell,inp);inp.focus();}
  }else if(type==='date'){
    // 计划完成日期：HTML5 原生日历选择器
    var dateVal=cur;
    if(!dateVal&&field){
      var fparts=field.split('.');
      if(fparts[0]==='tasks'&&_wpCurrent.plan&&_wpCurrent.plan.tasks){
        var ti2=parseInt(fparts[1]);
        var t2=_wpCurrent.plan.tasks[ti2];
        if(t2&&t2.plannedDate)dateVal=t2.plannedDate;
      }
    }
    cell.innerHTML='<input class="wp-cell-input" type="date" value="'+_h(dateVal)+'" onblur="commitEditCell()" onchange="commitEditCell(this)">';
    var dEl=cell.querySelector('input');if(dEl){_wpBindLiveTaskPersistence(cell,dEl);dEl.focus();dEl.style.minWidth='120px';}
  }else{
    // ★ V0.6.1.gv: 协同人列 — chip 标签 + 自定义 portal 下拉
    var isSupporters=field&&field.indexOf('.supporters')>=0;
    if(isSupporters){
      cell.innerHTML='<div class="supporter-chip-editor" style="display:flex;flex-wrap:wrap;gap:3px;align-items:center;min-width:100px;padding:2px 0"></div>';
      var editor=cell.querySelector('.supporter-chip-editor');
      var names=cur?cur.split(/[,，;；]/).filter(function(x){return x.trim();}):[];
      var seen={};
      for(var nx=0;nx<names.length;nx++){
        var nm=names[nx].trim();
        if(nm&&!seen[nm]){
          seen[nm]=true;
          var chip=document.createElement('span');
          chip.className='supporter-chip';
          chip.style.cssText='display:inline-flex;align-items:center;background:#E8F0FE;color:#1B6EC4;font-size:11px;font-weight:500;padding:2px 6px;border-radius:12px;gap:4px;white-space:nowrap';
          chip.innerHTML='<span>'+_h(nm)+'</span><span class="chip-x" style="cursor:pointer;opacity:.6;font-size:13px;line-height:1" onclick="this.parentNode.remove()">&times;</span>';
          editor.appendChild(chip);
        }
      }
      var inp=document.createElement('input');
      inp.type='text';inp.className='wp-cell-input';
      inp.setAttribute('autocomplete','off');
      inp.style.cssText='flex:1;min-width:60px;border:none;outline:none;font-size:12px;padding:2px 0;background:transparent';
      inp.placeholder='输入姓名后回车';

      // ★ V0.6.1.gv: 自定义下拉（portal 模式 - 挂 body 不被 td 截断）
      var dropdown=document.createElement('div');
      dropdown.className='supporter-dropdown';
      dropdown.style.cssText='display:none;position:fixed;z-index:99999;background:rgba(255,255,255,.8);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.12);max-height:200px;overflow-y:auto;min-width:160px;font-size:12px;line-height:1';
      document.body.appendChild(dropdown);

      function positionDropdown(){
        // ★ V0.6.1.gw: 跟 cell 对齐(不是input),中线与单元格对齐
        var cellRect=cell.getBoundingClientRect();
        dropdown.style.left=cellRect.left+'px';
        dropdown.style.top=(cellRect.bottom+2)+'px';
        dropdown.style.minWidth=cellRect.width+'px';
      }
      function createChipFromInput(inputEl,forcedVal){
        var v=(forcedVal!==undefined?forcedVal:inputEl.value).trim();
        if(!v)return;
        var chip2=document.createElement('span');
        chip2.className='supporter-chip';
        chip2.style.cssText='display:inline-flex;align-items:center;background:#E8F0FE;color:#1B6EC4;font-size:11px;font-weight:500;padding:2px 6px;border-radius:12px;gap:4px;white-space:nowrap';
        chip2.innerHTML='<span>'+_h(v)+'</span><span class="chip-x" style="cursor:pointer;opacity:.6;font-size:13px;line-height:1" onclick="this.parentNode.remove()">&times;</span>';
        editor.insertBefore(chip2,inputEl);
        if(forcedVal!==undefined){inputEl.value='';inputEl.focus();}
        else inputEl.value='';
      }
      function showDropdown(q){
        dropdown.innerHTML='';
        var pool=(typeof allEmployees!=='undefined'&&allEmployees&&allEmployees.length>0)?allEmployees:_getEmpDB();
        var hits=[];
        for(var i=0;i<pool.length;i++){
          var e=pool[i];if(!e||!e.name)continue;
          if(!q||e.name.indexOf(q)>=0){
            var dup=false;for(var j=0;j<hits.length;j++)if(hits[j].name===e.name){dup=true;break;}
            if(!dup)hits.push(e);
          }
        }
        if(hits.length===0){dropdown.style.display='none';return;}
        for(var k=0;k<Math.min(hits.length,8);k++){
          (function(emp){
            var item=document.createElement('div');
            // ★ Tiger 三个要求:行高1.0 + 12px同输入框 + 背景透白
            item.style.cssText='padding:5px 10px;cursor:pointer;font-size:12px;color:#1f2937;line-height:1;white-space:nowrap';
            item.textContent=emp.name;
            item.onmouseover=function(){item.style.background='rgba(232,240,254,.9)';};
            item.onmouseout=function(){item.style.background='transparent';};
            // ★ 用 mousedown 而非 click + preventDefault，避免 dropdown blur 关闭
            item.onmousedown=function(e){
              e.preventDefault();e.stopPropagation();
              createChipFromInput(inp,emp.name);
              dropdown.style.display='none';
            };
            dropdown.appendChild(item);
          })(hits[k]);
        }
        positionDropdown();
        dropdown.style.display='block';
      }
      // ★ focus 时不主动弹（避免空白显示全部员工）
      inp.addEventListener('focus',function(){if(inp.value)showDropdown(inp.value);});
      inp.addEventListener('input',function(){showDropdown(inp.value);});
      inp.addEventListener('keydown',function(e){
        if(e.key==='Enter'||e.key===','||e.key==='，'){
          e.preventDefault();
          createChipFromInput(inp);
          dropdown.style.display='none';
        }else if(e.key==='Escape'){
          dropdown.style.display='none';
        }
      });
      inp.addEventListener('blur',function(){
        setTimeout(function(){
          dropdown.style.display='none';
          if(dropdown.parentNode)dropdown.parentNode.removeChild(dropdown);
          commitEditCell(inp);
        },200);
      });
      editor.appendChild(inp);
      setTimeout(function(){inp.focus();},30);
    }else{
      cell.innerHTML='<input class="wp-cell-input" type="text" value="'+_h(cur)+'" onblur="commitEditCell()">';
      var inp2=cell.querySelector('input');if(inp2){_wpBindLiveTaskPersistence(cell,inp2);inp2.focus();}
    }
  }
}

async function commitEditCell(el){
  // el: when called from inline handler, receives the input/select/textarea element
  var cell=el?el.closest('td.editing'):_wpEditCell;
  if(!cell)return;
  try{
    var field=cell.dataset.field;
    var input=el||cell.querySelector('input,textarea,select');
    var newVal=input?input.value:'';
    // ★ V0.6.1.gl: 协同人 chip 编辑器 — 从 chips 收集姓名，逗号分隔
    if(field&&field.indexOf('.supporters')>=0){
      var chips=cell.querySelectorAll('.supporter-chip span:first-child');
      var names=[];
      for(var c=0;c<chips.length;c++){
        var n=chips[c].textContent.trim();
        if(n)names.push(n);
      }
      newVal=names.join(',');
    }

    // ★ V0.4.90m: 状态字段自定义下拉无 input，从 cell 文本提取
    if(!newVal && field && field.indexOf('.status')>=0){
      var tc=cell.textContent||'';
      var sMap={'按时完成':'按时完成','进行中':'进行中','逾期完成':'逾期完成','暂停中':'暂停中','未做':'未做'};
      for(var sk in sMap){if(tc.indexOf(sk)>=0){newVal=sMap[sk];break;}}
    }
    // ★ V0.5.54: 优先级字段自定义下拉无 input，从 cell 文本提取（防御性修复）
    if(!newVal && field && field.indexOf('.goal')>=0){
      var tc2=cell.textContent||'';
      for(var gi=0;gi<WP_GOAL_OPTIONS.length;gi++){if(tc2.indexOf(WP_GOAL_OPTIONS[gi])>=0){newVal=WP_GOAL_OPTIONS[gi];break;}}
    }

    cell.classList.remove('editing');
    _wpEditCell=null;

    // ★ V0.4.91i: 计划完成日期早于启动日期 → 弹窗警告并拒绝保存
    if(field&&field.indexOf('.plannedDate')>=0&&newVal&&_wpCurrent.plan&&_wpCurrent.plan.tasks){
      var _pp=field.split('.');
      if(_pp[0]==='tasks'){
        var _pti=parseInt(_pp[1]);
        var _pt=_wpCurrent.plan.tasks[_pti];
        if(_pt&&_pt.startDate&&newVal<_pt.startDate){
          await _showAlert('你正在输入的"计划完成日期"早于"启动日期"，请确认并重新输入。\n\n—\n\nThe planned completion date you entered is earlier than the start date. Please confirm and re-enter.','⚠️ 日期错误 / Date Error');
          // 恢复旧值并重新渲染
          setTimeout(function(){if(_wpCurrent.plan)renderWPTable(_wpCurrent.plan);},0);
          return;
        }
      }
    }

    console.log('[DEBUG commitEditCell] field='+field+' newVal="'+newVal+'" viewingSub='+_wpViewingSubordinate+' viewingShared='+_wpViewingShared+' planName='+(_wpCurrent.plan&&_wpCurrent.plan.name));
    if(field&&_wpCurrent.plan){
      var parts=field.split('.');
      if(parts[0]==='tasks'){
        var ti=parseInt(parts[1]);
        if(_wpCurrent.plan.tasks[ti]){
          // ★ V0.6.1cf: 修订模式已取消，直接更新字段值
          var oldVal=_wpCurrent.plan.tasks[ti][parts[2]];
          _wpCurrent.plan.tasks[ti][parts[2]]=newVal;
          console.log('[DEBUG commitEditCell] UPDATED tasks['+ti+'].'+parts[2]+': "'+oldVal+'" → "'+newVal+'"');
          // ★ V0.4.91: 自动状态识别（新积分规则+工作日宽限期）
          if(parts[2]==='actualDate' && newVal){
            var tsk=_wpCurrent.plan.tasks[ti];
            var pDate=tsk.plannedDate;
            if(tsk.status==='暂停中'){
              // 保持用户手动状态，不做自动判断
            }else if(tsk.status==='未做' && tsk._manualNotDone){
              // 手动"未做"→终止计算时间，但允许填实际日期来恢复
              if(pDate){
                if(newVal<=pDate){
                  tsk.status='按时完成';delete tsk._manualNotDone;
                }else{
                  var _ovd=_countWorkdays(pDate,newVal);
                  if(_ovd>5){tsk.status='未做';delete tsk._manualNotDone;}
                  else{tsk.status='逾期完成';delete tsk._manualNotDone;}
                }
              }
            }else if(pDate){
              if(newVal<=pDate){
                tsk.status='按时完成';
              }else{
                var _ovd2=_countWorkdays(pDate,newVal);
                if(_ovd2>5){tsk.status='未做';delete tsk._manualNotDone;}
                else{tsk.status='逾期完成';}
              }
            }
          } else if(parts[2]==='actualDate' && !newVal){
            // ★ V0.5.48: 清空实际完成日期 → 状态自动恢复为"进行中"（暂停中保留）
            var tsk=_wpCurrent.plan.tasks[ti];
            if(tsk.status!=='暂停中'){
              tsk.status='进行中';
              delete tsk._manualNotDone;
            }
          }
        }
      }
      _wpCurrent.plan.updatedAt=new Date().toISOString();
      _calcWeekScore(_wpCurrent.plan); // ★ V0.4.91b: 先计算状态再保存
      saveWP(_wpCurrent.plan.year,_wpCurrent.plan.month,_wpCurrent.plan.week,_wpCurrent.plan);
    }
  }catch(e){
    if(cell)cell.classList.remove('editing');
    _wpEditCell=null;
  }
  setTimeout(function(){ if(!_wpEditCell&&_wpCurrent.plan){console.log('[DEBUG commitEditCell] re-rendering — plan tasks[0].work='+(_wpCurrent.plan.tasks[0]&&_wpCurrent.plan.tasks[0].work));renderWPTable(_wpCurrent.plan);} }, 0);
}

// ========== 工具栏操作 ==========
// 将当前页面仍存在的编辑控件强制写回 plan。不能只依赖 blur/_wpEditCell：点击顶部按钮时，浏览器事件顺序可能已清空编辑标记。
function _wpFlushVisibleEdits(){
  var p=_wpCurrent&&_wpCurrent.plan;
  var root=document.getElementById('wpContent');
  if(!p||!p.tasks||!root)return false;
  var changed=false;
  var cells=root.querySelectorAll('td[data-field]');
  for(var i=0;i<cells.length;i++){
    var cell=cells[i], field=cell.dataset.field||'';
    var control=cell.querySelector('input,textarea,select');
    if(!control||field.indexOf('tasks.')!==0)continue;
    var parts=field.split('.'), ti=parseInt(parts[1]), prop=parts[2];
    if(isNaN(ti)||!prop||!p.tasks[ti])continue;
    var value=control.value;
    if(prop==='supporters'){
      var chips=cell.querySelectorAll('.supporter-chip span:first-child');
      if(chips.length){
        var names=[];
        for(var c=0;c<chips.length;c++){var name=chips[c].textContent.trim();if(name)names.push(name);}
        value=names.join(',');
      }
    }
    if(p.tasks[ti][prop]!==value){
      p.tasks[ti][prop]=value;
      changed=true;
    }
  }
  if(changed){
    p.updatedAt=new Date().toISOString();
    _calcWeekScore(p);
    _wpData[makeWPId(p.year,p.month,p.week)]=p;
  }
  return changed;
}

// 顶部“保存并返回首页”必须独立处理：心情操作会保留输入焦点，离开前由 DOM 级兜底提交所有可见编辑值。
async function saveWPAndGoHome(){
  try{
    // ★ j79: 强制DOM扫描 — 不从 _wpCurrent.plan 读，直接从页面上所有 td[data-field] 读取
    var p=_wpCurrent&&_wpCurrent.plan;
    if(!p||!_wpCurrent.year||_wpViewingShared)return goHome();

    // ★ 直接扫描DOM — 无论 textarea 是否已提交，强制读取可见值
    var root=document.getElementById('wpContent');
    var scannedAny=false;
    if(root&&p.tasks){
      var cells=root.querySelectorAll('td[data-field]');
      for(var ci=0;ci<cells.length;ci++){
        var cell=cells[ci], field=cell.dataset.field||'';
        if(field.indexOf('tasks.')!==0)continue;
        var parts=field.split('.'), ti=parseInt(parts[1]), prop=parts[2];
        if(isNaN(ti)||!prop||!p.tasks[ti])continue;
        // 优先从textarea/input直接读，兜底读textContent
        var ctrl=cell.querySelector('input,textarea,select');
        var value=ctrl?ctrl.value:cell.textContent.replace(/点击填写|选择|点击选择日期|备注|上级建议/g,'').trim();
        if(prop==='supporters'){
          var chips=cell.querySelectorAll('.supporter-chip span:first-child');
          if(chips.length){var names=[];for(var cx=0;cx<chips.length;cx++){var n=chips[cx].textContent.trim();if(n)names.push(n);}value=names.join(',');}
        }
        if(value!==p.tasks[ti][prop]){
          p.tasks[ti][prop]=value;
          scannedAny=true;
        }
      }
    }

    // 也检查并提交当前编辑中的cell
    _wpFlushVisibleEdits();
    if(_wpEditCell)await commitEditCell();

    p.updatedAt=new Date().toISOString();
    _calcWeekScore(p);
    var id=makeWPId(p.year,p.month,p.week);
    _wpData[id]=p;
    
    // ★ j79 diagnostic: 保存前打印内容
    var workPreview=p.tasks&&p.tasks[0]?p.tasks[0].work:'';
    console.log('[J79 SAVE] '+id+' task0work="'+workPreview.substr(0,40)+'" scanned='+scannedAny+' totalTasks='+(p.tasks?p.tasks.length:0));

    // 先写 localStorage，再写云端（只写当前周）
    localStorage.setItem(getWPLocalStorageKey(),JSON.stringify(_wpData));
    await saveWPData(id);
  }catch(e){
    console.error('[WP] 保存并返回首页失败:',e);
    if(typeof showToast==='function')showToast('⚠️ 周计划保存失败，请重试','warning');
    return;
  }
  goHome();
}

// ★ V0.1.35: 「完成提交」按钮 — 记录首次提交时间并保存
async function submitWPPlan(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}
  // ★ V0.6.1bs: 提交前自动删除空行（本周重点行动项为空的任务行）
  if(p.tasks&&p.tasks.length){
    var beforeCount=p.tasks.length;
    p.tasks=p.tasks.filter(function(t){return t.work&&t.work.trim();});
    var removed=beforeCount-p.tasks.length;
    if(removed>0){console.log('[submitWPPlan] 自动删除空行: '+removed+' 行');}
  }
  var ok=await _showConfirm('确认提交本周行动项？\n\n提交后将记录提交时间，可随时继续编辑。'+'\n\n—\n\nConfirm submission?\n\nSubmission time will be recorded. You can continue editing at any time.','注意 / Attention');
  if(!ok)return;
  p.firstSubmittedAt=new Date().toISOString();
  // ★ V0.1.57: 提交即自动锁定三列（员工自己不能改），等同上级锁定效果
  p.frozen=true;
  p.frozenAt=new Date().toISOString();
  p.frozenBy=(currentUser&&currentUser.name)||'';
  p.updatedAt=new Date().toISOString();
  // ★ V0.6.1cd: 提交后自动按优先级排序
  if(p.tasks&&p.tasks.length>0){
    p.tasks.sort(function(a,b){var va=WP_PRIORITY_ORDER[a.goal]||99,vb=WP_PRIORITY_ORDER[b.goal]||99;return va-vb;});
  }
  saveWP(p.year,p.month,p.week,p);
  _calcWeekScore(p);
  renderWPTable(p);
  showToast('✅ 已提交并锁定，已自动按优先级排序');
}

// ★ V0.1.44: 撤销提交 — 清除提交时间戳+解除锁定，允许员工重新提交
async function undoWPSubmit(){
  var p=_wpCurrent.plan;if(!p){return;}
  // ★ V0.6.1ad: 运行时守卫 — 上级已评价不能撤回
  if(p.bossEvaluated){_showAlert('上级已完成评价，无法撤回周行动项。');return;}
  // ★ V0.6.1ad: 运行时守卫 — 需先撤回周小结
  if(p.summarySubmittedAt){_showAlert('请先撤回周小结，再撤回周行动项。');return;}
  // ★ V0.6.1ad: 运行时守卫 — 上级已锁定不能撤回
  var myName=(currentUser&&currentUser.name)||'';
  if(p.frozen && p.frozenBy && p.frozenBy!==myName){_showAlert('上级已锁定周计划，请联系上级解除锁定后再撤回。');return;}
  var ok=await _showConfirm('确认撤销本次提交？\n\n撤销后：\n① 首次提交时间将被清除\n② 锁定将解除，可重新修改\n③ 最终提交时间以最后一次提交为准。'+'\n\n—\n\nConfirm undo?\n\nAfter undo:\n① First submission timestamp will be cleared\n② Locks will be released, allowing re-edit\n③ Final submission time will be based on the last submission.','注意 / Attention');
  if(!ok)return;
  p.firstSubmittedAt=null;
  // ★ V0.1.57: 撤销同时解除锁定（仅限自己提交触发的锁定；不解除上级手动锁定）
  var myName=(currentUser&&currentUser.name)||'';
  if(p.frozen && (!p.frozenBy || p.frozenBy===myName)){
    p.frozen=false;
    p.frozenAt=null;
  }
  p.updatedAt=new Date().toISOString();
  saveWP(p.year,p.month,p.week,p);
  _calcWeekScore(p);
  renderWPTable(p);
  showToast('↩ 已撤销提交并解锁，可重新修改后再提交');
}

// ★ V0.1.41: 员工完成周工作小结（记录小结时间用于考勤积分）+ 锁定三列
async function submitWPWeekSummary(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}
  // 检查是否已填写小结
  if(!p.weekSummary||!p.weekSummary.trim()){
    _showAlert('请先在下方「一周工作小结」区域填写本周工作总结后再点击「完成小结」。');
    return;
  }
  var confirmed=await _showConfirm('确认完成本周工作小结？<br><br>提交后将记录完成时间用于考勤积分计算，同时锁定工作内容/优先级/计划完成日期。<br><br>—<br><br>Confirm completion of this week\'s work summary?<br><br>After submission, the completion time will be recorded for attendance score calculation, and the work content/priority/planned completion date will be locked.','工作小结确认 / Work Summary Confirmation');
  if(!confirmed)return;
  p.summarySubmittedAt=new Date().toISOString();
  // ★ V0.3.126: 完成小结也锁定三列
  p.frozen=true;
  p.frozenAt=new Date().toISOString();
  p.frozenBy=(currentUser&&currentUser.name)||'';
  p.updatedAt=new Date().toISOString();
  saveWP(p.year,p.month,p.week,p);
  _calcWeekScore(p);
  renderWPTable(p);
  showToast('✅ 工作小结已完成，三列已锁定');
}

// ★ V0.6.1z: 撤回周小结 — 清除小结提交时间戳+解除自锁定
async function undoWPWeekSummary(){
  var p=_wpCurrent.plan;if(!p){return;}
  // ★ V0.6.1aa: 运行时守卫 — 上级已评价不能撤回
  if(p.bossEvaluated){_showAlert('上级已完成评价，无法撤回周小结。');return;}
  var ok=await _showConfirm('确认撤回本周小结？\n\n撤回后：\n① 小结提交时间将被清除\n② 锁定将解除，可重新修改后再提交。'+'\n\n—\n\nConfirm undo summary?\n\nAfter undo:\n① Summary submission timestamp will be cleared\n② Locks will be released, allowing re-edit and re-submit.','注意 / Attention');
  if(!ok)return;
  p.summarySubmittedAt=null;
  var myName=(currentUser&&currentUser.name)||'';
  if(p.frozen && (!p.frozenBy || p.frozenBy===myName)){
    p.frozen=false;
    p.frozenAt=null;
  }
  p.updatedAt=new Date().toISOString();
  saveWP(p.year,p.month,p.week,p);
  _calcWeekScore(p);
  renderWPTable(p);
  showToast('↩ 周小结已撤回，可重新修改后再提交');
}

// ★ V0.1.35: 计算本周截止时间（周六12:00）
function _getWeekDeadline(year,month,week){
  // 找到本周六的日期
  var jan4=new Date(year,0,4); // ISO周：1月4日所在的周是第1周
  var jan4Day=jan4.getDay()||7; // 周日=7
  var week1Mon=new Date(jan4); week1Mon.setDate(jan4.getDate()-(jan4Day-1));
  var weekFri=new Date(week1Mon); weekFri.setDate(week1Mon.getDate()+(week-1)*7+4); // +4 = 周五
  var sat=new Date(weekFri); sat.setDate(weekFri.getDate()+1); // 周六
  sat.setHours(12,0,0,0);
  return sat;
}

// ★ V0.6.1.iy: 法定节假日豁免 — 提交截止时间恰逢法定节假日即免除扣分
function _isDeadlineHoliday(year,month,week){
  var sat=_getWeekDeadline(year,month,week);
  var dateStr=sat.getFullYear()+'-'+String(sat.getMonth()+1).padStart(2,'0')+'-'+String(sat.getDate()).padStart(2,'0');
  var hy=CN_HOLIDAYS[year];
  if(hy&&hy._hSet&&hy._hSet.has(dateStr))return true;
  return false;
}

// ★ V0.1.35: 判断提交/评价是否按时
// 返回: "on_time" | "late" | "exempted" | "pending"
function _checkSubmissionStatus(plan,type){
  // type: "submit" 或 "review"
  if(type==='submit'){
    if(plan.exempted)return 'exempted';
    if(!plan.firstSubmittedAt)return 'pending';
    var deadline=_getWeekDeadline(plan.year,plan.month,plan.week);
    return new Date(plan.firstSubmittedAt)<=deadline?'on_time':'late';
  }else if(type==='review'){
    if(!plan.bossReviewedAt)return 'pending';
    // 上级评价截止：下周一12:00
    var sat=_getWeekDeadline(plan.year,plan.month,plan.week);
    var mon12=new Date(sat); mon12.setDate(sat.getDate()+2); mon12.setHours(12,0,0,0);
    return new Date(plan.bossReviewedAt)<=mon12?'on_time':'late';
  }
  return 'pending';
}

// ★ V0.6.1ac: 判断周小结是否按时提交
function _checkSummarySubmissionStatus(plan){
  if(plan.exempted)return 'exempted';
  if(!plan.summarySubmittedAt)return 'pending';
  var deadline=_getWeekDeadline(plan.year,plan.month,plan.week);
  return new Date(plan.summarySubmittedAt)<=deadline?'on_time':'late';
}

// ★ V0.1.35: 评分存储 (localStorage: wp_scores_{uid}_{year})
function _getAnnualScores(uid,year){
  if(!uid||!year)return null;
  try{
    var key='wp_scores_'+uid+'_'+year;
    var raw=localStorage.getItem(key);
    if(raw){
      var parsed=JSON.parse(raw);
      // ★ V0.6.1x: 如果存在旧格式的 total/deducted 但缺少新分类字段，清除旧数据确保净积分正确
      if(parsed.total!==undefined||parsed.deducted!==undefined){
        var hasNewFields=false;
        for(var wid in parsed.weeks){if(parsed.weeks[wid].onTimeScore!==undefined){hasNewFields=true;break;}}
        if(!hasNewFields){delete parsed.total;delete parsed.deducted;delete parsed.net;}
      }
      return parsed;
    }
  }catch(e){}
  return {year:year,net:0,weeks:{}};
}

function _saveAnnualScores(uid,year,scores){
  if(!uid||!year)return;
  try{
    var key='wp_scores_'+uid+'_'+year;
    localStorage.setItem(key,JSON.stringify(scores));
  }catch(e){console.warn('_saveAnnualScores failed',e);}
}

// ★ V0.1.35: 计算本周得分
function _calcWeekScore(plan){
  if(!plan||!plan.year)return;
  var uid=getViewedUserEmp().name||(currentUser&&currentUser.name);
  if(!uid)return;
  var year=plan.year;
  var weekId=plan.year+'-W'+plan.week;
  var scores=_getAnnualScores(uid,year);
  if(!scores.weeks)scores.weeks={};

  var subStatus=_checkSubmissionStatus(plan,'submit');
  var sumStatus=_checkSummarySubmissionStatus(plan);
  var revStatus=_checkSubmissionStatus(plan,'review');
  var weekScore=0;

  // ★ 分类统计（用于明细面板）
  var onTimeScore=0,overdueScore=0,notDoneScore=0,lateSubmitScore=0,reviewScore=0,onTimeSubmitScore=0;

  // ★ V0.6.1ac: 统计之前已有的累计延迟次数（排除当前周，因为当前周数据可能不完整）
  var existingLateCount=0;
  for(var wid in scores.weeks){
    if(wid===weekId)continue;
    var ews=scores.weeks[wid];
    if(ews.submittedStatus==='late')existingLateCount++;
    if(ews.summaryStatus==='late')existingLateCount++;
  }

  // ★ V0.6.1.iy: 法定节假日豁免 — 周六截止日恰逢法定节假日，免除扣分
  if(_isDeadlineHoliday(plan.year,plan.month,plan.week))plan.exempted=true;

  // ★ V0.6.1.iy: 提交评分（对齐制度 — 按时+0.5，未按时-1，第4次起-2）
  if(subStatus==='exempted'){
    // 法定节假日豁免，不加分也不扣分
  }else if(subStatus==='on_time'){weekScore+=0.5;onTimeSubmitScore=0.5;}
  else if(subStatus==='late'&&plan.firstSubmittedAt){
    existingLateCount++;
    var penalty=(existingLateCount>3)?-2:-1;
    lateSubmitScore+=penalty;weekScore+=penalty;
  }

  // ★ V0.6.1.iy: 小结提交评分（按时+0.5，未按时同规则）
  if(sumStatus==='exempted'){
    // 法定节假日豁免
  }else if(sumStatus==='on_time'){weekScore+=0.5;/* 小结按时得分已在制度统一合并为+0.5 */}
  else if(sumStatus==='late'&&plan.summarySubmittedAt){
    existingLateCount++;
    var spenalty=(existingLateCount>3)?-2:-1;
    lateSubmitScore+=spenalty;weekScore+=spenalty;
  }

  // 评价奖励（仅上级按时完成时给下属加分）
  if(revStatus==='on_time'){weekScore+=2;reviewScore=2;}

  // ★ V0.4.91: 任务完成评分（新积分规则+5工作日宽限期+法定节假日排除）
  var taskScore=0;
  var _taskScores=[];
  if(plan.tasks){
    for(var ti=0;ti<plan.tasks.length;ti++){
      var tt=plan.tasks[ti];
      var pts=0;
      // 跳过：空行、协同任务（非责任人）、无优先级、无计划日期
      if(!tt.work||!tt.work.trim()){_taskScores.push(0);continue;}
      if(tt.collab_from){_taskScores.push(0);continue;}
      if(!tt.goal||!tt.plannedDate){_taskScores.push(0);continue;}

      var sc=_TASK_SCORE_MAP[tt.goal];
      if(!sc){_taskScores.push(0);continue;}

      var actualDate=tt.actualDate||'';
      var today=_getTodayStr();

      if(tt.status==='暂停中'){
        // 暂停中 → 0分，不自动判定
        pts=0;
      }else if(tt.status==='未做' && tt._manualNotDone){
        // 用户手动选择"未做"→ 终止计算时间，积分=0
        pts=0;
      }else if(actualDate){
        // ★ 有实际完成日期
        if(actualDate<=tt.plannedDate){
          tt.status='按时完成'; pts=sc.onTime; onTimeScore+=pts;
        }else{
          var wdOverdue=_countWorkdays(tt.plannedDate,actualDate);
          if(wdOverdue>5){
            tt.status='未做'; delete tt._manualNotDone; pts=sc.notDone; notDoneScore+=pts;
          }else{
            tt.status='逾期完成'; pts=sc.overdue; overdueScore+=pts;
          }
        }
      }else{
        // ★ 无实际完成日期 → 按今天判定
        if(today<=tt.plannedDate){
          tt.status='进行中'; pts=0;
        }else{
          var wdPassed=_countWorkdays(tt.plannedDate,today);
          if(wdPassed>5){
            tt.status='未做'; delete tt._manualNotDone; pts=sc.notDone; notDoneScore+=pts;
          }else{
            tt.status='进行中'; pts=0;
          }
        }
      }
      taskScore+=pts;
      _taskScores.push(pts);
    }
  }
  plan._taskScores=_taskScores;
  weekScore+=taskScore;

  // ★ V0.6.1.hh: 上级评级加分（金+2 银+1 铜0 待改-1 严重-2）
  // 奖牌选择即为有效评级；撤销完整评价或再次点击同一奖牌都会清空 weeklyRating，因此空值不会参与积分。
  var ratingScore=0;
  var ratingMap={gold:2, silver:1, bronze:0, warn:-1, danger:-2};
  var effectiveRating=plan.weeklyRating||'';
  if(effectiveRating && ratingMap[effectiveRating]!==undefined){
    ratingScore=ratingMap[effectiveRating];
  }
  weekScore+=ratingScore;

  // 豁免时归零
  if(plan.exempted)weekScore=0;

  // 记录本周（含明细）
  scores.weeks[weekId]={
    submittedStatus:subStatus, summaryStatus:sumStatus, reviewedStatus:revStatus,
    exempted:!!plan.exempted, score:weekScore,
    taskScore:taskScore,
    onTimeScore:onTimeScore, overdueScore:overdueScore,
    notDoneScore:notDoneScore, lateSubmitScore:lateSubmitScore,
    reviewScore:reviewScore, onTimeSubmitScore:onTimeSubmitScore,
    ratingScore:ratingScore, weeklyRating:effectiveRating
  };

  // 重新汇总（含明细 + 兼容旧数据）
  var totalOnTime=0,totalOverdue=0,totalNotDone=0,totalLateSubmit=0,totalReview=0,totalOnTimeSubmit=0,totalRating=0,legacyScore=0;
  var medalCounts={gold:0,silver:0,bronze:0,warn:0,danger:0};
  for(var wid in scores.weeks){
    var ws=scores.weeks[wid];
    var hasNewFields=(ws.onTimeScore!==undefined)||(ws.lateSubmitScore!==undefined);
    if(hasNewFields){
      totalOnTime+=ws.onTimeScore||0;
      totalOverdue+=ws.overdueScore||0;
      totalNotDone+=ws.notDoneScore||0;
      totalLateSubmit+=ws.lateSubmitScore||0;
      totalReview+=ws.reviewScore||0;
      totalOnTimeSubmit+=ws.onTimeSubmitScore||0;
      totalRating+=ws.ratingScore||0;
      if(ws.weeklyRating&&medalCounts[ws.weeklyRating]!==undefined)medalCounts[ws.weeklyRating]++;
    }else{
      legacyScore+=ws.score||0;
    }
  }
  scores.totalOnTime=totalOnTime; scores.totalOverdue=totalOverdue;
  scores.totalNotDone=totalNotDone; scores.totalLateSubmit=totalLateSubmit;
  scores.totalReview=totalReview; scores.totalOnTimeSubmit=totalOnTimeSubmit;
  scores.totalRating=totalRating; scores.medalCounts=medalCounts;
  scores.legacyScore=legacyScore;
  scores.net=totalOnTime+totalOverdue+totalNotDone+totalLateSubmit+totalReview+totalOnTimeSubmit+totalRating+legacyScore;
  _saveAnnualScores(uid,year,scores);
  return scores;
}

// ★ V0.1.35: 豁免切换（上级操作）
function toggleWPExemption(){
  var p=_wpCurrent.plan;if(!p)return;
  if(!_wpViewingSubordinate&&!_wpViewingDeptMember){
    _showAlert('仅上级可操作豁免');
    return;
  }
  p.exempted=!p.exempted;
  if(p.exempted){p.exemptedAt=new Date().toISOString();p.exemptedBy=currentUser?currentUser.name:'上级';}
  else{p.exemptedAt=null;p.exemptedBy=null;}
  p.updatedAt=new Date().toISOString();
  saveWP(p.year,p.month,p.week,p);
  _calcWeekScore(p);
  // ★ V0.6.1f: 局部更新面板，避免 renderWPTable 全量重建导致布局漂移
  var panel=document.getElementById('wpTimeMgmtPanel');
  if(panel){panel.outerHTML=_renderTimeManagementPanel(p);}
  showToast(p.exempted?'🛡️ 已豁免（本周不积分不扣分）':'⚠️ 已取消豁免（恢复扣分规则）');
}

// ★ V0.5.0: 艾森豪威尔矩阵 — 收集全年任务数据
function _collectYearTasks(year){
  var tasks=[];
  for(var m=1;m<=12;m++){
    for(var w=1;w<=4;w++){
      var plan=getWP(year,m,w);
      if(!plan||!plan.tasks)continue;
      for(var ti=0;ti<plan.tasks.length;ti++){
        var t=plan.tasks[ti];
        if(!t||!t.work)continue;
        tasks.push({
          work:t.work, goal:t.goal||'', status:t.status||'',
          year:year, month:m, week:w,
          startDate:t.startDate||'', actualDate:t.actualDate||''
        });
      }
    }
  }
  return tasks;
}

// ★ V0.5.0: 艾森豪威尔矩阵 — 渲染SVG象限卡片
var _EM_POS_MAP={'重要紧急':{x:'right',y:'top'},'重要不急':{x:'left',y:'top'},'日常紧急':{x:'right',y:'bottom'},'日常事项':{x:'left',y:'bottom'}};

function _renderEisenhowerMatrix(year){
  var tasks=_collectYearTasks(year);
  var html='<div class="wp-card">';
  html+='<div class="wp-card-title">🎯 艾森豪威尔矩阵</div>';
  html+='<div>';
  if(tasks.length===0){
    html+='<div style="text-align:center;color:#9ca3af;font-size:11px;padding:40px 0">暂无年度计划数据</div>';
    html+='</div></div>'; return html;
  }
  // 按优先级分四个象限
  var quads={'重要紧急':[],'重要不急':[],'日常紧急':[],'日常事项':[]};
  for(var i=0;i<tasks.length;i++){
    var g=tasks[i].goal||'日常事项';
    if(quads[g])quads[g].push(tasks[i]);
    else quads['日常事项'].push(tasks[i]);
  }
  var n='重要紧急',ni='重要不急',du='日常紧急',dr='日常事项';
  var activeQuads=[n,ni,du,dr].reduce(function(a,v){a[v]=quads[v].length>0;return a;},{});

  // SVG 矩阵
  var W=220,H=160,XC=Math.round(W/2),YC=Math.round(H/2),R=4;
  var svg='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto">';
  // 十字轴
  svg+='<line x1="'+XC+'" y1="18" x2="'+XC+'" y2="'+(H-14)+'" stroke="#cbd5e1" stroke-width="1"/>';
  svg+='<line x1="14" y1="'+YC+'" x2="'+(W-14)+'" y2="'+YC+'" stroke="#cbd5e1" stroke-width="1"/>';
  // 象限标签
  svg+='<text x="'+XC+'" y="14" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="system-ui">重要</text>';
  svg+='<text x="'+XC+'" y="'+(H-3)+'" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="system-ui">日常</text>';
  svg+='<text x="6" y="'+(YC-4)+'" text-anchor="start" fill="#9ca3af" font-size="9" font-family="system-ui">不紧急</text>';
  svg+='<text x="'+(W-6)+'" y="'+(YC-4)+'" text-anchor="end" fill="#9ca3af" font-size="9" font-family="system-ui">紧急</text>';

  // 每个象限的点位置
  var quadRanges=[{cxL:8,cxR:XC-10,cyT:8,cyB:YC-10,goal:ni},{cxL:XC+10,cxR:W-8,cyT:8,cyB:YC-10,goal:n},{cxL:8,cxR:XC-10,cyT:YC+10,cyB:H-8,goal:dr},{cxL:XC+10,cxR:W-8,cyT:YC+10,cyB:H-8,goal:du}];

  // 预生成每个象限的点位置（网格分布防止重叠）
  for(var qi=0;qi<quadRanges.length;qi++){
    var qr=quadRanges[qi],pts=quads[qr.goal];
    if(!pts.length)continue;
    var cols=Math.min(pts.length, Math.max(3, Math.ceil(Math.sqrt(pts.length))));
    var rows=Math.ceil(pts.length/cols);
    var cw=(qr.cxR-qr.cxL)/cols,rh=(qr.cyB-qr.cyT)/rows;
    for(var pi=0;pi<pts.length;pi++){
      var col=pi%cols,row=Math.floor(pi/cols);
      var cx=Math.round(qr.cxL+cw*(col+.5)),cy=Math.round(qr.cyT+rh*(row+.5));
      // 颜色映射
      var st=pts[pi].status||'进行中';
      var color=WP_STATUS_COLORS[st]||'#9ca3af';
      // 映射旧值
      if(!WP_STATUS_COLORS[st]){
        var mp={'✓完成':'按时完成','⚙推进中':'进行中','⏸暂停':'暂停中','❌未完成':'未做'};
        color=WP_STATUS_COLORS[mp[st]]||'#9ca3af';
      }
      svg+='<circle class="wp-em-dot" cx="'+cx+'" cy="'+cy+'" r="'+R+'" fill="'+color+'" data-y="'+pts[pi].year+'" data-m="'+pts[pi].month+'" data-w="'+pts[pi].week+'" title="'+_h(pts[pi].work)+'\n'+_h(st)+' | '+_h(pts[pi].goal)+'"/>';
    }
  }
  svg+='</svg>';
  html+=svg;

  // 图例
  html+='<div class="wp-em-legend" style="justify-content:center">';
  var legColors={'按时完成':'#22c55e','进行中':'#3b82f6','逾期完成':'#eab308','未做':'#D64352','暂停中':'#9ca3af'};
  for(var lk in legColors){
    html+='<span class="wp-em-legend-dot" style="background:'+legColors[lk]+'"></span>'+lk;
  }
  html+='</div>';

  // 四个象限计数
  var allQuads=[n,ni,du,dr];
  html+='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;font-size:8px;color:#6b7280;margin-top:2px;white-space:nowrap">';
  for(var qi=0;qi<allQuads.length;qi++){
    var lab=allQuads[qi].replace('重要紧急','⚡重急').replace('重要不急','📌重不急').replace('日常紧急','🔥日急').replace('日常事项','📋日常');
    html+='<div style="padding:2px 4px;background:#F8FAFB;border-radius:3px">'+lab+' <b style="color:#374151">'+quads[allQuads[qi]].length+'</b></div>';
  }
  html+='</div>';
  html+='</div>';
  html+='</div>';
  return html;
}

// ★ V0.5.23: 年度计划完成率进度条卡片
function _renderAnnualProgress(year){
  var tasks=_collectYearTasks(year);
  var quads={'重要紧急':[],'重要不急':[],'日常紧急':[],'日常事项':[]};
  for(var i=0;i<tasks.length;i++){
    var g=tasks[i].goal||'日常事项';
    if(quads[g])quads[g].push(tasks[i]);
    else quads['日常事项'].push(tasks[i]);
  }
  var allQuads=['重要紧急','重要不急','日常紧急','日常事项'];
  var totalCount=0,totalDone=0;
  var html='<div class="wp-card wp-progress-card"><div class="wp-card-title">⏰ '+year+'年年度计划完成率</div>';
  html+='<div>';
  for(var qi=0;qi<allQuads.length;qi++){
    var q=allQuads[qi];
    var total=quads[q].length;
    var done=0;
    for(var j=0;j<quads[q].length;j++){
      var s=quads[q][j].status||'';
      if(s==='按时完成'||s==='逾期完成'||s==='✓完成')done++;
    }
    totalCount+=total;totalDone+=done;
    var pct=total>0?Math.round(done/total*100):0;
    var dotColor=WP_GOAL_COLORS[q]||'#9ca3af';
    var labelHtml='<span style="color:'+dotColor+';font-size:8px;line-height:1">●</span><span>'+q+'</span>';
    html+='<div class="wp-progress-row"><span class="wp-progress-label">'+labelHtml+'</span><div class="wp-progress-bar-wrap"><div class="wp-progress-bar-fill" style="width:'+pct+'%"></div></div><span class="wp-progress-num">'+done+'/'+total+' ('+pct+'%)</span></div>';
  }
  // 合计行
  var overallPct=totalCount>0?Math.round(totalDone/totalCount*100):0;
  html+='<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb">';
  html+='<div class="wp-progress-row"><span class="wp-progress-label" style="font-weight:600;color:#1E3A5F">合计</span><div class="wp-progress-bar-wrap" style="height:6px"><div class="wp-progress-bar-fill" style="width:'+overallPct+'%;height:6px"></div></div><span class="wp-progress-num" style="font-weight:600;color:#1E3A5F">'+totalDone+'/'+totalCount+' ('+overallPct+'%)</span></div>';
  html+='</div>';
  html+='</div>';
  html+='</div>';
  return html;
}

// ★ V0.1.35: 时间管理规则面板
function _renderTimeManagementPanel(plan){
  if(!plan)return'';
  _calcWeekScore(plan); // ★ V0.6.1x: 每次渲染面板前重算，确保积分正确
  var uid=getViewedUserEmp().name||(currentUser&&currentUser.name)||'';
  var year=plan.year;
  var scores=_getAnnualScores(uid,year);

  // 提交状态
  var subStatus=_checkSubmissionStatus(plan,'submit');
  var subTagClass='',subText='';
  if(subStatus==='on_time'){subText='✅ 按时';subTagClass='green';}
  else if(subStatus==='late'){subText='⚠️ 超时';subTagClass='red';}
  else if(subStatus==='exempted'){subText='🛡️ 已豁免';subTagClass='blue';}
  else{subText='待提交';subTagClass='gray';}
  var subTime=plan.firstSubmittedAt?_formatDateTime(plan.firstSubmittedAt):'—';

  // 评价状态
  var revStatus=_checkSubmissionStatus(plan,'review');
  var revTagClass='',revText='';
  if(revStatus==='on_time'){revText='✅ 按时';revTagClass='green';}
  else if(revStatus==='late'){revText='⚠️ 超时';revTagClass='red';}
  else{revText='待评价';revTagClass='gray';}
  var revTime=plan.bossReviewedAt?_formatDateTime(plan.bossReviewedAt):'—';

  // 豁免按钮
  var exemptionBtn='';
  if((_wpViewingShared||_wpViewingSubordinate||_wpViewingDeptMember)&&(subStatus!=='on_time'||plan.exempted)){
    exemptionBtn='<button onclick="toggleWPExemption()" style="padding:2px 8px;border:none;border-radius:4px;cursor:pointer;font-size:11px;margin-top:4px;'+(plan.exempted?'background:#94a3b8;color:#fff':'background:#289FB7;color:#fff')+'">'+(plan.exempted?'🔓 取消豁免':'🛡️ 豁免')+'</button>';
  }

  var html='';
  html+='<section class="wp-overview" id="wpTimeMgmtPanel" onmouseenter="_cancelWPOverviewAutoCollapse()" onmouseleave="_scheduleWPOverviewAutoCollapse()" onfocusin="_cancelWPOverviewAutoCollapse()" onfocusout="_scheduleWPOverviewAutoCollapse()">';
  html+='<button type="button" class="wp-overview-toggle" onclick="toggleWPOverview()" aria-expanded="'+(_wpOverviewExpanded?'true':'false')+'"><span class="wp-overview-title">本周概览</span><span class="wp-overview-hint">规则、积分与进度</span><span class="wp-overview-icon" id="wpOverviewIcon">'+(_wpOverviewExpanded?'收起 ▲':'展开 ▼')+'</span></button>';
  html+='<div class="wp-overview-content" id="wpOverviewContent" style="'+(_wpOverviewExpanded?'max-height:1600px;opacity:1':'max-height:0;opacity:0')+'">';
  html+='<div class="wp-cards-grid">';

  // ★ Card 1: 计分规则（V0.4.91 新规则）
  html+='<div class="wp-card">';
  html+='<div class="wp-card-title">计分规则</div>';
  html+='<div>';
  html+='<table class="wp-card-table">';
  html+='<tr><td><span style="color:#059669;margin-right:6px">✓</span>周六12:00前提交上周小结</td><td class="td-val td-pos" style="color:#059669;font-weight:600">+0.5</td></tr>';
  html+='<tr><td><span style="color:#059669;margin-right:6px">✓</span>周六12:00前提交下周计划</td><td class="td-val td-pos" style="color:#059669;font-weight:600">+0.5</td></tr>';
  html+='<tr><td style="color:#6b7280"><span style="margin-right:6px">—</span>法定节假日顺延</td><td class="td-val" style="color:#6b7280">免扣</td></tr>';
  html+='<tr><td style="color:#6b7280"><span style="margin-right:6px">○</span>未按时提交计划</td><td class="td-val" style="color:#dc2626;font-weight:500">−1</td></tr>';
  html+='<tr><td style="color:#6b7280"><span style="margin-right:6px">○</span>未按时提交小结</td><td class="td-val" style="color:#dc2626;font-weight:500">−1</td></tr>';
  html+='<tr><td style="color:#6b7280"><span style="margin-right:6px">⚠</span>累计>3次加倍扣</td><td class="td-val" style="color:#dc2626;font-weight:600">−2</td></tr>';
  html+='<tr><td class="wp-grace-tip" style="font-size:9px;color:#6b7280;padding-top:6px;border-top:1px solid #e5e7eb;white-space:pre-line;cursor:help" colspan="2">注：\n延迟次数=计划+小结延迟合计（当年累计）<span style="color:#9ca3af">，超过 3 次加倍扣分</span></td></tr>';
  html+='</table>';
  html+='</div>';
  html+='</div>';

  // ★ Card 2: 评分标准（V0.4.91 新分值）
  html+='<div class="wp-card">';
  html+='<div class="wp-card-title">评分标准</div>';
  html+='<div>';
  html+='<table class="wp-card-table">';
  html+='<tr><td></td><td class="td-val" style="color:#6b7280;font-weight:400;font-size:10px">按时</td><td class="td-val" style="color:#6b7280;font-weight:400;font-size:10px">逾期</td><td class="td-val" style="color:#6b7280;font-weight:400;font-size:10px">未做</td></tr>';
  html+='<tr><td>重要紧急</td><td class="td-val td-pos">+3</td><td class="td-val td-neg">−1.5</td><td class="td-val td-neg">−5</td></tr>';
  html+='<tr><td>重要不急</td><td class="td-val td-pos">+2</td><td class="td-val td-neg">−1</td><td class="td-val td-neg">−4</td></tr>';
  html+='<tr><td>日常紧急</td><td class="td-val td-pos">+1.5</td><td class="td-val td-neg">−1</td><td class="td-val td-neg">−3</td></tr>';
  html+='<tr><td>日常事项</td><td class="td-val td-pos">+1</td><td class="td-val td-neg">−0.5</td><td class="td-val td-neg">−2</td></tr>';
  html+='<tr><td style="font-size:9px;color:#9ca3af;padding-top:6px;border-top:1px solid #e5e7eb;white-space:pre-line" colspan="4">注：\n手动选择"暂停中"→终止计算，积分=0</td></tr>';
  html+='</table>';
  html+='</div>';
  html+='</div>';

  // ★ Card 3: 完成状态
  html+='<div class="wp-card">';
  html+='<div class="wp-card-title">完成状态</div>';
  html+='<div>';
  html+='<table class="wp-card-table">';
  html+='<tr><td style="color:#6b7280;width:32px">提交</td><td style="color:#0F2C4B">'+subTime+'</td></tr>';
  html+='</table>';
  html+='<div style="margin:6px 0 10px 0"><span class="wp-card-tag '+subTagClass+'">'+subText+'</span></div>';
  html+='<table class="wp-card-table">';
  html+='<tr><td style="color:#6b7280;width:32px">评价</td><td style="color:#6b7280">—</td></tr>';
  html+='</table>';
  html+='<div style="margin-top:6px"><span class="wp-card-tag '+revTagClass+'">'+revText+'</span></div>';
  html+=exemptionBtn;
  html+='</div>';
  html+='</div>';

  // ★ Card 4: 年度积分（明细版）
  var netVal=scores.net||0;
  html+='<div class="wp-card">';
  html+='<div class="wp-card-title">'+year+'年积分</div>';
  html+='<div>';
  // 加分项
  var tos=scores.totalOnTime||0;
  if(tos>0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">按时完成</span><span class="wp-card-score-val" style="color:#059669">+'+tos+'</span></div>';
  var tosSub=scores.totalOnTimeSubmit||0;
  if(tosSub>0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">提交按时</span><span class="wp-card-score-val" style="color:#059669">+'+tosSub+'</span></div>';
  var trs=scores.totalReview||0;
  if(trs>0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">上级评价</span><span class="wp-card-score-val" style="color:#059669">+'+trs+'</span></div>';
  // ★ V0.6.1.hh: 奖牌评级分
  var rtg=scores.totalRating||0;
  if(rtg!==0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">🏅 评级</span><span class="wp-card-score-val" style="color:'+(rtg>0?'#059669':'#dc2626')+'">'+(rtg>0?'+':'')+rtg+'</span></div>';
  // ★ V0.6.1.hh: 奖牌战绩
  var mc=scores.medalCounts||{};
  var medalBadges=[];
  if(mc.gold)medalBadges.push('🥇×'+mc.gold);
  if(mc.silver)medalBadges.push('🥈×'+mc.silver);
  if(mc.bronze)medalBadges.push('🥉×'+mc.bronze);
  if(mc.warn)medalBadges.push('⚠️×'+mc.warn);
  if(mc.danger)medalBadges.push('⛔×'+mc.danger);
  if(medalBadges.length>0)html+='<div class="wp-card-score-row" style="color:#6b7280;font-size:11px;justify-content:flex-start;gap:6px">'+medalBadges.join(' ')+'</div>';
  // 扣分项
  var tds=scores.totalOverdue||0;
  if(tds<0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">逾期完成</span><span class="wp-card-score-val" style="color:#dc2626">'+tds+'</span></div>';
  var tns=scores.totalNotDone||0;
  if(tns<0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">未做</span><span class="wp-card-score-val" style="color:#dc2626">'+tns+'</span></div>';
  var tls=scores.totalLateSubmit||0;
  if(tls<0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">延迟提交</span><span class="wp-card-score-val" style="color:#dc2626">'+tls+'</span></div>';
  // 旧数据（兼容）
  var leg=scores.legacyScore||0;
  if(leg!==0)html+='<div class="wp-card-score-row"><span class="wp-card-score-label">其他</span><span class="wp-card-score-val" style="color:'+(leg>0?'#059669':'#dc2626')+'">'+(leg>0?'+':'')+leg+'</span></div>';
  // 净积分
  html+='<div class="wp-card-divider"><div style="display:flex;justify-content:space-between"><span style="color:#0F2C4B;font-size:12px;font-weight:500">净积分</span><span class="wp-card-score-bold">'+(netVal>=0?'+':'')+netVal+'</span></div></div>';
  if((scores.net||0)<=-20){
    html+='<div style="color:#6b7280;font-size:11px;margin-top:4px">⚠️ 不能胜任</div>';
  }
  html+='</div>';
  html+='</div>';
  // ★ V0.5.0: 艾森豪威尔矩阵卡片
  html+=_renderEisenhowerMatrix(year);
  // ★ V0.5.23: 年度计划完成率进度条（跨全宽）
  html+=_renderAnnualProgress(year);

  html+='</div>';
  html+='</div>';
  html+='</section>';
  return html;
}

// ★ V0.1.35: 格式化日期时间为简洁显示
function _formatDateTime(isoStr){
  if(!isoStr)return'—';
  var d=new Date(isoStr);
  var pad=function(n){return n<10?'0'+n:n;};
  var days=['日','一','二','三','四','五','六'];
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '
    +pad(d.getHours())+':'+pad(d.getMinutes())+'（周'+days[d.getDay()]+'）';
}

async function deleteCurrentWPPlan(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}
  var myName=(currentUser&&currentUser.name)||'';
  // ★ V0.6.1as: 删除安全机制——已提交/已锁定/已评价时禁止删除
  if(p.firstSubmittedAt || p.summarySubmittedAt || (p.frozen && p.frozenBy && p.frozenBy !== myName) || p.bossEvaluated){
    _showAlert('你的周计划由于你已提交小结或上级已锁定，如需删除请先解除上级锁定，并撤回周小结提交和周计划提交，即可删除。','⚠️ 无法删除',true);
    return;
  }
  var ok=await _showConfirm('你确定要清空 '+p.year+'年'+p.month+'月第'+p.week+'周行动项内容？\n\n如确定，将清除本周行动项中已填写的所有内容。'+'\n\n—\n\nAre you sure you want to clear Week '+p.week+' of '+p.month+'/'+p.year+'?\n\nIf confirmed, all filled content in this week to-do will be permanently removed.','注意 / Attention');
  if(!ok)return;
  // ★ V0.6.1.j59: 删除必须移除真实记录，不能将空壳计划再写回云端；否则备份和跨端同步会导致已删除内容复现。
  var y=p.year, m=p.month, w=p.week;
  var deleted=await deleteWP(y,m,w);
  if(!deleted)return;
  _wpCurrent={year:null,month:null,week:null,plan:null};
  showWPEmpty();
  renderWPPlanList(y,m);
  renderWPUserInfo();
  showToast('🗑 本周行动项已彻底删除');
}

function exportCurrentWP(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}
  
  // 检查 XLSX 是否可用
  if(typeof XLSX==='undefined'||typeof XLSX.utils==='undefined'){
    _showAlert('Excel导出库未加载完成，请稍后重试');return;
  }

  try{
    // ===== 样式预设（参照"工作周记（AI辅助分析版）"）=====
    var S_TITLE={font:{bold:true,sz:10,name:'Arial Narrow',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'5B9BD5'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}};
    var S_TH={font:{bold:true,sz:9,name:'Arial Narrow',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'1A3C5E'}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border:{top:{style:'thin',color:{rgb:'D0D0D0'}},bottom:{style:'thin',color:{rgb:'D0D0D0'}},left:{style:'thin',color:{rgb:'D0D0D0'}},right:{style:'thin',color:{rgb:'D0D0D0'}}}};
    var S_TH_AI={font:{bold:true,sz:9,name:'Arial Narrow',color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'002060'}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border:{top:{style:'thin',color:{rgb:'D0D0D0'}},bottom:{style:'thin',color:{rgb:'D0D0D0'}},left:{style:'thin',color:{rgb:'D0D0D0'}},right:{style:'thin',color:{rgb:'D0D0D0'}}}};
    var BDR={border:{top:{style:'thin',color:{rgb:'D0D0D0'}},bottom:{style:'thin',color:{rgb:'D0D0D0'}},left:{style:'thin',color:{rgb:'D0D0D0'}},right:{style:'thin',color:{rgb:'D0D0D0'}}}};
    var S_TD={font:{sz:9,name:'Arial Narrow'},border:BDR.border};
    var S_TD_ALT={font:{sz:9,name:'Arial Narrow'},fill:{fgColor:{rgb:'F5F8FC'}},border:BDR.border};
    var S_TD_CN={font:{sz:9,name:'Microsoft YaHei'},border:BDR.border};
    var S_TD_CN_ALT={font:{sz:9,name:'Microsoft YaHei'},fill:{fgColor:{rgb:'F5F8FC'}},border:BDR.border};
    // AI列样式 - 浅黄底（未完成）/ 浅绿底（已完成）
    var S_TD_AI={font:{sz:9,name:'Microsoft YaHei'},fill:{fgColor:{rgb:'FFF2CC'}},border:BDR.border};
    var S_TD_AI_ALT={font:{sz:9,name:'Microsoft YaHei'},fill:{fgColor:{rgb:'FFF8E6'}},border:BDR.border};
    var S_TD_AI_G={font:{sz:9,name:'Microsoft YaHei'},fill:{fgColor:{rgb:'E2EFDA'}},border:BDR.border};
    var S_TD_AI_G_ALT={font:{sz:9,name:'Microsoft YaHei'},fill:{fgColor:{rgb:'EBF4EA'}},border:BDR.border};
    var NO_BDR={border:{top:{style:'none'},bottom:{style:'none'},left:{style:'none'},right:{style:'none'}}};
    var AL_C={alignment:{horizontal:'center',vertical:'center',wrapText:true}};
    var AL_L={alignment:{horizontal:'left',vertical:'center',wrapText:true}};
    var AL_LT={alignment:{horizontal:'left',vertical:'top',wrapText:true}};

    var title=p.name+' '+p.year+'年'+p.month+'月 第'+p.week+'周 工作计划';
    var hdrs=['姓名','部门','岗位','序号','本周重点行动项','优先级','启动日期','计划完成日期','实际完成日期','耗时','完成状态','协同人','遇到的问题/挑战','问题类型','是否需要上级介入','直属上级建议','AI分析建议'];
    
    // 构建数据行
    var rows=[[title], hdrs];
    for(var i=0;i<p.tasks.length;i++){
      var t=p.tasks[i]||{};
      var _dur=_calcTaskDuration(t);
      rows.push([
        p.name||'', p.dept||'', p.position||'',
        t.seq||'', t.work||'', t.goal||'',
        t.startDate||'', t.plannedDate||'', t.actualDate||'',
        _dur?_dur+'天':'',
        t.status||'', t.supporters||'',
        t.problems||'', t.problemType||'',
        t.needBoss||'', t.bossFeedback||'',
        t.aiSuggestion||''
      ]);
    }

    // 添加评价反馈区域
    rows.push([]);
    rows.push(['📝 一周工作小结', (p.weekSummary||'员工暂未填写')]);
    rows.push([]);
    rows.push(['⭐ 一周工作评价', ((p.supervisorReview&&p.supervisorReview.content)||'领导暂未评价')]);
    if(p.supervisorReview&&p.supervisorReview.reviewerName) rows[rows.length-1].push('评价人：'+p.supervisorReview.reviewerName);
    rows.push([]);
    rows.push(['💡 一周工作评价与建议', ((p.skipLevelSuggestion&&p.skipLevelSuggestion.content)||'暂无')]);
    if(p.skipLevelSuggestion&&p.skipLevelSuggestion.reviewerName) rows[rows.length-1].push('建议人：'+p.skipLevelSuggestion.reviewerName);
    
    var ws=XLSX.utils.aoa_to_sheet(rows);

    // 列宽（参照参考文件）
    ws['!cols']=[
      {wch:9},{wch:8},{wch:10},{wch:6},
      {wch:48},{wch:13},{wch:12},{wch:12},{wch:12},{wch:8},
      {wch:15},{wch:19},{wch:26},{wch:13},{wch:13},
      {wch:34},{wch:78}
    ];

    // 合并单元格：标题行跨所有列
    ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:16}}];
    // 合并姓名、部门、岗位列（如果有数据）
    if(p.tasks.length>1){
      ws['!merges'].push({s:{r:2,c:0},e:{r:1+p.tasks.length,c:0}});
      ws['!merges'].push({s:{r:2,c:1},e:{r:1+p.tasks.length,c:1}});
      ws['!merges'].push({s:{r:2,c:2},e:{r:1+p.tasks.length,c:2}});
    }
    // 行高
    ws['!rows']=[{hpx:22},{hpx:26}];
    for(var ri=2;ri<rows.length;ri++) ws['!rows'][ri]={hpx:16};

    // 安全设置单元格样式的辅助函数
    function safeStyle(ref, styleObj){
      if(!ref || !ws[ref]) return false;
      try{ ws[ref].s=styleObj; return true; }catch(e){ return false; }
    }

    // 标题行样式 (A1)
    safeStyle('A1',S_TITLE);

    // 表头行样式 (Row 2 = Row index 1)
    for(var hc=0;hc<hdrs.length;hc++){
      var ref=XLSX.utils.encode_cell({r:1,c:hc});
      // AI分析建议列表头用深蓝 #002060 (第17列, index 16)
      safeStyle(ref,hc===16?Object.assign({},S_TH_AI,AL_C):Object.assign({},S_TH,AL_C));
    }

    // 数据行样式
    for(var i=0;i<p.tasks.length;i++){
      var t=p.tasks[i]||{},r=i+2,isAlt=(i%2===0);
      var greenAI=(t.status&&(t.status.indexOf('完成')>=0));
      
      for(var dc=0;dc<17;dc++){
        var cr=XLSX.utils.encode_cell({r:r,c:dc});
        var style;
        
        if(dc===16){
          // AI分析建议列 (第17列, index 16)
          if(greenAI) style=isAlt?S_TD_AI_G_ALT:S_TD_AI_G;
          else style=isAlt?S_TD_AI_ALT:S_TD_AI;
          style=Object.assign({},style,AL_LT);
        }else if([0,1,2,3,6,7,10,11,12].indexOf(dc)>=0){
          // 数字/短文本列：居中
          style=Object.assign({},isAlt?S_TD_ALT:S_TD,AL_C);
        }else{
          // 长文本列：左对齐
          style=Object.assign({},isAlt?S_TD_CN_ALT:S_TD_CN,AL_L);
        }
        safeStyle(cr,style);
      }
    }

    // V0.5.90: 汇总行和空行无边框（取消底部多余线条）
    var summaryStart=2+p.tasks.length;
    for(var sr=summaryStart;sr<rows.length;sr++){
      for(var sc=0;sc<17;sc++){
        var srRef=XLSX.utils.encode_cell({r:sr,c:sc});
        safeStyle(srRef,NO_BDR);
      }
    }

    // 设置打印区域和锁定表头
    ws['!freeze']={xSplit:0,ySplit:2};  // 锁定前两行(标题+表头)

    var wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,p.year+'-'+p.month+'-'+p.week);
    XLSX.writeFile(wb,'周工作计划_'+p.name+'_'+p.year+'_'+p.month+'_W'+p.week+'.xlsx');
  }catch(e){_showAlert('导出失败：'+e.message+'\n\n如果反复出现此错误请联系管理员');}
}

// ★ V0.6.1df: 导出下属重急事项合并表
function exportMergedUrgent(){
  var merged=_wpCurrent.mergedTasks;
  if(!merged||merged.length===0){_showAlert('暂无数据可导出');return;}
  try{
    var rows=[['#','员工','本周重点行动项','优先级','启动日期','计划完成','剩余天数','实际完成','耗时','状态','协同','问题','需要上级','上级建议']];
    for(var i=0;i<merged.length;i++){
      var t=merged[i];
      var remaining='';
      if(t.actualDate)remaining='0';
      else if(t.plannedDate){
        var now=new Date();now.setHours(0,0,0,0);
        var pd=new Date(t.plannedDate+'T00:00:00');
        var diff=Math.floor((pd-now)/(1000*60*60*24));
        remaining=diff<0?'已超'+Math.abs(diff)+'天':diff===0?'今天截止':diff+'天';
      }
      rows.push([i+1,t._empName,t.work||'','重要紧急',t.startDate||'',t.plannedDate||'',remaining,t.actualDate||'',t.estimatedHours||'','',(t.supporters||'').replace(/,/g,'、'),t.problems||'',t.needBoss||'',t.bossFeedback||'']);
    }
    var ws=XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']=[{wch:5},{wch:10},{wch:48},{wch:10},{wch:12},{wch:12},{wch:10},{wch:12},{wch:8},{wch:8},{wch:15},{wch:8},{wch:8},{wch:20}];
    var wb=XLSX.utils.book_new();
    var cy=_wpCurrent.year||new Date().getFullYear();
    var cm=_wpCurrent.month||(new Date().getMonth()+1);
    var cw=_wpCurrent.week||1;
    XLSX.utils.book_append_sheet(wb,ws,'下属重急事项_'+cy+'_'+cm+'_W'+cw);
    XLSX.writeFile(wb,'下属重急事项_'+cy+'_'+cm+'_W'+cw+'.xlsx');
  }catch(e){_showAlert('导出失败：'+e.message);}
}

function emailToSuperior(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}
  var emp=getCurrentEmployee();
  var subj=encodeURIComponent('周工作计划 - '+emp.name+' '+p.year+'年'+p.month+'月第'+p.week+'周');
  var body='上级您好，以下是本周工作计划：%0D%0A%0D%0A';
  for(var i=0;i<p.tasks.length;i++){
    var t=p.tasks[i];if(!t.work)continue;
    body+=encodeURIComponent((i+1)+'. '+t.work+' ['+(t.goal||'')+'] '+t.status+(t.plannedDate?(' 计划:'+t.plannedDate):'')+(t.actualDate?(' 完成:'+t.actualDate):''))+'%0D%0A';
  }
  body+=encodeURIComponent('%0D%0A请审阅，谢谢！');
  window.open('mailto:?subject='+subj+'&body='+body);
}

// ========== 查看上级评价（只读，下属用）==========
function viewBossEval(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}

  var m=document.getElementById('wpEvalModal');
  if(m)m.remove();

  var html='<div class="wp-eval-modal show" id="wpEvalModal"><div class="wp-eval-card">';
  html+='<div class="wp-eval-header"><h3>📋 上级评价 - '+_h(p.name)+'</h3><button class="wp-eval-close" onclick="closeBossEval()">✕</button></div>';
  html+='<div class="wp-eval-body" style="font-size:13px">';
  html+='<p style="color:var(--text-hint);margin-bottom:12px">「'+_h(p.name)+'」的「'+p.year+'年'+p.month+'月第'+p.week+'周」计划 - 上级评价</p>';
  if(p.bossEvaluatedBy)html+='<p style="color:var(--text-hint);margin-bottom:14px">评价人：'+_h(p.bossEvaluatedBy)+' | 评价时间：'+_h((p.bossEvaluatedAt||'').substring(0,10))+'</p>';
  html+='<div class="wp-eval-row"><label>综合评价</label><div style="padding:10px 12px;background:var(--bg);border-radius:6px;min-height:60px;white-space:pre-wrap;font-size:13px;line-height:1.6">'+_h(p.bossOverallFeedback||'（无）')+'</div></div>';
  html+='<div class="wp-eval-row"><label style="margin-top:14px">各事项评价</label>';
  for(var i=0;i<p.tasks.length;i++){
    var t=p.tasks[i];if(!t.work)continue;
    html+='<div style="margin-bottom:10px"><div style="font-weight:500;margin-bottom:3px;line-height:1.4">'+(i+1)+'. '+_h(t.work)+'</div>';
    html+='<div style="padding:8px 12px;background:var(--bg);border-radius:6px;min-height:36px;white-space:pre-wrap;font-size:13px;line-height:1.6">'+(t.bossFeedback?_h(t.bossFeedback):'<span style="color:#C0C0C0;font-style:italic;pointer-events:none;user-select:none">（无）</span>')+'</div></div>';
  }
  html+='</div>';
  html+='<div class="wp-eval-actions"><button class="wp-eval-submit" onclick="closeBossEval()">关闭</button></div>';
  html+='</div></div>';
  document.body.insertAdjacentHTML('beforeend',html);
  var mm=document.getElementById('wpEvalModal');
  mm.onclick=function(e){if(e.target===mm)closeBossEval();};
}

// ========== 上级评价 ==========
function openBossEval(){
  var p=_wpCurrent.plan;if(!p){_showAlert('请先选择一个周计划');return;}
  var sub=_wpViewingSubordinate;
  if(!sub){_showAlert('请先从顶部选择下属查看其周计划，再填写评价');return;}

  var m=document.getElementById('wpEvalModal');
  if(m)m.remove();

  var html='<div class="wp-eval-modal show" id="wpEvalModal"><div class="wp-eval-card">';
  html+='<div class="wp-eval-header"><h3>⭐ 上级评价 - '+sub+'</h3><div class="wp-eval-header-actions"><button class="wp-eval-cancel" onclick="closeBossEval()">取消</button><button class="wp-eval-submit" onclick="submitBossEval()">提交评价</button></div><button class="wp-eval-close" onclick="closeBossEval()">✕</button></div>';
  html+='<div class="wp-eval-body" style="font-size:13px">';
  html+='<p style="color:var(--text-hint);margin-bottom:14px">为「'+sub+'」的「'+p.year+'年'+p.month+'月第'+p.week+'周」计划填写评价</p>';
  html+='<div class="wp-eval-row"><label>综合评价</label><textarea id="wpBossOverall" style="min-height:60px">'+_h(p.bossOverallFeedback||'')+'</textarea></div>';
  html+='<div class="wp-eval-row"><label style="margin-top:14px">各事项评价</label>';
  for(var i=0;i<p.tasks.length;i++){
    var t=p.tasks[i];if(!t.work)continue;
    html+='<div style="margin-bottom:10px"><div style="font-weight:500;margin-bottom:3px;line-height:1.4">'+(i+1)+'. '+_h(t.work)+'</div>';
    html+='<textarea id="wpBossTask_'+i+'" style="min-height:36px">'+_h(t.bossFeedback||'')+'</textarea></div>';
  }
  html+='</div>';
  html+='</div></div>';
  document.body.insertAdjacentHTML('beforeend',html);
  var mm=document.getElementById('wpEvalModal');
  mm.onclick=function(e){if(e.target===mm)closeBossEval();};
}

function closeBossEval(){
  var m=document.getElementById('wpEvalModal');if(m)m.remove();
}

function submitBossEval(){
  var p=_wpCurrent.plan;if(!p)return;
  p.bossOverallFeedback=document.getElementById('wpBossOverall').value;
  for(var i=0;i<p.tasks.length;i++){
    var el=document.getElementById('wpBossTask_'+i);
    if(el)p.tasks[i].bossFeedback=el.value;
  }
  p.bossEvaluated=true;
  p.bossEvaluatedAt=new Date().toISOString();
  p.bossEvaluatedBy=currentUser?currentUser.name:'上级';
  // ★ V0.1.35: 记录上级完成评价时间（用于管理规则面板判断是否按时）
  p.bossReviewedAt=new Date().toISOString();
  p.updatedAt=new Date().toISOString();
  saveWP(p.year,p.month,p.week,p);
  _calcWeekScore(p); // ★ V0.1.49: 上级评价后重新计算任务得分
  // ★ V0.1.43: 上级评价完成后，以上级修正的状态重新同步下周转入任务
  _carryTasksToNextWeek(p, true);
  closeBossEval();
  renderWPTable(p);
}

// ★ V0.5.55: 撤销评价 — 上级可重新修订评价
async function revokeBossEval(){
  var p=_wpCurrent.plan;if(!p)return;
  var confirmed=await _showConfirm('撤销后该下属周计划将恢复为可编辑状态。','确认撤销评价？');
  if(!confirmed)return;
  p.bossEvaluated=false;
  p.bossEvaluatedAt=null;
  p.bossEvaluatedBy='';
  // 撤销评价即撤销其整体评级：历史测试/误点奖牌不应进入积分、数据中心或评价明细。
  p.weeklyRating='';
  p.updatedAt=new Date().toISOString();
  saveWP(p.year,p.month,p.week,p);
  renderWPTable(p);
  showToast('↩️ 已撤销评价，该下属周计划恢复可编辑');
}

// ========== 周计划评价反馈保存 ==========
function saveWPFeedback(field, value) {
  var p = _wpCurrent.plan;
  if (!p) return;
  
  if (field === 'weekSummary') {
    p.weekSummary = value;
    var now = new Date();
    p.weekSummaryUpdatedAt = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0')+' '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0');
  } else if (field === 'supervisorReview') {
    if (!p.supervisorReview) p.supervisorReview = {};
    p.supervisorReview.content = value;
    p.supervisorReview.reviewerName = (currentUser && currentUser.name) || '未知';
    p.supervisorReview.updatedAt = new Date().toISOString().split('T')[0];
  } else if (field === 'skipLevelSuggestion') {
    if (!p.skipLevelSuggestion) p.skipLevelSuggestion = {};
    p.skipLevelSuggestion.content = value;
    p.skipLevelSuggestion.reviewerName = (currentUser && currentUser.name) || '未知';
    p.skipLevelSuggestion.updatedAt = new Date().toISOString().split('T')[0];
  }
  
  p.updatedAt = new Date().toISOString();
  saveWP(p.year, p.month, p.week, p);
}

// ★ V0.6.1.hd / iq: 保存本周心情 — 最多选 2 种，点击同一表情可取消
function saveWPMood(mood, el) {
  // 表情按下时已阻止焦点转移，保留正在编辑的任务单元格，避免触发其重绘流程。
  var p = _wpCurrent.plan;
  if (!p) return;
  // 读取当前心情列表（兼容旧版单值字段）
  var moodList = [];
  if (Array.isArray(p.moods)) moodList = p.moods.slice();
  else if (typeof p.mood === 'string' && p.mood) moodList = p.mood.split(',');
  // 判断是否已选
  var idx = moodList.indexOf(mood);
  if (idx >= 0) {
    // 取消该心情
    moodList.splice(idx, 1);
  } else {
    // 最多 2 种；满了就提示
    if (moodList.length >= 2) {
      showToast('最多可选 2 种心情，请先取消一个', 'warning');
      return;
    }
    moodList.push(mood);
  }
  p.moods = moodList;
  p.mood = moodList.join(','); // 兼容旧字段
  p.updatedAt = new Date().toISOString();
  saveWP(p.year, p.month, p.week, p);
  // 刷新当前视图的 emoji 高亮
  var section = el.closest('.wp-feedback-section');
  if (section) {
    var allEmojis = section.querySelectorAll('.wp-mood-emoji');
    for (var i = 0; i < allEmojis.length; i++) {
      var key = allEmojis[i].getAttribute('data-mood-key');
      allEmojis[i].classList.toggle('mood-selected', moodList.indexOf(key) >= 0);
    }
  }
  // 选中态已在 DOM 中更新；此处不重绘周计划，避免重建滚动容器造成页面跳动。
  showToast(moodList.length > 0 ? ('💬 已选 ' + moodList.length + ' 种心情') : '💬 心情已清除', 'info');
}

// ★ V0.6.1.hh: 保存上级评级（奖牌）
function saveWPRating(rating, el) {
  var p = _wpCurrent.plan;
  if (!p) return;
  if (p.weeklyRating === rating) {
    p.weeklyRating = '';
    // 取消奖牌时同步清空评级元数据，避免旧时间戳让后续统计误判为有效评价。
    p.bossEvaluatedBy = '';
    p.bossEvaluatedAt = null;
  } else {
    p.weeklyRating = rating;
    // ★ V0.6.1.ht: 记录评分人 + 评分时间（用于数据中心「我评出的奖牌」统计）
    if (currentUser && currentUser.name) {
      p.bossEvaluatedBy = currentUser.name;
      p.bossEvaluatedAt = new Date().toISOString();
    }
  }
  p.updatedAt = new Date().toISOString();
  // ★ V0.6.1.j88: 修复奖牌点击导致页面上下滚动 — 改为就地更新 DOM，不再重渲染整表
  // j70 之前已为心情表情做过类似修复；这里奖牌的 setTimeout → selectWP() 仍会触发 renderWPTable()
  // 重建整张表格，导致浏览器重新计算滚动锚点，视觉上"页面上下抖一次"。
  _calcWeekScore(p);
  saveWP(p.year, p.month, p.week, p);
  // 就地更新奖牌的 selected 状态
  try {
    var container = el && el.parentNode;
    if (container) {
      var allEmojis = container.querySelectorAll('.wp-rating-emoji');
      for (var i = 0; i < allEmojis.length; i++) {
        var emojiKey = allEmojis[i].getAttribute('data-tip') || '';
        // 通过 onclick 的 rating 参数对比更安全：直接用 _wpCurrent.plan.weeklyRating
        var selected = (_wpCurrent.plan.weeklyRating && (
          (allEmojis[i].classList.contains('rating-gold') && _wpCurrent.plan.weeklyRating === 'gold') ||
          (allEmojis[i].classList.contains('rating-silver') && _wpCurrent.plan.weeklyRating === 'silver') ||
          (allEmojis[i].classList.contains('rating-bronze') && _wpCurrent.plan.weeklyRating === 'bronze') ||
          (allEmojis[i].classList.contains('rating-warn') && _wpCurrent.plan.weeklyRating === 'warn') ||
          (allEmojis[i].classList.contains('rating-danger') && _wpCurrent.plan.weeklyRating === 'danger')
        ));
        allEmojis[i].classList.toggle('rating-selected', !!selected);
      }
    }
  } catch (e) {}
  showToast(p.weeklyRating ? '🏅 评级已记录' : '🏅 评级已清除', 'info');
}

// ========== 从云端恢复周计划数据 ==========
// 强制从 Supabase 拉取所有周计划并保存到 localStorage
async function restoreWPFromCloud() {
  var name = _wpViewingSubordinate || _wpViewingDeptMember || (_uid || (currentUser && currentUser.name) || '');
  if (!name) {
    showToast('⚠️ 无法识别当前用户，请先登录', 'warning');
    return;
  }
  
  showToast('⏳ 正在从云端恢复数据...', 'info');
  
  try {
    if (typeof supabase === 'undefined' || !supabase || !supabase.from) {
      showToast('⚠️ Supabase 未初始化，无法从云端恢复', 'warning');
      return;
    }
    
    // 从 Supabase 拉取所有数据
    var allRows = [], from = 0, done = false;
    while (!done) {
      var resp = await supabase
        .from('hwm_workplans')
        .select('week_id,plan_data')
        .eq('username', name)
        .range(from, from + 999);
      if (resp.error) {
        console.error('HWM: restoreWPFromCloud failed', resp.error);
        showToast('⚠️ 从云端拉取数据失败: ' + resp.error.message, 'warning');
        return;
      }
      if (resp.data) allRows = allRows.concat(resp.data);
      if (!resp.data || resp.data.length < 1000) done = true;
      else from += 1000;
    }
    
    if (allRows.length === 0) {
      showToast('ℹ️ 云端没有找到你的周计划数据', 'info');
      return;
    }
    
    // 保存到 localStorage
    var key = 'hwm_workplans_' + name;
    var data = {};
    allRows.forEach(function(row) {
      if (!row.plan_data) return;
      var pid = row.week_id || '';
      var p = row.plan_data;
      if (!p.year || !p.month || !p.week) return;
      if (!data[p.year]) data[p.year] = {};
      if (!data[p.year][p.month]) data[p.year][p.month] = {};
      data[p.year][p.month][p.week] = p;
    });
    
    localStorage.setItem(key, JSON.stringify(data));
    
    // 重新加载数据到内存
    loadWPData();
    
    showToast('✅ 成功从云端恢复 ' + allRows.length + ' 条周计划数据！', 'success');
    
    // 刷新界面
    var y = _wpCurrent.year, m = _wpCurrent.month, w = _wpCurrent.week;
    if (y && m && w) {
      var p = getWP(y, m, w);
      if (p) renderWPTable(p);
    }
    
  } catch (e) {
    console.error('HWM: restoreWPFromCloud exception', e);
    showToast('⚠️ 恢复失败: ' + e.message, 'warning');
  }
}

// ========== AI 辅助评估（增强版，含历史数据分析）==========

// 从历史数据加载员工所有周计划
// 加载员工历史周计划（localStorage + Supabase 云端）
async function loadWPHistory(name) {
  var key = 'hwm_workplans_' + name;
  
  // ① 先读 localStorage（快）
  var plans = [];
  try {
    var raw = localStorage.getItem(key);
    if (raw) {
      var data = JSON.parse(raw);
      for (var year in data) {
        for (var month in data[year]) {
          for (var week in data[year][month]) {
            plans.push(data[year][month][week]);
          }
        }
      }
    }
  } catch (e) {}

  // ② 再从 Supabase 拉取（跨设备同步，失败不影响）
  if (typeof supabase !== 'undefined' && supabase && supabase.from) {
    try {
      var seen = {};
      plans.forEach(function(p) {
        if (p && p.year && p.month && p.week) {
          seen[p.year + '-' + p.month + '-' + p.week] = true;
        }
      });

      var allRows = [], from = 0, done = false;
      while (!done) {
        var resp = await supabase
          .from('hwm_workplans')
          .select('week_id,plan_data')
          .eq('username', name)
          .range(from, from + 999);
        if (resp.error) break;
        if (resp.data) allRows = allRows.concat(resp.data);
        if (!resp.data || resp.data.length < 1000) done = true;
        else from += 1000;
      }

      allRows.forEach(function(row) {
        if (!row.plan_data) return;
        var pid = row.week_id || '';
        if (seen[pid]) return;  // 已存在，跳过
        seen[pid] = true;
        plans.push(row.plan_data);
      });
    } catch (e) {
      console.warn('HWM: loadWPHistory Supabase fetch failed', e.message);
    }
  }

  return plans;
}

// 构建任务-工时数据库（按任务名索引）
function buildTaskDB(plans) {
  var taskDB = {};
  plans.forEach(function(p) {
    if (!p.tasks) return;
    p.tasks.forEach(function(t) {
      if (!t.work) return;
      var key = t.work.trim().replace(/\s+/g, '');
      if (!taskDB[key]) taskDB[key] = [];
      taskDB[key].push({
        year: p.year, month: p.month, week: p.week,
        est: parseFloat(t.estimatedHours) || 0,
        act: parseFloat(t.actualHours) || 0,
        status: t.status || ''
      });
    });
  });
  return taskDB;
}

// 查找相似任务（精确匹配 + 包含匹配）
function findSimilarTasks(workKey, taskDB) {
  var results = [];
  var normalizedKey = workKey.trim().replace(/\s+/g, '');
  if (taskDB[normalizedKey]) {
    results = results.concat(taskDB[normalizedKey]);
  }
  for (var key in taskDB) {
    if (key !== normalizedKey) {
      if (key.indexOf(normalizedKey) >= 0 || normalizedKey.indexOf(key) >= 0) {
        results = results.concat(taskDB[key]);
      }
    }
  }
  return results;
}

// 计算平均值
function calcAverage(arr) {
  if (arr.length === 0) return 0;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

// 增强版 AI 评估（异步，加载历史数据）
// ★ V0.3.36: AI 综合分析折叠/展开
var _aiExpanded = false;
var _wpOverviewExpanded = false;
var _wpOverviewAutoCollapseTimer = null;
function toggleWPOverview(forceState){
  _wpOverviewExpanded=typeof forceState==='boolean'?forceState:!_wpOverviewExpanded;
  var content=document.getElementById('wpOverviewContent');
  var icon=document.getElementById('wpOverviewIcon');
  var toggle=document.querySelector('#wpTimeMgmtPanel .wp-overview-toggle');
  if(!content)return;
  if(_wpOverviewExpanded){
    content.style.maxHeight=content.scrollHeight+'px';
    content.style.opacity='1';
  }else{
    content.style.maxHeight=content.scrollHeight+'px';
    requestAnimationFrame(function(){content.style.maxHeight='0';content.style.opacity='0';});
  }
  if(icon)icon.textContent=_wpOverviewExpanded?'收起 ▲':'展开 ▼';
  if(toggle)toggle.setAttribute('aria-expanded',_wpOverviewExpanded?'true':'false');
  if(!_wpOverviewExpanded)_cancelWPOverviewAutoCollapse();
}
function _cancelWPOverviewAutoCollapse(){
  if(_wpOverviewAutoCollapseTimer){clearTimeout(_wpOverviewAutoCollapseTimer);_wpOverviewAutoCollapseTimer=null;}
}
function _scheduleWPOverviewAutoCollapse(){
  _cancelWPOverviewAutoCollapse();
  if(!_wpOverviewExpanded||!window.matchMedia||!window.matchMedia('(hover:hover)').matches)return;
  _wpOverviewAutoCollapseTimer=setTimeout(function(){
    var panel=document.getElementById('wpTimeMgmtPanel');
    if(!panel||panel.matches(':hover')||panel.contains(document.activeElement))return;
    toggleWPOverview(false);
  },5000);
}
function toggleAIAnalysis(){
  _aiExpanded = !_aiExpanded;
  var el = document.getElementById('aiAnalysisContent');
  var icon = document.getElementById('aiToggleIcon');
  var text = document.getElementById('aiToggleText');
  var section = document.getElementById('aiFeedbackSection');
  if(!el) return;
  if(_aiExpanded){
    section.classList.remove('ai-section-collapsed');
    el.style.maxHeight = '450px';
    el.style.opacity = '1';
    el.style.padding = '12px 16px';
    el.style.marginTop = '0';
    el.style.overflow = 'auto';
    icon.textContent = '▲';
    text.textContent = '收起';
  }else{
    section.classList.add('ai-section-collapsed');
    el.style.maxHeight = '0';
    el.style.opacity = '0';
    el.style.paddingTop = '0';
    el.style.paddingBottom = '0';
    el.style.marginTop = '-8px';
    icon.textContent = '▼';
    text.textContent = '展开';
  }
}
var _yearGridExpanded = true;
function toggleYearGrid(){
  _yearGridExpanded = !_yearGridExpanded;
  var el = document.getElementById('wpYearGridContent');
  var btn = document.getElementById('wpYearGridToggle');
  if(!el) return;
  if(_yearGridExpanded){
    el.style.maxHeight = '300px';
    el.style.opacity = '1';
    if(btn) btn.textContent = '▲';
  }else{
    el.style.maxHeight = '0';
    el.style.opacity = '0';
    if(btn) btn.textContent = '▼';
  }
}

async function aiAssessWP() {
  var p = _wpCurrent.plan;
  if (!p) { _showAlert('请先选择一个周计划'); return; }

  var btn = document.getElementById('wpAiAssessBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI 分析中...'; }

  try {
    var history = await loadWPHistory(p.name);
    var analysis = [];
    var todayStr = new Date().toISOString().slice(0, 10);

    // === 整体数据统计 ===
    var validTasks = [], completed = 0, inProgress = 0, overdue = 0;
    var problemCount = 0, needBossCount = 0, paused = 0;
    for (var i = 0; i < p.tasks.length; i++) {
      var t = p.tasks[i];
      if (!t || !t.work || !t.work.trim()) continue;
      validTasks.push(t);
      if (t.status === '按时完成' || t.status === '逾期完成') completed++;
      else if (t.status === '⚙推进中' || t.status === '进行中') inProgress++;
      else if (t.status === '⏸暂停' || t.status === '已逾期') paused++;
      if (t.plannedDate && t.plannedDate < todayStr && t.status !== '按时完成' && t.status !== '逾期完成') overdue++;
      if (t.problems && t.problems.trim()) problemCount++;
      if (t.needBoss === '是') needBossCount++;
    }

    var total = validTasks.length;
    if (total === 0) {
      analysis.push('📋 本周暂无有效工作任务，请先添加任务后再生成分析。');
    } else {
      // 📊 整体概览
      analysis.push('【📊 整体概览】');
      var compRate = total > 0 ? Math.round(completed / total * 100) : 0;
      analysis.push('本周共 ' + total + ' 项任务：已完成 ' + completed + ' 项(' + compRate + '%)，进行中 ' + inProgress + '  项，已逾期 ' + paused + ' 项。');
      if (overdue > 0) analysis.push('⚠️ 有 ' + overdue + ' 项任务已逾期，建议优先处理。');
      if (completed === total && total > 0) analysis.push('🎉 所有任务均已完成，表现优秀！');

      // 🔝 优先级分布
      analysis.push('');
      analysis.push('【🔝 优先级分布】');
      var priStats = {};
      for (var i = 0; i < validTasks.length; i++) {
        var pri = validTasks[i].goal || '未标记';
        priStats[pri] = (priStats[pri] || 0) + 1;
      }
      for (var pri in priStats) analysis.push(pri + '：' + priStats[pri] + ' 项');
      if (!priStats['重要紧急'] || priStats['重要紧急'] === 0) {
        analysis.push('✅ 无"重要紧急"任务，当前节奏可控。');
      } else if (priStats['重要紧急'] >= 3) {
        analysis.push('⚡ "重要紧急"任务较多(' + priStats['重要紧急'] + '项)，建议评估规划前瞻性。');
      }

      // 🔥 困难分析
      if (problemCount > 0) {
        analysis.push('');
        analysis.push('【🔥 困难与风险】');
        var problemTypes = {};
        for (var i = 0; i < validTasks.length; i++) {
          if (validTasks[i].problems && validTasks[i].problems.trim()) {
            var pt = validTasks[i].problemType || '其他';
            problemTypes[pt] = (problemTypes[pt] || 0) + 1;
          }
        }
        for (var pt in problemTypes) analysis.push(pt + '：' + problemTypes[pt] + ' 项');
        var s3 = problemCount >= total * 0.5 ? '，困难覆盖范围较大，建议与上级集中讨论' : '';
        analysis.push('共 ' + problemCount + '/' + total + ' 项任务涉及困难/问题（' + Math.round(problemCount/total*100) + '%）' + s3);
      }

      // 🕐 逾期预警
      if (overdue > 0) {
        analysis.push('');
        analysis.push('【🕐 逾期预警】');
        for (var i = 0; i < validTasks.length; i++) {
          var ti = validTasks[i];
          if (ti.plannedDate && ti.plannedDate < todayStr && ti.status !== '按时完成' && ti.status !== '逾期完成') {
            analysis.push('🔴「' + ti.work + '」计划 ' + ti.plannedDate + ' 完成，已逾期。');
          }
        }
      }

      // 🔔 需上级关注
      if (needBossCount > 0) {
        analysis.push('');
        analysis.push('【🔔 需上级关注】');
        analysis.push('共 ' + needBossCount + ' 项任务标记"需上级介入"（' + Math.round(needBossCount/total*100) + '%）');
        if (needBossCount/total >= 0.5) analysis.push('建议主动与上级预约沟通讨论优先级和资源。');
      }

      // 📈 历史对比
      if (history.length > 0) {
        analysis.push('');
        analysis.push('【📈 历史对比】');
        var histComp = 0, histTotal = 0;
        for (var i = 0; i < history.length; i++) {
          var hw = history[i];
          if (hw && hw.tasks) {
            for (var j = 0; j < hw.tasks.length; j++) {
              if (hw.tasks[j].work && hw.tasks[j].work.trim()) { histTotal++; if (hw.tasks[j].status === '按时完成' || hw.tasks[j].status === '逾期完成') histComp++; }
            }
          }
        }
        if (histTotal > 0) {
          var histRate = Math.round(histComp / histTotal * 100);
          analysis.push('过去 ' + history.length + ' 周平均完成率：' + histRate + '%（' + histComp + '/' + histTotal + '项）');
          if (compRate < histRate - 20) analysis.push('⚠️ 本周完成率明显低于历史平均，需关注。');
        }
      }
    }

    p.aiAnalysis = analysis.map(function(line){
      var t=line.trim();
      if(!t) return '';
      if(t.startsWith('【')) return line;
      return '  \u25CF ' + line;
    }).join('\n');
    p.updatedAt = new Date().toISOString();
    saveWP(p.year, p.month, p.week, p);
    renderWPTable(p);

    if (btn) { btn.disabled = false; btn.innerHTML = '<span style="font-size:14px;font-weight:700">AI</span><span>建议</span>'; }
    _showAlert('AI 综合分析已生成，请查看下方「🤖 AI 综合分析」区域。');
  } catch (e) {
    console.error('[AI] 分析失败:', e);
    if (btn) { btn.disabled = false; btn.innerHTML = '<span style="font-size:14px;font-weight:700">AI</span><span>建议</span>'; }
    _showAlert('AI 分析失败：' + (e.message || '未知错误'));
  }
}

// ★ V0.5.79b: 周计划可见性管理函数
var _wpVisTab='grant'; // grant | received

function openWPVisibility(){
  loadWPVisibility();
  document.getElementById('wpVisibilityModal').style.display='flex';
  _wpVisTab='grant';
  renderWPVisTabs();
  renderWPVisGrantList();
}
function closeWPVisibility(){
  document.getElementById('wpVisibilityModal').style.display='none';
}
function switchWPVisTab(tab){
  _wpVisTab=tab;
  renderWPVisTabs();
  if(tab==='grant')renderWPVisGrantList();
  else renderWPVisReceivedList();
}
function renderWPVisTabs(){
  var t1=document.getElementById('wpVisTab1'), t2=document.getElementById('wpVisTab2');
  var g=document.getElementById('wpVisGrantPanel'), r=document.getElementById('wpVisReceivedPanel');
  if(t1){t1.style.cssText=_wpVisTab==='grant'?'flex:1;background:#3B7DB4;color:#fff':'flex:1;background:#CBD5E1;color:#475569';}
  if(t2){t2.style.cssText=_wpVisTab==='received'?'flex:1;background:#3B7DB4;color:#fff':'flex:1;background:#CBD5E1;color:#475569';}
  if(g)g.style.display=_wpVisTab==='grant'?'':'none';
  if(r)r.style.display=_wpVisTab==='received'?'':'none';
}

function renderWPVisGrantList(){
  var list=document.getElementById('wpVisGrantList');
  if(!list)return;
  var myName=currentUser.name;
  var sharedTo=_wpVisibility.sharedTo||[];
  if(sharedTo.length===0){list.innerHTML='<div style="text-align:center;padding:20px;color:#797973;font-size:13px">暂未授权任何同事</div>';return;}
  var html='';
  for(var i=0;i<sharedTo.length;i++){
    html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:4px;background:#fff;border:1px solid var(--border);border-radius:6px">'+
      '<span style="font-size:13px">'+esc(sharedTo[i])+'</span>'+
      '<button class="btn btn-sm" onclick="wpVisRevoke(\''+esc(sharedTo[i])+'\')" style="background:#fef2f2;color:#dc2626;padding:4px 10px;font-size:11px">移除</button>'+
      '</div>';
  }
  list.innerHTML=html;
}

function renderWPVisReceivedList(){
  var list=document.getElementById('wpVisReceivedList');
  if(!list)return;
  var shared=getSharedToMeList();
  if(shared.length===0){list.innerHTML='<div style="text-align:center;padding:40px;color:#797973">暂无授权</div>';return;}
  var html='';
  for(var i=0;i<shared.length;i++){
    var s=shared[i];
    html+='<div style="padding:10px 12px;margin-bottom:4px;background:#F0F5FF;border:1px solid #D0DDF5;border-radius:6px;font-size:13px">'+
      '📖 <strong>'+esc(s.name)+'</strong> 授权您阅览其周计划</div>';
  }
  list.innerHTML=html;
}

function wpVisSearchMember(){
  var q=(document.getElementById('wpVisSearch')||{}).value||'';
  var results=document.getElementById('wpVisSearchResults');
  if(!results)return;
  if(q.length<1){results.innerHTML='';return;}
  var matches=[];
  for(var i=0;i<allEmployees.length;i++){
    var e=allEmployees[i];
    if(!e.name||e.name===currentUser.name)continue;
    if(e.name.indexOf(q)>=0||(e.empId||'').indexOf(q)>=0){
      // check if already in sharedTo
      var already=(_wpVisibility.sharedTo||[]).indexOf(e.name)>=0;
      matches.push({name:e.name,dept:e.dept,already:already});
    }
    if(matches.length>=8)break;
  }
  if(matches.length===0){results.innerHTML='<div style="padding:8px;color:#797973;font-size:12px">未找到匹配同事</div>';return;}
  var html='';
  for(var i=0;i<matches.length;i++){
    var m=matches[i];
    html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:4px;background:#fff;border:1px solid var(--border);border-radius:6px;cursor:pointer;'+(m.already?'opacity:.5':'')+'" onclick="'+(m.already?'':'wpVisGrant(\''+esc(m.name)+'\')')+'">'+
      '<div><span style="font-size:13px">'+esc(m.name)+'</span><span style="font-size:11px;color:#797973;margin-left:8px">'+esc(m.dept||'')+'</span></div>'+
      '<span style="font-size:11px;color:'+(m.already?'#9ca3af':'#3B7DB4')+'">'+(m.already?'已授权':'＋ 授权阅览')+'</span>'+
      '</div>';
  }
  results.innerHTML=html;
}

function wpVisGrant(name){
  if(!_wpVisibility.sharedTo)_wpVisibility.sharedTo=[];
  if(_wpVisibility.sharedTo.indexOf(name)<0)_wpVisibility.sharedTo.push(name);
  saveWPVisibility();
  renderWPVisGrantList();
  document.getElementById('wpVisSearch').value='';
  wpVisSearchMember();
  // 重新渲染顶栏下拉
  renderWPSharedSelect();
  showToast('已授权 '+name+' 查看您的周计划');
}

function wpVisRevoke(name){
  if(!_wpVisibility.sharedTo)return;
  var idx=_wpVisibility.sharedTo.indexOf(name);
  if(idx>=0)_wpVisibility.sharedTo.splice(idx,1);
  saveWPVisibility();
  renderWPVisGrantList();
  renderWPSharedSelect();
  showToast('已取消 '+name+' 的查看权限');
}

// 渲染"分享给我的"下拉
function renderWPSharedSelect(){
  var shared=getSharedToMeList();
  var div=document.getElementById('wpSharedCustom');
  if(!div)return;
  if(shared.length===0){div.style.display='none';if(_wpViewingShared){switchToMyWP();}return;}
  div.style.display='';
  if(_wpViewingShared){
    var triggerText=document.getElementById('wpSharedTriggerText');
    if(triggerText)triggerText.textContent='📖 '+_wpViewingShared;
  }
  var dd=document.getElementById('wpSharedDropdown');
  if(dd){
    var html='';
    for(var i=0;i<shared.length;i++){
      var s=shared[i];
      var isActive=(s.name===_wpViewingShared)?' active':'';
      html+='<div class="wp-custom-option'+isActive+'" onclick="selectWPSharedOption(\''+esc(s.name)+'\')">📖 '+esc(s.name)+'</div>';
    }
    dd.innerHTML=html;
  }
}
function toggleWPSharedDropdown(){
  var dd=document.getElementById('wpSharedDropdown');
  if(!dd)return;
  dd.style.display=(dd.style.display==='block'?'none':'block');
}
function selectWPSharedOption(name){
  _wpViewingSubordinate=null;
  _wpViewingDeptMember=null;
  _wpViewingShared=name;
  var triggerText=document.getElementById('wpSharedTriggerText');
  if(triggerText)triggerText.textContent='📖 '+name;
  loadWPData();
  renderWPSubSelect();
  renderWPSharedSelect();
  renderWPUserInfo();
  // 切换到当前年月
  var nowD=new Date();
  selectWP(nowD.getFullYear(),nowD.getMonth()+1,1);
}
window.selectWPSharedOption=selectWPSharedOption;
window.toggleWPSort=toggleWPSort;

// ★ 判断当前查看模式是否为只读（被分享查看）
function isWPReadOnly(){
  return !!_wpViewingShared;
}

// ===== 系统维护模块 =====
