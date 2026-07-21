// ===== HWM HR - 系统维护模块 (System Maintenance) =====
// V0.5.77: 从 app.html 独立提取
//
// 依赖: config.js, 主程序 (USERS, currentUser, supabase, HWM_MODULES)
// 导出: sysInitModule(), sysRenderUserTable(), sysCloseModal()
//
// =============================================

var _sysEditingUid=null;
var _sysEditingSubs={};

function sysInitModule(){
  console.log('HWM: sysInitModule called, currentUser:',currentUser?currentUser.name:'null','USERS keys:',typeof USERS==='undefined'?'UNDEFINED':Object.keys(USERS).length);
  // ★ 防御：如果 USERS 未初始化或为空，强制重新加载
  if(typeof USERS==='undefined'||!USERS||Object.keys(USERS).length===0){
    console.warn('HWM: USERS is empty/undefined, re-initializing...');
    try{USERS=loadUserSettings();}catch(e){console.error('HWM: USERS reinit failed',e);}
    if(!USERS||Object.keys(USERS).length===0){
      // 最终兜底：直接从 _DEFAULT_USERS 拷贝
      USERS=JSON.parse(JSON.stringify(_DEFAULT_USERS));
      console.log('HWM: USERS fallback to _DEFAULT_USERS, keys:',Object.keys(USERS).length);
    }
  }
  var el=document.getElementById('sysHeaderUser');
  if(el&&currentUser)el.textContent='当前管理员：'+currentUser.name;
  sysRenderUserTable();
  // ★ V0.6.1.j49: 初始化邮件通知开关按钮状态
  _initEmailToggleStatus();
}

function sysRenderUserTable(){
  var tbody=document.getElementById('sysUserTableBody');
  if(!tbody){console.warn('HWM: sysUserTableBody not found');return;}
  var uids=Object.keys(USERS);
  // ★ V0.6.1eo: 应用筛选
  uids=applySysFilterToUids(uids);
  console.log('HWM: sysRenderUserTable rendering',uids.length,'users (filtered)');
  var countEl=document.getElementById('sysUserCount');
  if(countEl)countEl.textContent=Object.keys(USERS).length;
  var filterCountEl=document.getElementById('sysFilterCount');
  if(filterCountEl)filterCountEl.textContent=uids.length;
  // ★ 空数据兜底显示
  if(uids.length===0){
    tbody.innerHTML='<tr><td colspan="21" style="padding:40px 20px;color:var(--text-hint);font-size:13px;text-align:center">没有匹配的用户</td></tr>';
    return;
  }
  var html='';
  for(var i=0;i<uids.length;i++){
    var uid=uids[i],u=USERS[uid];
    var perms=u.permissions||_defaultPerms(u.role);
    // ★ V0.6.1et: 从花名册自动获取中心/部门
    var rosterCenter=u.dept||getRosterCenterForName(u.name)||'';
    var rosterDept=u.dept||getRosterDeptForName(u.name)||'';
    html+='<tr>';
    html+='<td class="sys-col-center" style="font-size:12px;color:var(--text-secondary);text-align:left;white-space:nowrap">'+_h(rosterCenter||'-')+'</td>';
    html+='<td class="sys-col-dept" style="font-size:12px;color:var(--text-secondary);text-align:left;white-space:nowrap">'+_h(rosterDept||'-')+'</td>';
    html+='<td class="sys-col-name sys-td-left"><strong>'+_h(u.name)+'</strong></td>';
    html+='<td class="sys-col-position sys-td-left" style="font-size:12px;color:var(--text-secondary)">'+_h(u.position)+'</td>';
    html+='<td class="sys-col-uid" style="font-family:monospace;font-size:12px">'+_h(uid)+'</td>';
    html+='<td class="sys-col-action" style="width:70px"><button class="sys-action-btn" onclick="sysOpenEditUser(\''+uid+'\')">编辑</button></td>';
    // 下属列
    var subs=u.subordinates||{};
    var subCount=Object.keys(subs).length;
    var subLabel='—';
    if(subCount>0){
      var dC=0,iC=0;
      for(var sk in subs){if(subs[sk]==='direct')dC++;else iC++;}
      subLabel='<span style="font-size:11px">'+dC+'直/'+iC+'间</span>';
    }
    html+='<td class="sys-col-sub" style="text-align:center">'+subLabel+'</td>';
    for(var j=0;j<HWM_MODULES.length;j++){
      var mod=HWM_MODULES[j],on=!!perms[mod];
      var cellCls=(typeof HWM_LIVE_MODULES!=='undefined'&&!HWM_LIVE_MODULES[mod])?'sys-perm-offline':'';
      html+='<td class="'+cellCls+'"><span class="sys-perm-toggle '+(on?'sys-perm-yes':'sys-perm-no')+'" onclick="sysTogglePerm(\''+uid+'\',\''+mod+'\')" title="'+(cellCls?'该模块尚未上线':(on?'已授权':'未授权'))+'">'+(on?'✓':'—')+'</span></td>';
    }
    html+='</tr>';
  }
  tbody.innerHTML=html;
  // ★ V0.6.1.gi: 渲染后立即 + 100ms 再算一次（确保 DOM 完全渲染）
  _recalcSysFixedColumns();
  setTimeout(_recalcSysFixedColumns,100);
}

// 测量并应用固定列的 left 值（实际宽度更可靠）
function _recalcSysFixedColumns(){
  var table=document.getElementById('sysUserTable');
  if(!table)return;
  var ths=table.querySelectorAll('thead th');
  if(ths.length<7)return;
  var fixedClasses=['sys-col-center','sys-col-dept','sys-col-name','sys-col-position','sys-col-uid','sys-col-action','sys-col-sub'];
  // ★ V0.6.1.gi: 用 th 的 offsetWidth（th 不会被内容撑大）作为 left 计算基准
  var cumulative=0;
  for(var i=0;i<7;i++){
    var cls=fixedClasses[i];
    var w=80;
    for(var h=0;h<ths.length;h++){
      if(ths[h].classList.contains(cls)){w=ths[h].offsetWidth;break;}
    }
    // 同步表头
    var ths2=table.querySelectorAll('thead th.'+cls);
    for(var k=0;k<ths2.length;k++)ths2[k].style.left=cumulative+'px';
    // 同步所有 tbody td
    var allTds=table.querySelectorAll('tbody td.'+cls);
    for(var t=0;t<allTds.length;t++)allTds[t].style.left=cumulative+'px';
    cumulative+=w;
  }
}

function sysTogglePerm(uid,mod){
  var u=USERS[uid];
  if(!u||!u.permissions)return;
  u.permissions[mod]=!u.permissions[mod];
  saveUserSettings();
  if(currentUser&&currentUser._uid===uid&&mod==='maintenance'&&!u.permissions[mod]){
    _showAlert('⚠️ 您已关闭自己的系统维护权限，保存后将无法再进入此模块。');
  }
  sysRenderUserTable();
}

// ===== 姓名自动搜索 + 联动填入 =====
var _sysNameMatches=[];
var _sysNameSelIdx=-1;

function sysNameAutocomplete(input){
  var val=input.value.trim();
  var dd=document.getElementById('sysNameDropdown');
  if(!val){dd.style.display='none';_sysNameMatches=[];return;}
  var emps=(typeof allEmployees!=='undefined'&&allEmployees&&allEmployees.length>0)?allEmployees:(window.__PRELOADED_EMPLOYEES__||[]);
  var matches=[];
  var seen={};
  for(var i=0;i<emps.length&&matches.length<20;i++){
    var e=emps[i];
    if(!e.name)continue;
    if(typeof isActive==='function'&&!isActive(e))continue;
    if(e.name.indexOf(val)>=0&&!seen[e.name]){
      seen[e.name]=1;
      matches.push(e);
    }
  }
  _sysNameMatches=matches;
  _sysNameSelIdx=-1;
  if(matches.length===0){dd.style.display='none';return;}
  var html='';
  for(var i=0;i<matches.length;i++){
    var m=matches[i];
    html+='<div onmousedown="event.preventDefault();sysSelectName('+i+')" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'#fff\'">';
    html+='<strong>'+_h(m.name)+'</strong>';
    if(m.dept)html+=' <span style="color:var(--text-hint);font-size:12px">'+_h(m.dept)+'</span>';
    if(m.position)html+=' <span style="color:var(--text-hint);font-size:12px">'+_h(m.position)+'</span>';
    html+='</div>';
  }
  dd.innerHTML=html;
  dd.style.display='block';
}

function sysNameKeydown(e){
  var dd=document.getElementById('sysNameDropdown');
  if(dd.style.display==='none'||_sysNameMatches.length===0)return;
  if(e.key==='ArrowDown'){
    e.preventDefault();
    _sysNameSelIdx=Math.min(_sysNameSelIdx+1,_sysNameMatches.length-1);
    sysHighlightNameItem();
  }else if(e.key==='ArrowUp'){
    e.preventDefault();
    _sysNameSelIdx=Math.max(_sysNameSelIdx-1,0);
    sysHighlightNameItem();
  }else if(e.key==='Enter'){
    e.preventDefault();
    if(_sysNameSelIdx>=0)sysSelectName(_sysNameSelIdx);
    else if(_sysNameMatches.length===1)sysSelectName(0);
  }else if(e.key==='Escape'){
    dd.style.display='none';
  }
}

function sysHighlightNameItem(){
  var dd=document.getElementById('sysNameDropdown');
  var items=dd.children;
  for(var i=0;i<items.length;i++){
    items[i].style.background = (i===_sysNameSelIdx)?'#e6f0ff':'#fff';
  }
  if(_sysNameSelIdx>=0&&items[_sysNameSelIdx]){
    items[_sysNameSelIdx].scrollIntoView({block:'nearest'});
  }
}

function sysSelectName(idx){
  var m=_sysNameMatches[idx];
  if(!m)return;
  document.getElementById('sysFormName').value=m.name||'';
  var posEl=document.getElementById('sysFormPosition');
  var deptEl=document.getElementById('sysFormDept');
  if(m.position){
    posEl.value=m.position;
    posEl.readOnly=true;
    posEl.style.background='#f5f5f5';
    posEl.style.color='var(--text-hint)';
  }
  if(m.dept){
    deptEl.value=m.dept;
    deptEl.readOnly=true;
    deptEl.style.background='#f5f5f5';
    deptEl.style.color='var(--text-hint)';
  }
  document.getElementById('sysNameDropdown').style.display='none';
  // 自动联动登录用户名：始终用真实中文姓名作为登录用户名
  var uidEl=document.getElementById('sysFormUid');
  if(uidEl&&!uidEl.disabled){
    uidEl.value=m.name||'';
    uidEl.focus();
  }
}

function sysCloseNameDropdown(){
  setTimeout(function(){
    var dd=document.getElementById('sysNameDropdown');
    if(dd)dd.style.display='none';
  },150);
}

function sysResetNameFields(){
  var posEl=document.getElementById('sysFormPosition');
  var deptEl=document.getElementById('sysFormDept');
  posEl.readOnly=false;
  posEl.style.background='';
  posEl.style.color='';
  deptEl.readOnly=false;
  deptEl.style.background='';
  deptEl.style.color='';
}

function sysOpenAddUser(){
  try{
    _sysEditingUid=null;
    sysResetNameFields();
    document.getElementById('sysModalTitle').textContent='新增用户';
    document.getElementById('sysEditUid').value='';
    document.getElementById('sysFormName').value='';
    document.getElementById('sysFormPosition').value='';
    document.getElementById('sysFormUid').value='';
    document.getElementById('sysFormUid').disabled=false;
    document.getElementById('sysFormPwd').value='';
    document.getElementById('sysFormDept').value='';
    document.getElementById('sysFormRole').value='';
    document.getElementById('sysDeleteUserBtn').style.display='none';
    sysBuildPermGrid({mbo:true}); // ★ V0.6.1fl: 新用户默认仅开通「当周行动」
    document.getElementById('sysUserModal').style.display='flex';
  }catch(e){
    console.error('HWM: sysOpenAddUser error:',e);
    _showAlert('打开新增用户失败：'+e.message);
  }
}

function sysOpenEditUser(uid){
  try{
    _sysEditingUid=uid;
    sysResetNameFields();
    var u=USERS[uid];
    if(!u){console.warn('HWM: sysOpenEditUser - user not found:',uid);return;}
    document.getElementById('sysModalTitle').textContent='编辑用户 — '+u.name;
    document.getElementById('sysEditUid').value=uid;
    document.getElementById('sysFormName').value=u.name||'';
    document.getElementById('sysFormPosition').value=u.position||'';
    document.getElementById('sysFormUid').value=uid;
    // 编辑模式下也允许修改登录用户名（方便改名为真实姓名）
    document.getElementById('sysFormUid').disabled=false;
    document.getElementById('sysFormPwd').value=u.pwd||'';
    document.getElementById('sysFormDept').value=u.dept||'';
    document.getElementById('sysFormRole').value=u.role||'';
    document.getElementById('sysDeleteUserBtn').style.display='inline-block';
    sysBuildPermGrid(u.permissions||{});
    // 更新下属信息提示
    var info=document.getElementById('sysSubInfo');
    var subs=u.subordinates||{};
    var dC=0,iC=0;
    var subNames=Object.keys(subs).sort();
    for(var sk=0;sk<subNames.length;sk++){if(subs[subNames[sk]]==='direct')dC++;else iC++;}
    if(info) info.textContent=(dC+iC)>0?(dC+' 直属 / '+iC+' 间接'):'—';
    // 更新下属预览列表
    var preview=document.getElementById('sysSubPreview');
    if(preview){
      if(subNames.length===0){
        preview.innerHTML='<span style="color:#aaa">暂无下属</span>';
      }else{
        var phtml='';
        for(var si=0;si<subNames.length;si++){
          var sn=subNames[si],sr=subs[sn];
          var badge=sr==='direct'?'<span style="display:inline-block;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:4px">直属</span>':'<span style="display:inline-block;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:4px">间接</span>';
          phtml+='<span style="display:inline-block;background:#f1f5f9;padding:2px 8px;border-radius:4px;margin:2px 4px 2px 0">'+_h(sn)+badge+'</span>';
        }
        preview.innerHTML=phtml;
      }
    }
    var modal=document.getElementById('sysUserModal');
    if(modal){
      console.log('HWM: showing sysUserModal for',uid,'parent:',modal.parentElement?.id||'body');
      modal.style.display='flex';
    }
  }catch(e){
    console.error('HWM: sysOpenEditUser error:',e);
    _showAlert('编辑用户失败：'+e.message);
  }
}

function sysBuildPermGrid(perms){
  var grid=document.getElementById('sysPermGrid');
  if(!grid)return;
  var html='';
  for(var i=0;i<HWM_MODULES.length;i++){
    var mod=HWM_MODULES[i],on=perms[mod]===true; // ★ V0.6.1fm: 显式 true 才算开启（修复未定义字段也变 ✓ 的 BUG）
    html+='<div class="sys-perm-item '+(on?'on':'off')+'" onclick="sysFlipPermItem(this,\''+mod+'\')" data-mod="'+mod+'">';
    html+='<span class="sys-perm-icon">'+(on?'✓':'✕')+'</span>';
    html+='<span class="sys-perm-label">'+HWM_MODULE_LABELS[mod]+'</span>';
    html+='</div>';
  }
  grid.innerHTML=html;
}

function sysFlipPermItem(el,mod){
  el.classList.toggle('on');el.classList.toggle('off');
  var icon=el.querySelector('.sys-perm-icon');
  icon.textContent=el.classList.contains('on')?'✓':'✕';
}

function sysSaveUser(){
  var uid=document.getElementById('sysFormUid').value.trim();
  var name=document.getElementById('sysFormName').value.trim();
  var position=document.getElementById('sysFormPosition').value.trim();
  var pwd=document.getElementById('sysFormPwd').value.trim();
  var dept=document.getElementById('sysFormDept').value.trim();
  var role=document.getElementById('sysFormRole').value;
  if(!uid){_showAlert('请输入登录用户名');return;}
  if(!name){_showAlert('请输入姓名');return;}
  if(!position){_showAlert('请输入职务');return;}
  if(!pwd){_showAlert('请输入登录密码');return;}
  if(!_sysEditingUid&&USERS[uid]){_showAlert('用户名 "'+uid+'" 已存在，请换一个');return;}
  if(_sysEditingUid&&_sysEditingUid!==uid){
    if(USERS[uid]){_showAlert('用户名 "'+uid+'" 已存在');return;}
    delete USERS[_sysEditingUid];
  }
  var items=document.querySelectorAll('#sysPermGrid .sys-perm-item');
  var perms={};
  for(var i=0;i<items.length;i++){perms[items[i].dataset.mod]=items[i].classList.contains('on');}
  var oldU=USERS[uid]||{};
  USERS[uid]={pwd:pwd,name:name,role:role||oldU.role||'staff',dept:dept,position:position,centerKeyword:oldU.centerKeyword||'',permissions:perms,reports:oldU.reports||_defaultReports(),subordinates:oldU.subordinates||_sysEditingSubs||{}};
  saveUserSettings();
  sysCloseModal();
  sysRenderUserTable();
  if(currentUser&&(_sysEditingUid===currentUser._uid||(!_sysEditingUid&&uid===currentUser._uid))){
    currentUser.name=name;currentUser.position=position;currentUser.dept=dept||'';
  }
}

async function sysDeleteUser(){
  if(!_sysEditingUid)return;
  var uName=USERS[_sysEditingUid]?.name||_sysEditingUid;
  var ok=await _showConfirm('⚠️ 确定要删除用户「'+uName+'」吗？此操作不可恢复！<br><br>Are you sure you want to delete user "'+uName+'"? This action cannot be undone.');
  if(!ok)return;
  var deletedUid=_sysEditingUid;
  delete USERS[deletedUid];
  saveUserSettings();
  // ★ 同步从 Supabase 删除该用户（防止其他设备拉取到已删除的用户）
  (async function(){
    try{
      var resp=await supabase.from(SUPABASE_USERS_TABLE).delete().eq('uid',deletedUid);
      if(resp.error)console.warn('HWM: Cloud delete user failed',resp.error.message);
      else console.log('HWM: User deleted from cloud:',deletedUid);
    }catch(e){console.warn('HWM: Cloud delete user error',e.message);}
  })();
  sysCloseModal();
  sysRenderUserTable();
}

// ===== 下属管理面板 =====
function sysOpenSubPanel(){
  if(!_sysEditingUid)return;
  var u=USERS[_sysEditingUid];
  if(!u)return;
  // 确保 sysSubPanel 在 body 顶层（防止因 HTML 解析错误被放入 appView 导致 position:fixed 失效）
  var panel=document.getElementById('sysSubPanel');
  if(panel.parentElement!==document.body){
    document.body.appendChild(panel);
  }
  document.getElementById('sysSubPanelTitle').textContent='设置下属 — '+u.name;
  _sysEditingSubs=JSON.parse(JSON.stringify(u.subordinates||{}));
  // 填充部门下拉
  var deptSel=document.getElementById('sysSubDeptFilter');
  var depts=sysGetAllDepts();
  deptSel.innerHTML='<option value="">全部部门</option>';
  for(var i=0;i<depts.length;i++){
    deptSel.innerHTML+='<option value="'+_h(depts[i])+'">'+_h(depts[i])+'</option>';
  }
  deptSel.value='';
  document.getElementById('sysSubSearch').value='';
  sysRenderSubList();
  document.getElementById('sysSubPanel').style.setProperty('display','flex','important');
}

function sysCloseSubPanel(){
  document.getElementById('sysSubPanel').style.display='none';
  _sysEditingSubs={};
}

function sysGetAllDepts(){
  var depts={};
  var emps=window.__PRELOADED_EMPLOYEES__;
  if(emps){for(var i=0;i<emps.length;i++){if(emps[i].dept)depts[emps[i].dept]=1;}}
  // 也加入 USERS 中的部门
  for(var k in USERS){if(USERS.hasOwnProperty(k)&&USERS[k].dept)depts[USERS[k].dept]=1;}
  return Object.keys(depts).sort();
}

function sysGetFilteredEmps(){
  var dept=document.getElementById('sysSubDeptFilter').value;
  var search=(document.getElementById('sysSubSearch').value||'').toLowerCase();
  var emps=(typeof allEmployees!=='undefined'&&allEmployees&&allEmployees.length>0)?allEmployees:(window.__PRELOADED_EMPLOYEES__||[]);
  var result=[];
  var seen={};
  // 先加员工档案中的
  for(var i=0;i<emps.length;i++){
    var e=emps[i];
    if(!e.name||!isActive(e))continue;
    if(dept&&e.dept!==dept)continue;
    if(search&&e.name.toLowerCase().indexOf(search)<0)continue;
    seen[e.name]=1;
    result.push({name:e.name,dept:e.dept,position:e.position});
  }
  // 再加 USERS 中有但不在员工档案中的
  for(var k in USERS){
    if(!USERS.hasOwnProperty(k))continue;
    var u=USERS[k];
    if(!u.name||seen[u.name])continue;
    if(dept&&u.dept!==dept)continue;
    if(search&&u.name.toLowerCase().indexOf(search)<0)continue;
    result.push({name:u.name,dept:u.dept,position:u.position});
  }
  return result;
}

function sysRenderSubList(){
  var emps=sysGetFilteredEmps();
  var u=USERS[_sysEditingUid];
  var myName=u?u.name:'';
  var html='<div style="min-width:100%"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#F7F8FA;border-bottom:2px solid var(--border)">';
  html+='<th style="padding:10px 12px;text-align:left;font-weight:600">姓名</th>';
  html+='<th style="padding:10px 12px;text-align:left;font-weight:600">部门</th>';
  html+='<th style="padding:10px 12px;text-align:left;font-weight:600">职务</th>';
  html+='<th style="padding:10px 12px;text-align:center;font-weight:600;width:100px">关系</th>';
  // ★ V0.5.79b: WP可见性
  html+='<th style="padding:10px 12px;text-align:center;font-weight:600;font-size:11px">📖 可看我的<br>周计划</th>';
  html+='</tr></thead><tbody>';
  var direct=0,indirect=0;
  // ★ 加载该用户的可见性
  var visKey='hwm_wp_visibility_'+_sysEditingUid;
  var visRaw=localStorage.getItem(visKey);
  var visData=visRaw?JSON.parse(visRaw):{};
  var sharedTo=visData.sharedTo||[];
  for(var i=0;i<emps.length;i++){
    var e=emps[i];
    if(e.name===myName)continue;
    var rel=_sysEditingSubs[e.name]||'none';
    if(rel==='direct')direct++;else if(rel==='indirect')indirect++;
    var bg=i%2?'#FAFBFC':'white';
    var wpShared=sharedTo.indexOf(e.name)>=0;
    html+='<tr style="background:'+bg+';border-bottom:1px solid var(--border-light, #eee)">';
    html+='<td style="padding:8px 12px;font-weight:500">'+_h(e.name)+'</td>';
    html+='<td style="padding:8px 12px;color:#797973">'+_h(e.dept)+'</td>';
    html+='<td style="padding:8px 12px;color:#797973">'+_h(e.position)+'</td>';
    // ★ V0.6.1.ha: 用彩色 emoji 替代 "●" (Mac Chrome 下拉框忽略option颜色,emoji走OS彩色)
    var selColor=rel==='direct'?'#16A34A':(rel==='indirect'?'#3B82F6':'#6B7280');
    var selWeight=rel==='none'?'normal':'600';
    html+='<td style="padding:6px 12px;text-align:center"><select onchange="sysToggleSubRel(\''+_h(e.name)+'\',this.value)" style="font-size:13px;padding:4px 8px;border-radius:4px;border:1px solid var(--border);cursor:pointer;color:'+selColor+';font-weight:'+selWeight+'">';
    html+='<option value="none"'+(rel==='none'?' selected':'')+'>⚪ 无</option>';
    html+='<option value="direct"'+(rel==='direct'?' selected':'')+'>🟢 直属</option>';
    html+='<option value="indirect"'+(rel==='indirect'?' selected':'')+'>🔵 间接</option>';
    html+='</select></td>';
    // WP可见性复选框
    html+='<td style="padding:8px 12px;text-align:center"><input type="checkbox" '+(wpShared?'checked':'')+' onchange="sysToggleWPShared(\''+_h(e.name)+'\',this.checked)" style="cursor:pointer;accent-color:#3B7DB4;width:16px;height:16px"></td>';
    html+='</tr>';
  }
  if(emps.length===0)html+='<tr><td colspan="4" style="padding:30px;text-align:center;color:#797973">无匹配员工</td></tr>';
  html+='</tbody></table></div>';
  document.getElementById('sysSubList').innerHTML=html;
  document.getElementById('sysSubStats').textContent='共 '+emps.length+' 人 | 直属 '+direct+' | 间接 '+indirect;
}

function sysToggleSubRel(name,rel){
  if(rel==='none')delete _sysEditingSubs[name];
  else _sysEditingSubs[name]=rel;
  sysRenderSubList();
}

// ★ V0.5.79b: 切换WP周计划可见性
function sysToggleWPShared(name,checked){
  var key='hwm_wp_visibility_'+_sysEditingUid;
  var raw=localStorage.getItem(key);
  var data=raw?JSON.parse(raw):{};
  if(!data.sharedTo)data.sharedTo=[];
  var idx=data.sharedTo.indexOf(name);
  if(checked&&idx<0)data.sharedTo.push(name);
  else if(!checked&&idx>=0)data.sharedTo.splice(idx,1);
  localStorage.setItem(key,JSON.stringify(data));
}

function sysSaveSubs(){
  if(!_sysEditingUid)return;
  var u=USERS[_sysEditingUid];
  if(!u)return;
  u.subordinates=_sysEditingSubs;
  saveUserSettings();
  // 更新信息提示 + 预览列表
  var info=document.getElementById('sysSubInfo');
  var direct=0,indirect=0;
  var subNames=Object.keys(_sysEditingSubs).sort();
  for(var k=0;k<subNames.length;k++){if(_sysEditingSubs[subNames[k]]==='direct')direct++;else indirect++;}
  if(info) info.textContent=direct+' 直属 / '+indirect+' 间接';
  var preview=document.getElementById('sysSubPreview');
  if(preview){
    if(subNames.length===0){
      preview.innerHTML='<span style="color:#aaa">暂无下属</span>';
    }else{
      var phtml='';
      for(var si=0;si<subNames.length;si++){
        var sn=subNames[si],sr=_sysEditingSubs[sn];
        var badge=sr==='direct'?'<span style="display:inline-block;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:4px">直属</span>':'<span style="display:inline-block;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:4px">间接</span>';
        phtml+='<span style="display:inline-block;background:#f1f5f9;padding:2px 8px;border-radius:4px;margin:2px 4px 2px 0">'+_h(sn)+badge+'</span>';
      }
      preview.innerHTML=phtml;
    }
  }
  sysCloseSubPanel();
  sysRenderUserTable();
  _showAlert('下属关系已保存！');
}

// 获取某用户的所有下属姓名列表（用于 MBO/KPI）
function getSubordinates(uid){
  if(!uid)return [];
  var u=USERS[uid];
  if(!u||!u.subordinates)return [];
  if(Array.isArray(u.subordinates)) return u.subordinates;
  return Object.keys(u.subordinates);
}

// 获取某用户的下属详情（含关系类型）
function getSubordinatesDetail(uid){
  if(!uid)return {};
  var u=USERS[uid];
  if(!u||!u.subordinates)return {};
  if(Array.isArray(u.subordinates)){
    var obj={};
    for(var i=0;i<u.subordinates.length;i++) obj[u.subordinates[i]]='direct';
    return obj;
  }
  return JSON.parse(JSON.stringify(u.subordinates));
}

function sysCloseModal(){
  document.getElementById('sysUserModal').style.display='none';
  _sysEditingUid=null;
}

// ★ V0.6.1ex: 同步花名册 — 两阶段预览确认，透明安全
// 阶段1：扫描花名册 → 过滤蓝领/离职 → 对比差异 → 展示预览
// 阶段2：用户确认后才执行新增/删除
function sysRosterSync(){
  var emps=(typeof allEmployees!=='undefined'&&allEmployees)?allEmployees:[];
  if(emps.length===0){_showAlert('暂无团队人才数据，请先到"人才团队"导入花名册','提示');return;}
  var skips=(typeof SKIP_POSITIONS!=='undefined'&&SKIP_POSITIONS)?SKIP_POSITIONS:[];
  var skipStatus=(typeof SKIP_STATUS!=='undefined'&&SKIP_STATUS)?SKIP_STATUS:[];
  var activeStatus=(typeof ACTIVE_STATUS!=='undefined'&&ACTIVE_STATUS)?ACTIVE_STATUS:[];
  var toAdd=[];
  var toRemove=[];
  var skipped=[];   // 工人/检验员（不导入）
  var rosterNames={}; // 花名册中所有在职白领
  var userCount=Object.keys(USERS).length;

  for(var i=0;i<emps.length;i++){
    var e=emps[i];if(!e||!e.name)continue;
    var pos=(e.position||'').trim();
    var status=(e.status||'').trim();
    // 状态过滤：已离职 → 记录到清理列表（如果 USERS 中有同名用户）
    var isResigned=false;
    for(var rs=0;rs<skipStatus.length;rs++){if(status===skipStatus[rs]||status.indexOf(skipStatus[rs])>=0){isResigned=true;break;}}
    if(isResigned){
      if(USERS[e.name])toRemove.push(e.name);
      continue;
    }
    // 状态必须是白名单才走后续逻辑
    if(activeStatus.length>0){
      var isActive=false;
      for(var as=0;as<activeStatus.length;as++){if(status===activeStatus[as]){isActive=true;break;}}
      if(!isActive){skipped.push(e);continue;}
    }
    // 职位过滤 — 工人/检验员等不导入
    var isSkipped=false;
    for(var s=0;s<skips.length;s++){if(pos.indexOf(skips[s])>=0){isSkipped=true;break;}}
    if(isSkipped){skipped.push(e);continue;}
    // 在职白领：记录名字
    rosterNames[e.name]=true;
    if(!USERS[e.name])toAdd.push(e);
  }

  // ★ 关键安全设计：只清理"花名册中标记为离职"的用户，不碰其他任何 USERS
  // 管理员手动添加的用户、不在花名册中的用户，统统保留

  if(toAdd.length===0&&toRemove.length===0){
    _showAlert('系统用户已与花名册在职白领完全一致，无需操作','✅ 同步花名册');
    return;
  }

  // ★ 安全阈值：新增过多时强制确认
  if(toAdd.length>30){
    _showConfirm('⚠️ 本次将新增 '+toAdd.length+' 个用户（超过30人安全阈值）\n\n花名册在职白领 '+(Object.keys(rosterNames).length)+' 人，现有用户 '+userCount+' 人\n\n是否继续？','新增安全确认').then(function(ok){
      if(!ok)return;
      showRosterSyncDialog(toAdd,toRemove,skipped,emps.length,userCount);
    });
    return;
  }

  showRosterSyncDialog(toAdd,toRemove,skipped,emps.length,userCount);
}

function showRosterSyncDialog(toAdd,toRemove,skipped,empTotal,userTotal){
  var unchanged=userTotal-toRemove.length;
  var html='<div class="_confirm-card" style="max-width:580px">';
  html+='<div class="_confirm-title" style="padding:18px 24px 12px">📋 同步花名册</div>';
  html+='<div class="_confirm-body" style="padding:0 24px 12px;line-height:1.6">';
  html+='<div style="font-size:12px;color:#6b7280;margin-bottom:12px">花名册 '+empTotal+' 人（不含蓝领）→ 现有 '+userTotal+' 个系统用户</div>';

  // 新增
  if(toAdd.length>0){
    html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="color:#2563EB;font-size:16px">➕</span><strong style="color:#2563EB">新增 '+toAdd.length+' 人</strong><span style="color:#9ca3af;font-size:11px">（默认关闭全部模块权限）</span></div>';
    html+='<div style="background:#eff6ff;border-radius:6px;padding:6px 10px;margin-bottom:10px;max-height:140px;overflow-y:auto">';
    for(var a=0;a<toAdd.length;a++){
      var ae=toAdd[a];
      html+='<div style="font-size:12px;padding:2px 0"><strong>'+esc(ae.name)+'</strong>';
      if(ae.dept)html+=' <span style="color:#6b7280">'+esc(ae.dept)+'</span>';
      if(ae.position)html+=' <span style="color:#9ca3af">· '+esc(ae.position)+'</span>';
      html+='</div>';
    }
    html+='</div>';
  }

  // 离职清理
  if(toRemove.length>0){
    html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="color:#D64352;font-size:16px">🗑</span><strong style="color:#D64352">离职清理 '+toRemove.length+' 人</strong></div>';
    html+='<div style="background:#fef2f2;border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:12px">';
    for(var r=0;r<toRemove.length;r++){html+=esc(toRemove[r])+(r<toRemove.length-1?'、':'');}
    html+='</div>';
  }

  // 不变
  html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="color:#6b7280;font-size:14px">✓</span><strong style="color:#6b7280">不变 '+unchanged+' 人</strong></div>';

  // 已过滤
  if(skipped.length>0){
    html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;margin-top:8px"><span style="color:#9ca3af;font-size:14px">⏭</span><strong style="color:#9ca3af">已过滤 '+skipped.length+' 人</strong><span style="color:#9ca3af;font-size:11px">（工人/检验员/非在职状态）</span></div>';
  }

  html+='</div>';
  html+='<div class="_confirm-actions" style="padding:0 24px 18px">';
  html+='<button class="_confirm-btn-cancel" onclick="document.getElementById(\'_sysSyncOverlay\').remove()">取消</button>';
  html+='<button class="_confirm-btn-ok" onclick="sysDoRosterSync()">确认同步</button>';
  html+='</div></div>';

  var overlay=document.createElement('div');
  overlay.id='_sysSyncOverlay';
  overlay.className='_confirm-overlay';
  overlay.innerHTML=html;
  overlay._toAdd=toAdd;
  overlay._toRemove=toRemove;
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});
  document.body.appendChild(overlay);
}

function sysDoRosterSync(){
  var overlay=document.getElementById('_sysSyncOverlay');
  if(!overlay)return;
  var toAdd=overlay._toAdd||[];
  var toRemove=overlay._toRemove||[];
  var added=0;
  for(var i=0;i<toAdd.length;i++){
    var ae=toAdd[i];
    if(USERS[ae.name])continue;
    USERS[ae.name]={pwd:'1234',name:ae.name,role:'staff',dept:ae.dept||'',position:ae.position||'',centerKeyword:'',permissions:{hr:false,editHr:false,mbo:false,kpi:false,talent:false,learning:false,payroll:false,ideas:false,policies:false,maintenance:false,decision:false,dashboard:false,rd:false},subordinates:{},reports:{boss:'',supervisor:'',subordinates:[]}};
    added++;
  }
  var removed=0;
  for(var j=0;j<toRemove.length;j++){
    if(USERS[toRemove[j]]){delete USERS[toRemove[j]];removed++;}
  }
  if(added>0||removed>0){
    saveUserSettings();syncAllToCloud();sysRenderUserTable();
    var msg='';
    if(added>0)msg+='✅ 新增 '+added+' 个用户';
    if(removed>0)msg+=(msg?'，':'')+'🗑 清理 '+removed+' 个离职用户';
    _showAlert(msg,'同步花名册完成');
  }
  overlay.remove();
}

// ★ V0.6.1ey: 清理未授权用户 — 删除所有权限全为false且不在默认名单中的用户
function sysCleanUnauthorized(){
  var toClean=[];
  // 建立默认名单姓名集合
  var defaultNames={};
  for(var dk in _DEFAULT_USERS){if(_DEFAULT_USERS.hasOwnProperty(dk)){defaultNames[_DEFAULT_USERS[dk].name]=true;defaultNames[dk]=true;}}
  var _ALL_MODULES=['hr','editHr','mbo','kpi','talent','learning','payroll','ideas','policies','maintenance','decision','dashboard','rd'];
  for(var uid in USERS){
    if(!USERS.hasOwnProperty(uid))continue;
    var u=USERS[uid];
    // 保护默认用户
    if(defaultNames[uid]||defaultNames[u.name])continue;
    // 检查是否有任何权限为 true
    var anyOn=false;
    for(var m=0;m<_ALL_MODULES.length;m++){
      if(u.permissions&&u.permissions[_ALL_MODULES[m]]===true){anyOn=true;break;}
    }
    if(!anyOn)toClean.push(uid);
  }
  if(toClean.length===0){_showAlert('没有可清理的未授权用户','🧹 清理未授权');return;}
  var html='<div class="_confirm-card" style="max-width:560px">';
  html+='<div class="_confirm-title" style="padding:18px 24px 12px">🧹 清理未授权用户</div>';
  html+='<div class="_confirm-body" style="padding:0 24px 12px;line-height:1.6">';
  html+='<div style="font-size:12px;color:#6b7280;margin-bottom:8px">以下 '+toClean.length+' 个用户没有任何模块权限，且不在默认名单中：</div>';
  html+='<div style="background:#fef2f2;border-radius:6px;padding:6px 10px;margin-bottom:6px;max-height:180px;overflow-y:auto;font-size:12px">';
  for(var c=0;c<toClean.length;c++){
    var cu=USERS[toClean[c]];
    html+=esc(toClean[c])+(cu&&cu.dept?' <span style="color:#9ca3af">'+esc(cu.dept)+'</span>':'')+(c<toClean.length-1?'<br>':'');
  }
  html+='</div>';
  html+='<div style="font-size:11px;color:#9ca3af">已保护的默认用户及其他有权限的用户不会被删除</div>';
  html+='</div>';
  html+='<div class="_confirm-actions" style="padding:0 24px 18px">';
  html+='<button class="_confirm-btn-cancel" onclick="document.getElementById(\'_sysCleanOverlay\').remove()">取消</button>';
  html+='<button class="_confirm-btn-ok" onclick="sysDoCleanUnauthorized()">确认清理 ('+toClean.length+')</button>';
  html+='</div></div>';
  var overlay=document.createElement('div');
  overlay.id='_sysCleanOverlay';
  overlay.className='_confirm-overlay';
  overlay.innerHTML=html;
  overlay._toClean=toClean;
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});
  document.body.appendChild(overlay);
}

function sysDoCleanUnauthorized(){
  var overlay=document.getElementById('_sysCleanOverlay');
  if(!overlay)return;
  var toClean=overlay._toClean||[];
  var removed=0;
  for(var i=0;i<toClean.length;i++){if(USERS[toClean[i]]){delete USERS[toClean[i]];removed++;}}
  if(removed>0){
    saveUserSettings();syncAllToCloud();sysRenderUserTable();
    _showAlert('✅ 已清理 '+removed+' 个未授权用户（默认用户及有权限的用户已保留）','清理完成');
  }
  overlay.remove();
}


// ★ V0.6.1et: 系统维护筛选 — 表头中心/部门 + 搜索框
var _sysHeaderFilter={center:'',dept:''};
function applySysFilterToUids(uids){
  var searchEl=document.getElementById('sysFilterSearch');
  var search=searchEl?(searchEl.value||'').trim().toLowerCase():'';
  var center=_sysHeaderFilter.center;
  var dept=_sysHeaderFilter.dept;
  return uids.filter(function(uid){
    var u=USERS[uid]||{};
    if(search){
      var name=(u.name||'').toLowerCase();
      if(name.indexOf(search)<0&&uid.toLowerCase().indexOf(search)<0)return false;
    }
    if(center){
      var c=u.dept||getRosterCenterForName(u.name);
      if(c!==center)return false;
    }
    if(dept){
      var d=u.dept||getRosterDeptForName(u.name);
      if(d!==dept)return false;
    }
    return true;
  });
}

function clearSysFilter(){
  var s=document.getElementById('sysFilterSearch');if(s)s.value='';
  _sysHeaderFilter={center:'',dept:''};
  applySysFilter();
}


function applySysFilter(){
  if(typeof sysRenderUserTable==="function")sysRenderUserTable();
}

// ★ V0.6.1et: 表头点击筛选 — 中心/部门二选一
function toggleSysHeaderFilter(type){
  var existing=document.querySelector(".sys-header-dd");
  if(existing){existing.remove();document.removeEventListener("click",_cshdd);return;}
  var values={};
  var uids=Object.keys(USERS);
  for(var i=0;i<uids.length;i++){
    var u=USERS[uids[i]];
    var val="";
    if(type==="center"){val=u.dept||getRosterCenterForName(u.name)||"";}
    else{val=u.dept||getRosterDeptForName(u.name)||"";}
    if(val)values[val]=true;
  }
  var dd=document.createElement("div");
  dd.className="sys-header-dd";
  dd.style.cssText="position:fixed;z-index:9999;background:rgba(252,252,253,.92);backdrop-filter:blur(20px);border:1px solid rgba(200,205,212,.4);border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.04),0 10px 24px rgba(0,0,0,.08);padding:4px;max-height:300px;overflow-y:auto;min-width:160px";
  var allItem=document.createElement("div");
  var allSel=(_sysHeaderFilter[type]==="");
  allItem.style.cssText="padding:8px 10px;cursor:pointer;border-radius:6px;font-size:13px;background:"+(allSel?"#EEF2FF":"");
  allItem.innerHTML=(allSel?"<span style=\"color:#3B7DB4\">✓ </span>":"")+"全部";
  allItem.onclick=function(e){e.stopPropagation();_sysHeaderFilter[type]="";dd.remove();applySysFilter();};
  dd.appendChild(allItem);
  Object.keys(values).sort().forEach(function(v){
    var isSel=(_sysHeaderFilter[type]===v);
    var item=document.createElement("div");
    item.style.cssText="padding:8px 10px;cursor:pointer;border-radius:6px;font-size:13px;background:"+(isSel?"#EEF2FF":"");
    item.onmouseover=function(){this.style.background="#F5F5F5"};
    item.onmouseout=function(){this.style.background='"'+(isSel?"#EEF2FF":"")+'"'};
    item.innerHTML=(isSel?"<span style=\"color:#3B7DB4\">✓</span>":"")+"<span style=\"overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">"+v+"</span>";
    item.onclick=function(e){e.stopPropagation();_sysHeaderFilter[type]=v;dd.remove();applySysFilter();};
    dd.appendChild(item);
  });
  var th=null;
  var allThs=document.querySelectorAll(".sys-user-table th");
  var colIdx=(type==="center")?0:1;
  if(allThs[colIdx])th=allThs[colIdx];
  if(th){
    var rect=th.getBoundingClientRect();
    dd.style.left=rect.left+"px";
    dd.style.top=(rect.bottom+2)+"px";
    dd.style.minWidth=Math.max(rect.width,160)+"px";
  }
  document.body.appendChild(dd);
  _cshdd=function(e){if(!dd.contains(e.target)){dd.remove();document.removeEventListener("click",_cshdd);}};
  setTimeout(function(){document.addEventListener("click",_cshdd);},0);
}
var _cshdd=null;


// ★ V0.6.1eu: 修复缺失的函数（之前文件截断时被删除）
var _rosterCache=null;
function getRosterLookup(){
  if(_rosterCache)return _rosterCache;
  var map={};
  if(typeof allEmployees!=='undefined'&&allEmployees){
    for(var i=0;i<allEmployees.length;i++){
      var e=allEmployees[i];
      if(e&&e.name){
        var c='',d=e.dept||'';
        if(d){var m=String(d).match(/^([^/]+)/);if(m)c=m[1];}
        map[e.name]={center:c,dept:d};
      }
    }
  }
  _rosterCache=map;
  return map;
}
function getRosterCenterForName(name){
  var r=getRosterLookup();
  return r[name]?r[name].center:'';
}
function getRosterDeptForName(name){
  var r=getRosterLookup();
  return r[name]?r[name].dept:'';
}

// ★ V0.6.1.j49: 邮件通知总开关 — 一键关闭/开启所有定时邮件
var _EMAIL_TOGGLE_LOADING=false;
async function sysToggleEmailNotifications(){
  if(_EMAIL_TOGGLE_LOADING){return;}
  var btn=document.getElementById('sysEmailToggle');
  if(!btn)return;
  
  // 读当前状态
  _EMAIL_TOGGLE_LOADING=true;
  btn.disabled=true;
  btn.textContent='⏳ 切换中…';
  
  try{
    var supabase=window.supabaseClient||(typeof supabase!=='undefined'?supabase:null);
    if(!supabase){
      // fallback: 读 localStorage
      var saved=localStorage.getItem('__hwm_email_toggle__');
      var cur=saved==='false'?false:true;
      var nw=!cur;
      localStorage.setItem('__hwm_email_toggle__',String(nw));
      _updateEmailToggleBtn(nw);
      showToast(nw?'🔔 邮件通知已开启':'🔕 邮件通知已关闭');
      return;
    }
    
    // 读 Supabase 当前值
    var {data:row}=await supabase.from('hwm_settings').select('value').eq('key','email_notifications').single();
    var cur=(row&&row.value&&row.value.enabled!==false)?true:false;
    var nw=!cur;
    var reason='';

    // 二次确认
    var confirmMsg=nw?
      '确认要开启邮件自动预警通知功能吗？':
      '确认要关闭邮件自动预警通知功能吗？';
    if(!confirm(confirmMsg)){
      _updateEmailToggleBtn(cur);
      showToast('已取消');
      _EMAIL_TOGGLE_LOADING=false;
      btn.disabled=false;
      return;
    }
    reason=cur?'临时关闭':'开启通知';
    
    // 写 Supabase
    var adminName=(currentUser&&currentUser.name)||'系统管理员';
    await supabase.from('hwm_settings').upsert({
      key:'email_notifications',
      value:{enabled:nw,reason:reason,by:adminName,at:new Date().toISOString()},
      updated_at:new Date().toISOString()
    });
    
    _updateEmailToggleBtn(nw);
    showToast(nw?'🔔 邮件通知已开启':'🔕 邮件通知已关闭');
  }catch(e){
    console.error('[EmailToggle] 切换失败',e);
    showToast('⚠️ 切换失败: '+e.message);
  }
  _EMAIL_TOGGLE_LOADING=false;
  btn.disabled=false;
}

function _updateEmailToggleBtn(enabled){
  var btn=document.getElementById('sysEmailToggle');
  if(!btn)return;
  if(enabled){
    btn.textContent='🔔 邮件通知：已开启';
    btn.style.borderColor='#059669';btn.style.color='#059669';
  }else{
    btn.textContent='🔕 邮件通知：已关闭';
    btn.style.borderColor='#dc2626';btn.style.color='#dc2626';
  }
}

// ★ V0.6.1.j49: 页面加载时同步按钮状态
async function _initEmailToggleStatus(){
  var btn=document.getElementById('sysEmailToggle');
  if(!btn)return;
  try{
    var supabase=window.supabaseClient||(typeof supabase!=='undefined'?supabase:null);
    if(supabase){
      var {data:row}=await supabase.from('hwm_settings').select('value').eq('key','email_notifications').single();
      if(row&&row.value&&row.value.enabled===false){
        _updateEmailToggleBtn(false);
      }else{
        _updateEmailToggleBtn(true);
      }
    }else{
      // fallback localStorage
      var saved=localStorage.getItem('__hwm_email_toggle__');
      _updateEmailToggleBtn(saved!=='false');
    }
  }catch(e){
    _updateEmailToggleBtn(true); // 默认开启
  }
}

// ★ V0.6.1.kd: AI 邮箱配置 (SMTP) — 存储 SMTP 配置供 Edge Functions 发送邮件
var _EMAIL_CONFIG_KEY='__hwm_email_config__';

function sysGetEmailConfig(){
  try{return JSON.parse(localStorage.getItem(_EMAIL_CONFIG_KEY)||'{}');}catch(e){return{};}
}
function sysSaveEmailConfig(){
  var cfg={
    smtpHost:(document.getElementById('ecSmtpHost').value||'').trim(),
    smtpPort:parseInt(document.getElementById('ecSmtpPort').value)||465,
    smtpSsl:document.getElementById('ecSmtpSsl').value==='true',
    smtpUser:(document.getElementById('ecSmtpUser').value||'').trim(),
    smtpPass:document.getElementById('ecSmtpPass').value||'',
    senderName:(document.getElementById('ecSenderName').value||'').trim()||'MBO+AI 目标计划管理系统',
    updatedAt:new Date().toISOString()
  };
  // 基础校验
  if(!cfg.smtpHost){_showAlert('请填写 SMTP 服务器地址','📧 配置不完整');return;}
  if(!cfg.smtpPort||cfg.smtpPort<1||cfg.smtpPort>65535){_showAlert('SMTP 端口必须在 1-65535 之间','📧 配置不合法');return;}
  if(!cfg.smtpUser){_showAlert('请填写邮箱账号','📧 配置不完整');return;}
  if(!cfg.smtpPass){_showAlert('请填写 SMTP 授权码','📧 配置不完整');return;}
  try{localStorage.setItem(_EMAIL_CONFIG_KEY,JSON.stringify(cfg));}catch(e){_showAlert('保存失败:'+e.message,'错误');return;}
  console.log('[EmailConfig] ✅ 已保存 SMTP 配置 →',cfg.smtpHost+':'+cfg.smtpPort+' user='+cfg.smtpUser);
  _showAlert('AI 邮箱配置已保存!\\n\\n下次周一 8:30 周报推送和每日 8:00 到期预警将自动启用。','📧 保存成功');
  sysCloseEmailConfigModal();
}
function sysOpenEmailConfig(){
  var cfg=sysGetEmailConfig();
  document.getElementById('ecSmtpHost').value=cfg.smtpHost||'smtp.mxhichina.com';
  document.getElementById('ecSmtpPort').value=cfg.smtpPort||465;
  document.getElementById('ecSmtpSsl').value=(cfg.smtpSsl===false)?'false':'true';
  document.getElementById('ecSmtpUser').value=cfg.smtpUser||'';
  document.getElementById('ecSmtpPass').value=cfg.smtpPass||'';
  document.getElementById('ecSenderName').value=cfg.senderName||'MBO+AI 目标计划管理系统';
  document.getElementById('sysEmailConfigModal').style.display='flex';
}
function sysCloseEmailConfigModal(){
  document.getElementById('sysEmailConfigModal').style.display='none';
}
