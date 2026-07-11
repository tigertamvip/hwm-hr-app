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
}

function sysRenderUserTable(){
  var tbody=document.getElementById('sysUserTableBody');
  if(!tbody){console.warn('HWM: sysUserTableBody not found');return;}
  var uids=Object.keys(USERS);
  console.log('HWM: sysRenderUserTable rendering',uids.length,'users');
  var countEl=document.getElementById('sysUserCount');
  if(countEl)countEl.textContent=uids.length;
  // ★ 空数据兜底显示
  if(uids.length===0){
    tbody.innerHTML='<tr><td colspan="18" style="padding:40px 20px;color:var(--text-hint);font-size:13px;text-align:center">暂无授权用户，请点击「新增用户」添加</td></tr>';
    return;
  }
  var html='';
  for(var i=0;i<uids.length;i++){
    var uid=uids[i],u=USERS[uid];
    var perms=u.permissions||_defaultPerms(u.role);
    html+='<tr>';
    html+='<td class="sys-td-left"><strong>'+_h(u.name)+'</strong></td>';
    html+='<td class="sys-td-left" style="font-size:12px;color:var(--text-secondary)">'+_h(u.position)+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+_h(uid)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--text-hint)">••••</td>';
    for(var j=0;j<HWM_MODULES.length;j++){
      var mod=HWM_MODULES[j],on=!!perms[mod];
      html+='<td><span class="sys-perm-toggle '+(on?'sys-perm-yes':'sys-perm-no')+'" onclick="sysTogglePerm(\''+uid+'\',\''+mod+'\')" title="点击切换">'+(on?'✓':'—')+'</span></td>';
    }
    html+='<td><button class="sys-action-btn" onclick="sysOpenEditUser(\''+uid+'\')">编辑</button></td>';
    // 下属列
    var subs=u.subordinates||{};
    var subCount=Object.keys(subs).length;
    var subLabel='—';
    if(subCount>0){
      var dC=0,iC=0;
      for(var sk in subs){if(subs[sk]==='direct')dC++;else iC++;}
      subLabel='<span style="font-size:11px">'+dC+'直/'+iC+'间</span>';
    }
    html+='<td style="text-align:center">'+subLabel+'</td>';
    html+='</tr>';
  }
  tbody.innerHTML=html;
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
    sysBuildPermGrid({});
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
    var mod=HWM_MODULES[i],on=perms[mod]!==false;
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
    html+='<td style="padding:6px 12px;text-align:center"><select onchange="sysToggleSubRel(\''+_h(e.name)+'\',this.value)" style="font-size:12px;padding:4px 8px;border-radius:4px;border:1px solid var(--border);cursor:pointer">';
    html+='<option value="none"'+(rel==='none'?' selected':'')+'>无</option>';
    html+='<option value="direct" style="color:#22c55e"'+(rel==='direct'?' selected':'')+'>● 直属</option>';
    html+='<option value="indirect" style="color:#3b82f6"'+(rel==='indirect'?' selected':'')+'>● 间接</option>';
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
