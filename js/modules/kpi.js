// ===== HWM HR - KPI 模块 (关键绩效指标) =====
// V0.5.76: 从 app.html 独立提取
// 
// 依赖（必须在此文件之前加载）：
//   config.js — APP_CONFIG
//   主程序 — showToast, _showAlert, _showConfirm, allEmployees, currentUser, USERS
//
// 导出（供后续模块调用）：
//   loadKPIModule(), renderKPI(), getKPISubordinates()
//
// =============================================

// ===== KPI 模块 =====
var _kpiInited=false;
var _kpiEditMode=false; // true=新建/编辑模式, false=只读查看
var _kpiCurrentData=null;
var _kpiViewingSubordinate=null; // 正在查看的下属 uid
var _kpiRevisionMode=false;     // 修订模式开关

function loadKPIModule(){
  if(!_kpiInited){
    _kpiInited=true;
    _kpiEditMode=false;
    _kpiViewingSubordinate=null;
    _kpiRevisionMode=false;
  }
  var sel=document.getElementById('kpiSubordinate');
  if(sel) sel.value='';
  // 每次进入都刷新下属选择器
  renderKPISubSelect();
  onKPITemplateChange();
}

function onKPITemplateChange(){
  var templateType=document.getElementById('kpiTemplate').value;
  var selects=['kpiPeriod','kpiRevisePeriod','kpiEvalPeriod'];
  for(var s=0;s<selects.length;s++){
    var sel=document.getElementById(selects[s]);
    sel.innerHTML='';
    if(templateType==='project'){
      for(var i=1;i<=12;i++){var o=document.createElement('option');o.value=i;o.textContent='M'+i;sel.appendChild(o);}
    }else{
      for(var i=1;i<=4;i++){var o=document.createElement('option');o.value=i;o.textContent='Q'+i;sel.appendChild(o);}
    }
  }
  renderKPI();
}

function onKPITimeChange(){ renderKPI(); }

function createNewKPI(){
  if(_kpiViewingSubordinate){_showAlert('请先退出下属查看模式再新建KPI');return;}
  _kpiEditMode=true;
  var sidebar=document.getElementById('kpiSidebar');
  if(sidebar) sidebar.classList.add('kpi-edit-mode');
  renderKPI();
  var info=getKPIInfo();
  var emp=getCurrentEmployee();
  var msg='已进入新建模式：请填写「'+emp.name+'」'+info.year+'年'+info.periodLabel+' KPI考核表';
  if(typeof showToast==='function') showToast(msg);
}

function getReviseInfo(){
  var year=document.getElementById('kpiReviseYear').value;
  var period=parseInt(document.getElementById('kpiRevisePeriod').value);
  var template=document.getElementById('kpiTemplate').value;
  var periodLabel=template==='project'?'M'+period:'Q'+period;
  return {year:year,period:period,periodLabel:periodLabel,template:template};
}

function reviseKPI(){
  var info=getReviseInfo();
  var emp=getCurrentEmployee();
  var msg='已进入「'+emp.name+'」'+info.year+'年'+info.periodLabel+' KPI修订模式';
  if(typeof showToast==='function') showToast(msg);
  else _showAlert(msg);
  // P1迭代：加载该期KPI数据进入编辑模式
}

function getEvalInfo(){
  var year=document.getElementById('kpiEvalYear').value;
  var period=parseInt(document.getElementById('kpiEvalPeriod').value);
  var template=document.getElementById('kpiTemplate').value;
  var periodLabel=template==='project'?'M'+period:'Q'+period;
  return {year:year,period:period,periodLabel:periodLabel,template:template};
}

function startKPISelfEval(){
  var info=getEvalInfo();
  var emp=getCurrentEmployee();
  var msg='已启动「'+emp.name+'」'+info.year+'年'+info.periodLabel+' KPI自评';
  if(typeof showToast==='function') showToast(msg);
  else _showAlert(msg);
  // P1迭代：加载KPI数据，开放自评列编辑
}

function renderKPI(){
  // 查看下属时隐藏新建/修订/自评按钮
  var newBtn=document.getElementById('kpiNewBtn');
  var reviseBtn=document.getElementById('kpiReviseBtn');
  var evalBtn=document.getElementById('kpiEvalBtn');
  if(_kpiViewingSubordinate){
    if(newBtn)newBtn.style.display='none';
    if(reviseBtn)reviseBtn.style.display='none';
    if(evalBtn)evalBtn.style.display='none';
  }else{
    if(newBtn)newBtn.style.display='';
    if(reviseBtn)reviseBtn.style.display='';
    if(evalBtn)evalBtn.style.display='';
  }
  var template=document.getElementById('kpiTemplate').value;
  var content=document.getElementById('kpiContent');
  if(_kpiEditMode){
    if(template==='senior') renderSeniorKPIEditable(content);
    else if(template==='middle') renderMiddleKPIEditable(content);
    else renderProjectKPI(content);
  }else{
    if(template==='senior') renderSeniorKPI(content);
    else if(template==='middle') renderMiddleKPI(content);
    else if(template==='project') renderProjectKPI(content);
  }
}

function getKPIInfo(){
  var year=document.getElementById('kpiYear').value;
  var period=parseInt(document.getElementById('kpiPeriod').value);
  var template=document.getElementById('kpiTemplate').value;
  var periodLabel=template==='project'?'M'+period:'Q'+period;
  return {year:year,period:period,periodLabel:periodLabel,template:template};
}

function getCurrentEmployee(){
  // currentUser 来自 USERS 对象，包含 name/role/dept/position
  var emp = currentUser || {};
  return {
    name: emp.name || '未知',
    dept: emp.dept || '未设置',
    position: emp.position || '未设置',
    supervisor: emp.supervisor || '',
    entryDate: emp.entryDate || ''
  };
}

// ★ V0.1.23: 获取当前正在查看的用户（自己/直属下属/部门成员），用于周计划模块
function getViewedUserEmp(){
  var targetName = _wpViewingShared || _wpViewingSubordinate || _wpViewingDeptMember || (currentUser&&currentUser.name) || '';
  if(!targetName) return getCurrentEmployee();
  // 先从 USERS 查找
  for(var uid in USERS){
    if(USERS.hasOwnProperty(uid) && USERS[uid].name === targetName){
      var u = USERS[uid];
      return {name: u.name || targetName, dept: u.dept || '', position: u.position || ''};
    }
  }
  // 再从 allEmployees 查找
  if(typeof allEmployees !== 'undefined'){
    for(var i=0; i<allEmployees.length; i++){
      if(allEmployees[i].name === targetName || allEmployees[i]['姓名'] === targetName){
        var e = allEmployees[i];
        return {name: targetName, dept: e.dept || e['部门'] || '', position: e.position || e['岗位'] || ''};
      }
    }
  }
  // 查不到就只返回名字
  return {name: targetName, dept: '', position: ''};
}

function catTag(cat){
  var cls='';
  switch(cat){
    case '财务类':cls='cat-finance';break;
    case '客户类':cls='cat-customer';break;
    case '运营类':cls='cat-ops';break;
    case '学习发展类':cls='cat-learning';break;
    default:return cat;
  }
  return '<span class="cat-tag '+cls+'">'+cat+'</span>';
}

function gradeBadge(score){
  if(score>12) return '<span class="grade-badge grade-S">S</span>';
  if(score>=10) return '<span class="grade-badge grade-A">A</span>';
  if(score>=8) return '<span class="grade-badge grade-B">B</span>';
  if(score>=6) return '<span class="grade-badge grade-C">C</span>';
  return '<span class="grade-badge grade-D">D</span>';
}

// ===== KPI 可编辑输入控件 =====
function kpiInput(name,value,cls){
  return '<input class="kpi-input '+(cls||'')+'" name="'+name+'" value="'+_h(value)+'" autocomplete="off">';
}
function kpiTextarea(name,value){
  return '<textarea class="kpi-textarea" name="'+name+'">'+_h(value)+'</textarea>';
}
function kpiSelect(name,opts,sel){
  var s='<select class="kpi-input kpi-select-sm" name="'+name+'">';
  for(var i=0;i<opts.length;i++) s+='<option value="'+opts[i]+'"'+(opts[i]===sel?' selected':'')+'>'+opts[i]+'</option>';
  return s+'</select>';
}
function _h(v){return (v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// V0.3.63: 合并连续换行为单个，防止粘贴内容撑大行高
// V0.3.64: 统计数字颜色从#02314D改为#1B6EC4科技蓝，提升可读性
// V0.3.65: 人口统计条形图数字(.demo-bar-num)从--text-hint(#C8C8C8)改为#1B6EC4科技蓝
// V0.3.66: 协同人多人时每个姓名独占一行(用div替代逗号分隔)
// V0.3.67: 协同人换行改用<br>方案——div在td内可能被CSS覆盖，<br>强制换行更可靠
// V0.3.68: 重要紧急优先级红色从#dc2626改为#D94352(HWM品牌珊瑚红)，含CSS+JS+协同徽章三处同步
// V0.3.69: "回到我的周计划"按钮自动选中当前时间对应周（而非空白）
// V0.3.70: 序号列垂直排列——序号在上、+号居中、-号在下（flex-direction:column）
// V0.3.71: 修复协同人换行——调用点从renderWPCellValue改为始终走_renderSupportersCell(含revision支持)
// V0.3.72: .wp-topbar添加box-shadow底部浮显投影效果
// V0.3.106: 内容区底色从暖奶黄#FBF7EE改为中性浅灰#F4F5F7
// V0.3.74: 计分规则/评分标准/完成状态/积分统计改为4卡片仪表盘（.wp-cards-grid+.wp-card）
// V0.3.75: 顶栏蓝→钢蓝灰#5B7089，侧栏浅灰→深色渐变#4E6278→#5B7289(文字反白)
// V0.3.76: 修复切换周次时卡片面板重复追加的bug（wp-cards-grid补回id=wpTimeMgmtPanel）
// V0.3.77: 表格奇偶行交替底色
// V0.3.78: 门户已开发模块→钢蓝#4E6278，待开发→灰蓝#D0D8E2
// V0.3.79: "退出登录"按钮改为钢蓝#4E6278
// V0.3.80: 去掉表格隔行底色(#F3F4F5太重)，线条改为极微rgba(0,0,0,.05)
// V0.3.81: 汇总栏去背景+表格竖线可见(#E2E4E7)+表头文字调深#2D3748
function _hWork(v){return _h((v||'').replace(/\n{2,}/g,'\n'));}

// ===== KPI 可编辑渲染 =====
function renderSeniorKPIEditable(container){
  var info=getKPIInfo();
  var emp=getCurrentEmployee();
  var categories=['财务类','客户类','运营类','学习发展类'];
  var html='';
  html+='<div class="kpi-employee-info">';
  html+='<strong>'+emp.name+'</strong><span class="sep">|</span>';
  html+=emp.dept+'<span class="sep">|</span>'+emp.position+'<span class="sep">|</span>';
  html+='直属上级：'+emp.supervisor+'<span class="sep">|</span>入职日期：'+emp.entryDate+'<span class="sep">|</span>';
  html+='考核期：'+info.year+'-'+info.periodLabel;
  html+='</div>';
  html+='<div class="kpi-title">'+info.year+'年 管理层季度绩效目标及考核表（'+info.periodLabel.replace('Q','')+'季度）<span class="kpi-edit-badge">新建模式</span></div>';
  html+='<div class="kpi-subtitle">请填写以下 KPI 指标及 KPA 关键任务，完成后点击「提交并保存」</div>';
  html+='<div class="kpi-submit-bar"><button class="kpi-submit-btn" onclick="submitNewKPI(\'senior\')"><span class="icon">✅</span>提交并保存</button><button class="kpi-cancel-btn" onclick="cancelNewKPI()"><span class="icon">↩</span>返回到KPI</button></div>';

  // KPI 指标表
  html+='<div class="kpi-table-wrap"><table class="kpi-table"><thead><tr>';
  html+='<th>NO.</th><th>类别</th><th>指标说明</th><th>上年目标</th><th>上年实际</th><th>权重</th><th>合格标准</th><th>评估规则</th><th>完成结果</th><th>评价方</th><th>评分(自评)</th><th>评分(上级)</th><th>说明</th>';
  html+='</tr></thead><tbody>';
  for(var i=0;i<5;i++){
    html+='<tr>';
    html+='<td class="text-center">'+(i+1)+'</td>';
    html+='<td class="text-center">'+kpiSelect('scat_'+i,categories,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('sind_'+i,'')+'</td>';
    html+='<td class="text-center">'+kpiInput('slyt_'+i,'','kpi-input-sm')+'</td>';
    html+='<td class="text-center">'+kpiInput('slya_'+i,'','kpi-input-sm')+'</td>';
    html+='<td class="text-center">'+kpiInput('swgt_'+i,'','kpi-input-num')+'</td>';
    html+='<td class="text-left">'+kpiInput('sstd_'+i,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('srule_'+i,'')+'</td>';
    html+='<td class="text-left">'+kpiInput('sres_'+i,'')+'</td>';
    html+='<td class="text-center">'+kpiInput('seval_'+i,'','kpi-input-sm')+'</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">自评</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">上级</td>';
    html+='<td class="text-left">'+kpiInput('snote_'+i,'')+'</td>';
    html+='</tr>';
  }
  // KPA 关键任务
  html+='<tr><td colspan="13" style="background:#F5F5F0;font-weight:600;padding:8px;text-align:left;font-size:13px">1.2 KPA关键任务/项目</td></tr>';
  html+='<tr><th>NO.</th><th>任务/项目名称</th><th>任务说明</th><th>时间节点</th><th>权重</th><th>里程碑(交付物)</th><th>评估规则</th><th>完成结果</th><th>评价方</th><th>评分(自评)</th><th>评分(上级)</th><th>说明</th><th></th></tr>';
  for(var j=0;j<4;j++){
    html+='<tr>';
    html+='<td class="text-center">'+(j+1)+'</td>';
    html+='<td class="text-left">'+kpiInput('span_'+j,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('spad_'+j,'')+'</td>';
    html+='<td class="text-center">'+kpiInput('spdl_'+j,'','kpi-input-sm')+'</td>';
    html+='<td class="text-center">'+kpiInput('spwg_'+j,'','kpi-input-num')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('spms_'+j,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('spru_'+j,'')+'</td>';
    html+='<td class="text-left">'+kpiInput('spres_'+j,'')+'</td>';
    html+='<td class="text-center">'+kpiInput('spevl_'+j,'','kpi-input-sm')+'</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">自评</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">上级</td>';
    html+='<td class="text-left">'+kpiInput('spnt_'+j,'')+'</td>';
    html+='<td></td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';

  // 底部提交按钮
  html+='<div class="kpi-submit-bar"><button class="kpi-submit-btn" onclick="submitNewKPI(\'senior\')"><span class="icon">✅</span>提交并保存</button><button class="kpi-cancel-btn" onclick="cancelNewKPI()"><span class="icon">↩</span>返回到KPI</button></div>';
  html+='<div class="kpi-summary" style="font-size:11px;color:var(--text-hint);margin-top:4px">提示：填写完毕后请点击「提交并保存」，默认保存后进入只读查看模式。</div>';

  container.innerHTML=html;
}

function renderMiddleKPIEditable(container){
  var info=getKPIInfo();
  var emp=getCurrentEmployee();
  var html='';
  html+='<div class="kpi-employee-info">';
  html+='<strong>'+emp.name+'</strong><span class="sep">|</span>';
  html+=emp.dept+'<span class="sep">|</span>'+emp.position+'<span class="sep">|</span>';
  html+='直属上级：'+emp.supervisor+'<span class="sep">|</span>考核期：'+info.year+'-'+info.periodLabel;
  html+='</div>';
  html+='<div class="kpi-title">'+info.year+'年 员工岗位绩效目标与考核表（第'+('一二三四'.charAt(info.period-1))+'季度）<span class="kpi-edit-badge">新建模式</span></div>';
  html+='<div class="kpi-subtitle">请填写以下关键职责和关键任务，完成后点击「提交并保存」</div>';
  html+='<div class="kpi-submit-bar"><button class="kpi-submit-btn" onclick="submitNewKPI(\'middle\')"><span class="icon">✅</span>提交并保存</button><button class="kpi-cancel-btn" onclick="cancelNewKPI()"><span class="icon">↩</span>返回到KPI</button></div>';

  // 第一部分：关键职责
  html+='<div class="kpi-section-title">第一部分：关键职责</div>';
  html+='<div class="kpi-table-wrap"><table class="kpi-table"><thead><tr>';
  html+='<th>序号</th><th>关键职责</th><th>标准及要求</th><th>合格线</th><th>评分规则</th><th>进展及GAP原因分析</th><th>自评</th><th>直属上级评</th><th>备注</th>';
  html+='</tr></thead><tbody>';
  for(var i=0;i<5;i++){
    html+='<tr>';
    html+='<td class="text-center">'+(i+1)+'</td>';
    html+='<td class="text-left">'+kpiTextarea('mdut_'+i,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('mstd_'+i,'')+'</td>';
    html+='<td class="text-center">'+kpiInput('mqln_'+i,'','kpi-input-sm')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('mrul_'+i,'')+'</td>';
    html+='<td class="text-left" style="color:var(--text-hint)">考核后填写</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">自评</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">上级</td>';
    html+='<td class="text-left" style="color:var(--text-hint)">考核后填写</td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';

  // 第二部分：关键任务
  html+='<div class="kpi-section-title">第二部分：关键任务/项目</div>';
  html+='<div class="kpi-table-wrap"><table class="kpi-table"><thead><tr>';
  html+='<th>序号</th><th>关键任务</th><th>标准及要求</th><th>评分规则</th><th>进展及GAP原因分析</th><th>相关方评</th><th>直属上级评</th><th>综合得分</th>';
  html+='</tr></thead><tbody>';
  for(var j=0;j<5;j++){
    html+='<tr>';
    html+='<td class="text-center">'+(j+1)+'</td>';
    html+='<td class="text-left">'+kpiInput('mtnm_'+j,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('mtst_'+j,'')+'</td>';
    html+='<td class="text-left">'+kpiTextarea('mtru_'+j,'')+'</td>';
    html+='<td class="text-left" style="color:var(--text-hint)">考核后填写</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">相关方</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">上级</td>';
    html+='<td class="text-center" style="color:var(--text-hint)">综合</td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';

  html+='<div class="kpi-submit-bar"><button class="kpi-submit-btn" onclick="submitNewKPI(\'middle\')"><span class="icon">✅</span>提交并保存</button><button class="kpi-cancel-btn" onclick="cancelNewKPI()"><span class="icon">↩</span>返回到KPI</button></div>';
  html+='<div class="kpi-summary" style="font-size:11px;color:var(--text-hint);margin-top:4px">提示：填写完毕后请点击「提交并保存」，默认保存后进入只读查看模式。</div>';

  container.innerHTML=html;
}

function submitNewKPI(templateType){
  var data={template:templateType,info:getKPIInfo(),employee:getCurrentEmployee(),items:[]};
  var allInputs=document.getElementById('kpiContent').querySelectorAll('input[name],textarea[name],select[name]');
  var hasContent=false;
  for(var i=0;i<allInputs.length;i++){
    var el=allInputs[i];
    var val=el.value.trim();
    data.items.push({name:el.name,value:val});
    if(val) hasContent=true;
  }
  if(!hasContent){
    _showAlert('请至少填写一项 KPI 内容再提交');
    return;
  }
  // 退出编辑模式，切回只读
  _kpiEditMode=false;
  var sidebar=document.getElementById('kpiSidebar');
  if(sidebar) sidebar.classList.remove('kpi-edit-mode');
  renderKPI();
  // P1 迭代：保存到 Supabase
  var msg='✅ KPI 考核表已提交并保存成功！';
  if(typeof showToast==='function') showToast(msg);
  else _showAlert(msg);
  console.log('KPI submitted:',data);
}

function cancelNewKPI(){
  // 取消新建，退出编辑模式，返回 KPI 首页
  _kpiEditMode=false;
  var sidebar=document.getElementById('kpiSidebar');
  if(sidebar) sidebar.classList.remove('kpi-edit-mode');
  renderKPI();
}

// ===== KPI 下属查看 & 修订模式 =====
function getKPISubordinates(){
  if(!currentUser||!currentUser._uid)return[];
  return getSubordinates(currentUser._uid);
}

function renderKPISubSelect(){
  var sel=document.getElementById('kpiSubSelect');
  if(!sel)return;
  var subs=getKPISubordinates();
  var myName=(currentUser&&currentUser.name)||'';
  // 过滤掉自己的名字
  subs=subs.filter(function(s){var u=USERS[s];return u&&u.name!==myName;});
  if(subs.length===0){
    sel.style.display='none';
    return;
  }
  sel.style.display='block';
  var s=document.getElementById('kpiSubordinate');
  if(!s)return;
  s.innerHTML='<option value="">-- 查看下属KPI --</option>';
  for(var i=0;i<subs.length;i++){
    var sub=USERS[subs[i]];
    if(!sub)continue;
    // 获知直属/间接关系
    var relType='直属';
    var cu=USERS[currentUser._uid];
    if(cu&&cu.subordinates&&cu.subordinates[subs[i]]==='indirect')relType='间接';
    s.innerHTML+='<option value="'+subs[i]+'"'+(_kpiViewingSubordinate===subs[i]?' selected':'')+'>'+_h(sub.name)+' - '+_h(sub.dept||'')+' ('+relType+')</option>';
  }
  // 「← 返回我的KPI」按钮：仅在查看下属时显示
  var myBtn=document.getElementById('kpiBtnMyPlan');
  if(myBtn)myBtn.style.display=_kpiViewingSubordinate?'block':'none';
}

function onKPISubordinateChange(){
  var sel=document.getElementById('kpiSubordinate');
  var val=sel.value||null;
  var myName=(currentUser&&currentUser.name)||'';
  var sub=val?USERS[val]:null;
  // 选中自己 = 切回自己的KPI
  if(sub&&sub.name===myName)val=null;
  _kpiViewingSubordinate=val;
  _kpiRevisionMode=false;
  renderKPI();
}

function switchToMyKPI(){
  _kpiViewingSubordinate=null;
  _kpiRevisionMode=false;
  _kpiCurrentData=null;
  renderKPI();
}

function renderKPICellValue(data, fieldKey, originalValue){
  if(data._revisions&&data._revisions[fieldKey]&&data._revisions[fieldKey].value){
    var rev=data._revisions[fieldKey];
    return '<span style="color:#e53e3e" title="原值：'+_h(originalValue||'')+'&#10;修订人：'+_h(rev.by||'')+'&#10;时间：'+_h(rev.at||'')+'">'+_h(rev.value)+'</span>';
  }
  return _h(originalValue||'');
}

function toggleKPIRevisionMode(){
  _kpiRevisionMode=!_kpiRevisionMode;
  renderKPI();
}

function getKPISubordinateEmployee(){
  if(!_kpiViewingSubordinate)return getCurrentEmployee();
  var sub=USERS[_kpiViewingSubordinate];
  if(!sub)return getCurrentEmployee();
  return {
    name:sub.name||'未知', dept:sub.dept||'', position:sub.position||'',
    supervisor:sub.supervisor||'', entryDate:sub.entryDate||'', uid:_kpiViewingSubordinate
  };
}

function openKPIBossEval(){
  var emp=getKPISubordinateEmployee();
  if(!_kpiViewingSubordinate){_showAlert('请先选择下属');return;}
  var comment=prompt('请输入对「'+emp.name+'」的 KPI 评价意见：',(_kpiCurrentData&&_kpiCurrentData.bossComment)||'');
  if(comment===null)return;
  if(!_kpiCurrentData)_kpiCurrentData={};
  _kpiCurrentData.bossComment=comment;
  _kpiCurrentData.bossEvaluated=true;
  _kpiCurrentData.bossEvalBy=currentUser?currentUser.name:'上级';
  _kpiCurrentData.bossEvalAt=new Date().toISOString();
  renderKPI();
}

function viewKPIBossEval(){
  if(!_kpiCurrentData){
    _showAlert('暂无上级评价。');
    return;
  }
  var comment=_kpiCurrentData.bossComment||'';
  var evalBy=_kpiCurrentData.bossEvalBy||'';
  var evalAt=(_kpiCurrentData.bossEvalAt||'').substring(0,10);
  if(!comment){_showAlert('暂无上级评价。');return;}
  _showAlert('上级评价（'+evalBy+'，'+evalAt+'）：\n\n'+comment);
}

function renderSeniorKPI(container){
  var info=getKPIInfo();
  var emp=getKPISubordinateEmployee();
  var kpiItems=getSeniorKPIData();
  var kpaItems=getSeniorKPAData();
  var totalWeight=0;
  kpiItems.forEach(function(it){totalWeight+=it.weight||0;});
  kpaItems.forEach(function(it){totalWeight+=it.weight||0;});

  var html='';
  html+='<div class="kpi-employee-info">';
  if(_kpiViewingSubordinate) html+='<span style="color:#E8622A;font-weight:500">（查看下属：'+_h(emp.name)+'）</span><span class="sep">|</span>';
  else html+='<span style="color:#E8622A;font-weight:600">👤 我的KPI</span><span class="sep">|</span>';
  if(_kpiRevisionMode) html+='<span style="color:#e53e3e;font-weight:500">🔴 修订模式</span><span class="sep">|</span>';
  html+='<strong>'+emp.name+'</strong><span class="sep">|</span>';
  html+=emp.dept+'<span class="sep">|</span>';
  html+=emp.position+'<span class="sep">|</span>';
  html+='直属上级：'+emp.supervisor+'<span class="sep">|</span>';
  html+='入职日期：'+emp.entryDate+'<span class="sep">|</span>';
  html+='考核期：'+info.year+'-'+info.periodLabel;
  html+='</div>';

  html+='<div class="kpi-title">「'+info.year+'年」管理层季度绩效目标及考核表（'+info.periodLabel.replace('Q','')+'季度）</div>';
  html+='<div class="kpi-subtitle">适应对象：部门负责人一级管理层、技术顾问、技术专家适用</div>';

  // KPI 表格
  html+='<div class="kpi-table-wrap">';
  html+='<table class="kpi-table"><thead><tr>';
  html+='<th>NO.</th><th>类别</th><th>指标说明</th><th>上年目标</th><th>上年实际</th><th>权重</th><th>合格标准</th><th>评估规则</th><th>完成结果</th><th>评价方</th><th>评分(自评)</th><th>评分(上级)</th><th>说明</th>';
  html+='</tr></thead><tbody>';
  for(var i=0;i<kpiItems.length;i++){
    var it=kpiItems[i];
    html+='<tr>';
    html+='<td class="text-center">'+(i+1)+'</td>';
    html+='<td class="text-center">'+catTag(it.category)+'</td>';
    html+='<td class="text-left">'+it.indicator+'</td>';
    html+='<td class="text-center">'+it.lastYearTarget+'</td>';
    html+='<td class="text-center">'+it.lastYearActual+'</td>';
    html+='<td class="text-center">'+Math.round(it.weight*100)+'%</td>';
    html+='<td class="text-left">'+it.standard+'</td>';
    html+='<td class="text-left">'+it.rule+'</td>';
    html+='<td class="text-left">'+(it.result||'')+'</td>';
    html+='<td class="text-center">'+it.evaluator+'</td>';
    html+='<td class="text-center">'+(it.selfScore!==null&&it.selfScore!==undefined?it.selfScore:'')+'</td>';
    html+='<td class="text-center">'+(it.managerScore!==null&&it.managerScore!==undefined?it.managerScore:'')+'</td>';
    html+='<td class="text-left">'+(it.note||'')+'</td>';
    html+='</tr>';
  }
  // KPA 表格
  html+='<tr><td colspan="13" style="background:#F5F5F0;font-weight:600;padding:8px;text-align:left;font-size:13px">1.2 KPA关键任务/项目</td></tr>';
  html+='<tr>';
  html+='<th>NO.</th><th>任务/项目名称</th><th>任务说明</th><th>时间节点</th><th>权重</th><th>里程碑(交付物)</th><th>评估规则</th><th>完成结果</th><th>评价方</th><th>评分(自评)</th><th>评分(上级)</th><th>说明</th><th></th>';
  html+='</tr>';
  for(var j=0;j<kpaItems.length;j++){
    var ka=kpaItems[j];
    html+='<tr>';
    html+='<td class="text-center">'+(j+1)+'</td>';
    html+='<td class="text-left">'+ka.name+'</td>';
    html+='<td class="text-left">'+ka.desc+'</td>';
    html+='<td class="text-center">'+ka.deadline+'</td>';
    html+='<td class="text-center">'+Math.round(ka.weight*100)+'%</td>';
    html+='<td class="text-left">'+ka.milestone+'</td>';
    html+='<td class="text-left">'+ka.rule+'</td>';
    html+='<td class="text-left">'+(ka.result||'')+'</td>';
    html+='<td class="text-center">'+(ka.evaluator||'--')+'</td>';
    html+='<td class="text-center">'+(ka.selfScore!==null&&ka.selfScore!==undefined?ka.selfScore:'')+'</td>';
    html+='<td class="text-center">'+(ka.managerScore!==null&&ka.managerScore!==undefined?ka.managerScore:'')+'</td>';
    html+='<td class="text-left">'+(ka.note||'')+'</td>';
    html+='<td></td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';

  // 得分汇总
  var totalWeightPercent=Math.round(totalWeight*100);
  html+='<div class="kpi-summary">';
  html+='<div class="kpi-summary-item"><span class="kpi-summary-label">合计权重：</span><strong>'+totalWeightPercent+'%</strong></div>';
  html+='<div class="kpi-summary-item"><span class="kpi-summary-label">得分：</span><strong>--</strong></div>';
  html+='<div class="kpi-summary-item"><span class="kpi-summary-label">绩效等级：</span>'+gradeBadge(0)+'</div>';
  html+='</div>';

  // 绩效沟通与结果确认
  html+='<div class="kpi-communication"><div class="kpi-comm-header" onclick="var b=this.nextElementSibling;b.classList.toggle(\'open\')">2.0 绩效沟通与结果确认 <span>▼</span></div>';
  html+='<div class="kpi-comm-body"><div class="kpi-comm-row"><div class="kpi-comm-label">关键业绩/成就是什么？</div><div class="kpi-comm-value"></div></div>';
  html+='<div class="kpi-comm-row"><div class="kpi-comm-label">有哪些需要改进？</div><div class="kpi-comm-value"></div></div>';
  html+='<div class="kpi-comm-row"><div class="kpi-comm-label">当前工作的挑战或建议？</div><div class="kpi-comm-value"></div></div>';
  html+='<div class="kpi-comm-row"><div class="kpi-comm-label">其他希望讨论的问题？</div><div class="kpi-comm-value"></div></div>';
  html+='<div class="kpi-comm-row"><div class="kpi-comm-label">直属领导总评语及建议</div><div class="kpi-comm-value"></div></div></div></div>';

  // 下属查看：上级评价 & 修订模式按钮
  if(_kpiViewingSubordinate){
    // 上级查看下属：可编辑评价
    html+='<div class="kpi-submit-bar" style="margin-top:12px">';
    html+='<button class="' + (_kpiRevisionMode?'wp-btn-warn':'') + '" onclick="toggleKPIRevisionMode()" title="开启后可对下属KPI进行修订注释，修订将以红色标注">';
    html+=_kpiRevisionMode?'🔴 关闭修订':'✏️ 开启修订';
    html+='</button>';
    html+='<button onclick="openKPIBossEval()">⭐ 上级评价</button>';
    if(_kpiCurrentData&&_kpiCurrentData.bossComment){
      html+='<div class="kpi-summary" style="margin-top:8px;padding:10px 14px;border-left:3px solid var(--primary);background:#F0F7FF">';
      html+='<strong>上级评价</strong>（'+_h(_kpiCurrentData.bossEvalBy||'')+'，'+_h((_kpiCurrentData.bossEvalAt||'').substring(0,10))+'）：<br>'+_h(_kpiCurrentData.bossComment);
      html+='</div>';
    }
    html+='</div>';
  }else{
    // 自己查看自己的KPI：显示查看上级评价按钮（只读）
    if(_kpiCurrentData&&_kpiCurrentData.bossComment){
      html+='<div class="kpi-submit-bar" style="margin-top:12px">';
      html+='<button onclick="viewKPIBossEval()"><span style="color:#2A476A">📋</span> 查看上级评价</button>';
      html+='</div>';
      html+='<div class="kpi-summary" style="margin-top:8px;padding:10px 14px;border-left:3px solid var(--primary);background:#F0F7FF">';
      html+='<strong>上级评价</strong>（'+_h(_kpiCurrentData.bossEvalBy||'')+'，'+_h((_kpiCurrentData.bossEvalAt||'').substring(0,10))+'）：<br>'+_h(_kpiCurrentData.bossComment);
      html+='</div>';
    }
  }

  // 签名确认
  html+='<div class="kpi-summary" style="margin-top:12px;font-size:12px">';
  html+='员工签名：________ 日期：________ &nbsp;&nbsp;|&nbsp;&nbsp;上级签名：________ 日期：________<br>';
  html+='评价结果确认：○ 同意 ○ 持保留意见<br>';
  html+='HRBP签名：________ 日期：________<br>';
  html+='执行标准依据：HW-M-HR-004绩效管理办法 A0';
  html+='</div>';

  container.innerHTML=html;
}

function renderMiddleKPI(container){
  var info=getKPIInfo();
  var emp=getKPISubordinateEmployee();
  var respItems=getMiddleRespData();
  var taskItems=getMiddleTaskData();

  var html='';
  html+='<div class="kpi-employee-info">';
  if(_kpiViewingSubordinate) html+='<span style="color:#E8622A;font-weight:500">（查看下属：'+_h(emp.name)+'）</span><span class="sep">|</span>';
  else html+='<span style="color:#E8622A;font-weight:600">👤 我的KPI</span><span class="sep">|</span>';
  if(_kpiRevisionMode) html+='<span style="color:#e53e3e;font-weight:500">🔴 修订模式</span><span class="sep">|</span>';
  html+='<strong>'+emp.name+'</strong><span class="sep">|</span>';
  html+=emp.dept+'<span class="sep">|</span>';
  html+=emp.position+'<span class="sep">|</span>';
  html+='直属上级：'+emp.supervisor+'<span class="sep">|</span>';
  html+='考核期：'+info.year+'-'+info.periodLabel;
  html+='</div>';

  html+='<div class="kpi-title">「'+info.year+'年」员工岗位绩效目标与考核表（第'+(info.template==='project'?info.period:'一二三四'.charAt(info.period-1))+'季度）</div>';
  html+='<div class="kpi-subtitle">（经理及以下适用）</div>';

  // 第一部分：关键职责
  html+='<div class="kpi-section-title">第一部分：关键职责</div>';
  html+='<div class="kpi-table-wrap">';
  html+='<table class="kpi-table"><thead><tr>';
  html+='<th>序号</th><th>关键职责</th><th>标准及要求</th><th>合格线</th><th>评分规则</th><th>进展及GAP原因分析</th><th>自评</th><th>直属上级评</th><th>备注</th>';
  html+='</tr></thead><tbody>';
  for(var i=0;i<respItems.length;i++){
    var r=respItems[i];
    html+='<tr>';
    html+='<td class="text-center">'+(i+1)+'</td>';
    html+='<td class="text-left">'+r.duty+'</td>';
    html+='<td class="text-left">'+r.standard+'</td>';
    html+='<td class="text-center">'+r.qualifiedLine+'</td>';
    html+='<td class="text-left">'+r.scoreRule+'</td>';
    html+='<td class="text-left">'+(r.gap||'')+'</td>';
    html+='<td class="text-center">'+(r.selfScore!==null&&r.selfScore!==undefined?r.selfScore:'')+'</td>';
    html+='<td class="text-center">'+(r.managerScore!==null&&r.managerScore!==undefined?r.managerScore:'')+'</td>';
    html+='<td class="text-left">'+(r.note||'')+'</td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';

  // 第二部分：关键任务
  html+='<div class="kpi-section-title">第二部分：关键任务/项目</div>';
  html+='<div class="kpi-table-wrap">';
  html+='<table class="kpi-table"><thead><tr>';
  html+='<th>序号</th><th>关键任务</th><th>标准及要求</th><th>评分规则</th><th>进展及GAP原因分析</th><th>相关方评</th><th>直属上级评</th><th>综合得分</th>';
  html+='</tr></thead><tbody>';
  for(var j=0;j<taskItems.length;j++){
    var t=taskItems[j];
    html+='<tr>';
    html+='<td class="text-center">'+(j+1)+'</td>';
    html+='<td class="text-left">'+t.name+'</td>';
    html+='<td class="text-left">'+t.standard+'</td>';
    html+='<td class="text-left">'+t.scoreRule+'</td>';
    html+='<td class="text-left">'+(t.gap||'')+'</td>';
    html+='<td class="text-center">'+(t.stakeholderScore!==null&&t.stakeholderScore!==undefined?t.stakeholderScore:'')+'</td>';
    html+='<td class="text-center">'+(t.managerScore!==null&&t.managerScore!==undefined?t.managerScore:'')+'</td>';
    html+='<td class="text-center">'+(t.compositeScore!==null&&t.compositeScore!==undefined?t.compositeScore:'')+'</td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';

  // 得分汇总 + 等级
  html+='<div class="kpi-summary">';
  html+='<div class="kpi-summary-item"><span class="kpi-summary-label">满分10分，基准分10分</span></div>';
  html+='<div class="kpi-summary-item"><span class="kpi-summary-label">绩效等级：</span>'+gradeBadge(0)+'</div>';
  html+='</div>';

  // 定义说明
  html+='<div class="kpi-summary" style="margin-top:8px;font-size:11px;color:var(--text-hint)">';
  html+='评分规则：符合标准：+/-0分 | 有差距：-(0.5~2)分 | 严重偏离合格标准：-(3~4)分 | 因疏失而未进行：-5分<br>';
  html+='绩效等级：S(卓越)＞12分 | A(优良)≥10分 | B(合格)≥8分 | C(待提升)＜8分 | D(严重偏离)＜6分';
  html+='</div>';

  // 下属查看：上级评价 & 修订模式按钮
  if(_kpiViewingSubordinate){
    // 上级查看下属：可编辑评价
    html+='<div class="kpi-submit-bar" style="margin-top:12px">';
    html+='<button class="' + (_kpiRevisionMode?'wp-btn-warn':'') + '" onclick="toggleKPIRevisionMode()" title="开启后可对下属KPI进行修订注释，修订将以红色标注">';
    html+=_kpiRevisionMode?'🔴 关闭修订':'✏️ 开启修订';
    html+='</button>';
    html+='<button onclick="openKPIBossEval()">⭐ 上级评价</button>';
    if(_kpiCurrentData&&_kpiCurrentData.bossComment){
      html+='<div class="kpi-summary" style="margin-top:8px;padding:10px 14px;border-left:3px solid var(--primary);background:#F0F7FF">';
      html+='<strong>上级评价</strong>（'+_h(_kpiCurrentData.bossEvalBy||'')+'，'+_h((_kpiCurrentData.bossEvalAt||'').substring(0,10))+'）：<br>'+_h(_kpiCurrentData.bossComment);
      html+='</div>';
    }
    html+='</div>';
  }else{
    // 自己查看自己的KPI：显示查看上级评价按钮（只读）
    if(_kpiCurrentData&&_kpiCurrentData.bossComment){
      html+='<div class="kpi-submit-bar" style="margin-top:12px">';
      html+='<button onclick="viewKPIBossEval()"><span style="color:#2A476A">📋</span> 查看上级评价</button>';
      html+='</div>';
      html+='<div class="kpi-summary" style="margin-top:8px;padding:10px 14px;border-left:3px solid var(--primary);background:#F0F7FF">';
      html+='<strong>上级评价</strong>（'+_h(_kpiCurrentData.bossEvalBy||'')+'，'+_h((_kpiCurrentData.bossEvalAt||'').substring(0,10))+'）：<br>'+_h(_kpiCurrentData.bossComment);
      html+='</div>';
    }
  }

  container.innerHTML=html;
}

function renderProjectKPI(container){
  container.innerHTML='<div class="kpi-empty"><div class="kpi-empty-icon">🔧</div><div class="kpi-empty-title">项目管理 KPI</div><div class="kpi-empty-desc">此模版暂未完整定义。建议按中层模版结构复用，关键差异点：考核周期为月度(M1~M12)，KPI指标侧重项目里程碑达成率/预算控制/交付质量，KPA侧重风险管控/跨部门协作</div></div>';
}

// ===== KPI 模版数据（从 Excel 模版提取） =====
function getSeniorKPIData(){
  return [
    {category:'财务类',indicator:'综合人力成本控制\n（年度工资性支出/销售收入，不含员工福利性支出）',lastYearTarget:'ND',lastYearActual:'0.2428',weight:0.1,standard:'≤29.56%',rule:'每超1%扣2分，扣完权重分为止',evaluator:'财务'},
    {category:'客户类',indicator:'人才招聘按时到岗比率',lastYearTarget:'0.8',lastYearActual:'0.769',weight:0.15,standard:'≥85%',rule:'≥85%得权重分，超出或低于均按比例+/-分',evaluator:'自证'},
    {category:'运营类',indicator:'综合人均效益\n（人均销售额，含一线工人）',lastYearTarget:'ND',lastYearActual:'50.21万元',weight:0.15,standard:'≥54.55万元（1.2亿/年均220人）',rule:'达到目标得权重分，超出或低于均按比例+/-分',evaluator:'财务'},
    {category:'运营类',indicator:'优秀人才比例',lastYearTarget:'ND',lastYearActual:'ND',weight:0.1,standard:'≥10%（绩效"+2、+1"级员工人数占总人数比例）',rule:'每低1%扣1分，每超1%加1分',evaluator:'自证'},
    {category:'学习发展类',indicator:'培训计划按时达成率',lastYearTarget:'1',lastYearActual:'ND',weight:0.1,standard:'1',rule:'每少1门计划课程扣0.5分',evaluator:'质量部'}
  ];
}

function getSeniorKPAData(){
  return [
    {name:'组织建设',desc:'完善各部门组织架构和岗位职责',deadline:'各季度',weight:0.1,milestone:'一季度完成各部门组织架构梳理；岗位职责梳理工作，输出相关文件',rule:'上级根据完成时效和完成质量综合评分',evaluator:'--'},
    {name:'人才培养',desc:'围绕销售和利润及客户满意度，培养提升内部价值链各关键环节人员的能力素质',deadline:'各季度',weight:0.1,milestone:'1-2季度确定重点发展人才，各中心第二梯队至少1人符合进入条件',rule:'达标得权重分；低于目标每少1人扣1分',evaluator:'--'},
    {name:'质量目标',desc:'确保人力资源管理100%符合相应质量目标要求',deadline:'各季度',weight:0.1,milestone:'持续完成人力资源基础管理，确保内外部审核无"不合格项"',rule:'每出现一项不合格项扣2分',evaluator:'--'},
    {name:'绩效管理',desc:'完善绩效管理体系，建立各层级以成果为导向的优胜劣汰',deadline:'各季度',weight:0.1,milestone:'一季度内完成绩效方案、目标制定并完成第一次绩效评估',rule:'上级根据完成时效和完成质量综合评分',evaluator:'--'}
  ];
}

function getMiddleRespData(){
  return [
    {duty:'（分配的岗位）招聘及时到位率',standard:'对照招聘制度约定的各岗位招聘最长时限',qualifiedLine:'0.8',scoreRule:'合格≥80%；70%≥有差距＜80%；偏离目标＜70%'},
    {duty:'绩效数据跟踪及时性',standard:'及时跟踪绩效数据，按时完成数据跟踪',qualifiedLine:'1',scoreRule:'无遗漏为合格；出现严重延误或差错均为偏离目标'},
    {duty:'薪酬福利核算按时及准确率',standard:'全年薪酬管理核发无人为因素延误，同时无差错',qualifiedLine:'0',scoreRule:'合格为0误差0延迟，出现1次延误或误差即为偏离目标'},
    {duty:'团队活动参与组织工作',standard:'员工生日会等团队活动组织策划和实施工作',qualifiedLine:'无明显失误',scoreRule:'上级随机检查，不符合要求酌情扣分'},
    {duty:'人事档案管理',standard:'人事档案管理符合规范要求：完整、整齐、文件无缺失、摆放整齐、安全',qualifiedLine:'符合要求',scoreRule:'出现人事档案遗失扣3分/例'}
  ];
}

function getMiddleTaskData(){
  return [
    {name:'SOP编制及执行',standard:'按要求分步按时编写岗位工作相关的关键作业SOP',scoreRule:'显著优于+(3~4)/略优于+(0.5~2)/符合0/略有差距-(0.5~2)/严重偏离-(3~4)'},
    {name:'基础人事数据统计分析模型建立',standard:'按要求每月按时提交相关人事数据统计及分析报告',scoreRule:'准确、及时、附带一定的分析建议'},
    {name:'其他上级安排的工作',standard:'按时高质量完成',scoreRule:'由上级根据具体完成情况综合评价'}
  ];
}

