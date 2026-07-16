// ===== HWM HR - 数据中心 v2 =====
// 驾驶舱风格：左侧导航 + 圆饼图 + 统计模块 + 评级分布 + 排名表

var _dsFilter = { scope: 'all', period: 'week', sort: 'score_desc' };
var _dsRankData = [];
var _dsTab = 'cockpit';

function dashboardInit() {
  _dsFilter = { scope: 'all', period: 'week', sort: 'score_desc' };
  _dsTab = 'cockpit';
  _dsBuildNav();
  _dsSwitchTab('cockpit');
}

function _h(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function _dsBuildNav() {
  var nav = document.getElementById('dsNavItems');
  if (!nav) return;
  var items = [
    { icon: '🚗', label: '驾驶舱', tab: 'cockpit' },
    { icon: '📋', label: '本周行动', tab: 'weekly' },
    { icon: '📅', label: '月度计划', tab: 'monthly' },
    { icon: '🎯', label: '年度目标', tab: 'annual' },
    { icon: '🏆', label: '三年规划', tab: 'plan3y', disabled: true },
    '',
    { group: '数据报告' },
    { icon: '📊', label: '任务质量', tab: 'quality' },
    { icon: '📈', label: '趋势分析', tab: 'trend' },
    { icon: '🏅', label: '奖牌榜', tab: 'medalboard' },
    '',
    { group: '工具' },
    { icon: '⚙', label: '数据导出', tab: 'export', disabled: true },
    { icon: '🔍', label: '全员检索', tab: 'search', disabled: true }
  ];
  var html = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it === '') { html += '<div class="ds-nav-sep"></div>'; continue; }
    if (it.group) { html += '<div class="ds-nav-group">' + it.group + '</div>'; continue; }
    var cls = 'ds-nav-item' + (_dsTab === it.tab ? ' ds-nav-active' : '') + (it.disabled ? ' disabled' : '');
    var onclick = it.disabled ? '' : ' onclick="_dsSwitchTab(\'' + it.tab + '\')"';
    html += '<div class="' + cls + '"' + onclick + ' style="' + (it.disabled ? 'opacity:.4;cursor:default' : '') + '"><span class="ds-nav-icon">' + it.icon + '</span>' + it.label + '</div>';
  }
  nav.innerHTML = html;
}

function _dsSwitchTab(tab) {
  _dsTab = tab;
  _dsBuildNav();
  var content = document.getElementById('dashboardContent');
  if (!content) return;
  _dsRefreshData();
  switch (tab) {
    case 'cockpit': content.innerHTML = _dsBuildCockpit(); _dsAnimate(); break;
    case 'weekly': content.innerHTML = _dsBuildWeekly(); break;
    case 'monthly': content.innerHTML = _dsBuildMonthly(); break;
    case 'annual': content.innerHTML = _dsBuildAnnual(); break;
    case 'quality': content.innerHTML = _dsBuildQuality(); break;
    case 'trend': content.innerHTML = _dsBuildTrend(); break;
    case 'medalboard': content.innerHTML = _dsBuildMedalBoard(); break;
    default: content.innerHTML = _dsBuildCockpit();
  }
}

// ===== 数据加载 =====
var _dsData = {};

function _dsRefreshData() {
  var now = new Date();
  var year = now.getFullYear();
  var week = _getISOWeek(now);
  var allPlans = {};
  try {
    for (var k in localStorage) {
      if (k.startsWith('hwm_workplans_')) {
        var d = JSON.parse(localStorage.getItem(k) || '{}');
        for (var wk in d) { if (!allPlans[wk]) allPlans[wk] = {}; allPlans[wk][k.replace('hwm_workplans_', '')] = d[wk]; }
      }
    }
    if (typeof _wpData !== 'undefined' && _wpData) {
      for (var wk2 in _wpData) {
        if (!allPlans[wk2]) allPlans[wk2] = {};
        var uk = (_wpData[wk2] && _wpData[wk2].name) || ((currentUser && currentUser.name) || 'me');
        allPlans[wk2][uk] = _wpData[wk2];
      }
    }
  } catch (e) {}

  var users = {};
  for (var uid in USERS) {
    if (uid === '管理员' || USERS[uid].role === 'admin') continue;
    users[USERS[uid].name || uid] = USERS[uid];
  }
  var totalUsers = Object.keys(users).length;
  var cWeekId = year + '-W' + week;
  var pWeekId = year + '-W' + (week - 1);

  var planSub = 0, sumSub = 0, prevPlan = 0, prevSum = 0, ytdPlan = 0, ytdSum = 0, ytdWeeks = 0;
  var ratings = { gold: 0, silver: 0, bronze: 0, warn: 0, danger: 0 };

  for (var uname in users) {
    var wp = (allPlans[cWeekId] && allPlans[cWeekId][uname]) || {};
    var wpp = (allPlans[pWeekId] && allPlans[pWeekId][uname]) || {};
    if (wp.submittedAt || wp.firstSubmittedAt) planSub++;
    if (wp.summarySubmittedAt) sumSub++;
    if (wpp.submittedAt || wpp.firstSubmittedAt) prevPlan++;
    if (wpp.summarySubmittedAt) prevSum++;
    var r = wp.weeklyRating || '';
    if (ratings[r] !== undefined) ratings[r]++;

    for (var wkId in allPlans) {
      var parts = wkId.split('-W');
      if (parseInt(parts[0]) !== year) continue;
      var pp = allPlans[wkId][uname] || {};
      if (pp.submittedAt || pp.firstSubmittedAt) ytdPlan++;
      if (pp.summarySubmittedAt) ytdSum++;
      ytdWeeks++;
    }
  }

  _dsRankData = [];
  for (var uname2 in users) {
    var u = users[uname2];
    var sc = _dsCalcUserScore(uname2, allPlans, _dsFilter.period);
    _dsRankData.push({
      name: uname2, dept: u.dept || u.centerKeyword || '',
      center: u.centerKeyword || u.dept || '', role: u.role || '',
      score: sc.net || 0, gold: sc._gold || 0, rating: sc.currentRating || '', trend: sc.trend || 0
    });
  }
  _dsRankData.sort(function (a, b) { return b.score - a.score; });

  var myName = (currentUser && currentUser.name) || '';
  var myScore = 0, myRank = '—', myGold = 0;
  for (var ri = 0; ri < _dsRankData.length; ri++) {
    if (_dsRankData[ri].name === myName) { myScore = _dsRankData[ri].score; myRank = (ri + 1) + '/' + _dsRankData.length; myGold = _dsRankData[ri].gold; break; }
  }

  _dsData = {
    totalUsers: totalUsers, myScore: myScore, myRank: myRank, myGold: myGold,
    cWeekId: cWeekId, week: week,
    planRate: totalUsers ? Math.round(planSub / totalUsers * 100) : 0, planSub: planSub,
    sumRate: totalUsers ? Math.round(sumSub / totalUsers * 100) : 0, sumSub: sumSub,
    prevPlanRate: totalUsers ? Math.round(prevPlan / totalUsers * 100) : 0, prevPlanSub: prevPlan,
    prevSumRate: totalUsers ? Math.round(prevSum / totalUsers * 100) : 0, prevSumSub: prevSum,
    ytdPlanRate: ytdWeeks ? Math.round(ytdPlan / ytdWeeks * 100) : 0,
    ytdSumRate: ytdWeeks ? Math.round(ytdSum / ytdWeeks * 100) : 0,
    ratings: ratings, totalRatings: ratings.gold + ratings.silver + ratings.bronze + ratings.warn + ratings.danger
  };
}

function _dsCalcUserScore(userName, allPlans, period) {
  var net = 0, gold = 0, trend = 0, cr = '';
  var now = new Date(), year = now.getFullYear(), week = _getISOWeek(now);
  var cWeekId = year + '-W' + week, pWeekId = year + '-W' + (week - 1);
  var cw = 0, pw = 0;
  for (var wkId in allPlans) {
    var pp = allPlans[wkId][userName] || {};
    if (!pp.year) continue;
    var ws = 0;
    if (pp._taskScores) for (var ti = 0; ti < pp._taskScores.length; ti++) ws += pp._taskScores[ti] || 0;
    var rm = { gold: 2, silver: 1, bronze: 0, warn: -1, danger: -2 };
    if (pp.weeklyRating && rm[pp.weeklyRating] !== undefined) { ws += rm[pp.weeklyRating]; if (pp.weeklyRating === 'gold') gold++; }
    if (wkId === cWeekId) { cr = pp.weeklyRating || ''; cw = ws; }
    if (wkId === pWeekId) pw = ws;
    var include = false;
    if (period === 'week') include = (wkId === cWeekId);
    else if (period === 'month') include = (parseInt(wkId.split('-W')[0]) === year && Math.ceil(parseInt(wkId.split('-W')[1]) / 4.33) === Math.ceil((now.getMonth() + 1) / 4.33));
    else if (period === 'quarter') include = (parseInt(wkId.split('-W')[0]) === year && Math.ceil(Math.ceil(parseInt(wkId.split('-W')[1]) / 4.33) / 3) === Math.ceil((now.getMonth() + 1) / 3));
    else if (period === 'ytd') include = (parseInt(wkId.split('-W')[0]) === year);
    if (include) net += ws;
  }
  trend = cw - pw;
  return { net: net, _gold: gold, currentRating: cr, trend: trend };
}

function _getISOWeek(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - y) / 86400000) + 1) / 7);
}

// ===== 驾驶舱 =====
function _dsBuildCockpit() {
  var dd = _dsData;
  return '<div class="ds-grid">' +
    _dsBuildCards() +
    _dsBuildDonuts() +
    _dsBuildStats() +
    _dsBuildFilterBar() +
    _dsBuildRankTable() +
    '</div>';
}

function _dsBuildCards() {
  var dd = _dsData;
  return '<div class="ds-cards-row">' +
    '<div class="ds-card ds-card-gold"><div class="ds-card-num">' + (dd.myScore >= 0 ? '+' : '') + dd.myScore + '</div><div class="ds-card-label">🏅 我的净积分</div></div>' +
    '<div class="ds-card ds-card-gold"><div class="ds-card-num">' + dd.myRank + '</div><div class="ds-card-label">🏆 我的排名</div></div>' +
    '<div class="ds-card ds-card-silver"><div class="ds-card-num">🥇×' + dd.myGold + '</div><div class="ds-card-label">🏅 奖牌战绩</div></div>' +
    '<div class="ds-card ds-card-blue"><div class="ds-card-num" style="color:#3B82F6">' + dd.planRate + '%</div><div class="ds-card-label">⏰ 周计划提交率</div></div>' +
    '<div class="ds-card ds-card-green"><div class="ds-card-num" style="color:#059669">' + dd.sumRate + '%</div><div class="ds-card-label">⏰ 周小结提交率</div></div>' +
    '</div>';
}

function _dsBuildDonuts() {
  var dd = _dsData;
  var donuts = [
    { title: '年度周计划提交率', sub: dd.ytdPlanRate + '%', pct: dd.ytdPlanRate, color: '#EF4444', total: '—', actual: '—' },
    { title: '年度周小结提交率', sub: dd.ytdSumRate + '%', pct: dd.ytdSumRate, color: '#3B82F6', total: '—', actual: '—' },
    { title: '本周周计划提交', sub: dd.planRate + '% (' + dd.planSub + '/' + dd.totalUsers + ')', pct: dd.planRate, color: '#10B981', total: dd.totalUsers, actual: dd.planSub },
    { title: '本周周小结提交', sub: dd.sumRate + '% (' + dd.sumSub + '/' + dd.totalUsers + ')', pct: dd.sumRate, color: '#F59E0B', total: dd.totalUsers, actual: dd.sumSub }
  ];
  var html = '<div class="ds-donuts">';
  for (var i = 0; i < donuts.length; i++) {
    var d = donuts[i];
    var circumference = 2 * Math.PI * 52;
    var offset = circumference * (1 - Math.min(d.pct, 100) / 100);
    html += '<div class="ds-donut-card"><div class="ds-donut-title">' + d.title + '</div>' +
      '<svg width="130" height="130" viewBox="0 0 130 130"><circle cx="65" cy="65" r="52" fill="none" stroke="#f3f4f6" stroke-width="10"/>' +
      '<circle class="ds-donut-ring" cx="65" cy="65" r="52" fill="none" stroke="' + d.color + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + circumference + '" data-offset="' + offset + '" transform="rotate(-90 65 65)" style="transition:stroke-dashoffset .8s ease"/>' +
      '<text x="65" y="62" text-anchor="middle" font-size="22" font-weight="700" fill="' + d.color + '">' + d.pct + '%</text>' +
      '<text x="65" y="82" text-anchor="middle" font-size="11" fill="#6b7280">W' + dd.week + '</text></svg>' +
      '<div class="ds-donut-sub">' + d.sub + '</div></div>';
  }
  html += '</div>';
  return html;
}

function _dsBuildStats() {
  var dd = _dsData, rt = dd.ratings || {}, tr = dd.totalRatings || 0;
  var rItems = [
    { label: '🥇', key: 'gold', color: '#FFD700' },
    { label: '🥈', key: 'silver', color: '#C0C0C0' },
    { label: '🥉', key: 'bronze', color: '#CD7F32' },
    { label: '⚠️', key: 'warn', color: '#F59E0B' },
    { label: '⛔', key: 'danger', color: '#EF4444' }
  ];
  var rhtml = '<div class="ds-rating-bars">';
  for (var i = 0; i < rItems.length; i++) {
    var ri = rItems[i], v = rt[ri.key] || 0, w = tr ? Math.round(v / tr * 100) : 0;
    rhtml += '<div class="ds-rating-row"><span class="ds-r-label">' + ri.label + '</span><div class="ds-r-bar"><div style="width:' + w + '%;background:' + ri.color + '"></div></div><span class="ds-r-count">' + v + '</span></div>';
  }
  rhtml += '</div>';

  return '<div class="ds-stats-row">' +
    '<div class="ds-stat-module"><div class="ds-stat-head">📋 年度周计划提交率</div><div class="ds-stat-num" style="color:#EF4444">' + dd.ytdPlanRate + '%</div><div class="ds-stat-detail">累计统计</div><div class="ds-stat-bar"><div style="width:' + dd.ytdPlanRate + '%;background:#EF4444"></div></div></div>' +
    '<div class="ds-stat-module"><div class="ds-stat-head">📝 年度周小结提交率</div><div class="ds-stat-num" style="color:#3B82F6">' + dd.ytdSumRate + '%</div><div class="ds-stat-detail">累计统计</div><div class="ds-stat-bar"><div style="width:' + dd.ytdSumRate + '%;background:#3B82F6"></div></div></div>' +
    '<div class="ds-stat-module"><div class="ds-stat-head">📋 上周周计划提交率</div><div class="ds-stat-num" style="color:#10B981">' + dd.prevPlanRate + '%</div><div class="ds-stat-detail">' + dd.prevPlanSub + '/' + dd.totalUsers + '</div><div class="ds-stat-bar"><div style="width:' + dd.prevPlanRate + '%;background:#10B981"></div></div></div>' +
    '<div class="ds-stat-module"><div class="ds-stat-head">📝 上周周小结提交率</div><div class="ds-stat-num" style="color:#F59E0B">' + dd.prevSumRate + '%</div><div class="ds-stat-detail">' + dd.prevSumSub + '/' + dd.totalUsers + '</div><div class="ds-stat-bar"><div style="width:' + dd.prevSumRate + '%;background:#F59E0B"></div></div></div>' +
    '<div class="ds-stat-module"><div class="ds-stat-head">🏅 上级评价分布（本周）</div>' + rhtml + '<div class="ds-stat-detail" style="margin-top:4px">共 ' + tr + ' 次评价</div></div>' +
    '</div>';
}

function _dsBuildFilterBar() {
  var scopeOpts = '<option value="all">全部员工</option>';
  var roles = { senior: '高层', middle_manager: '中层（经理级）', center_head: '中心负责人', staff: '普通员工' };
  for (var r in roles) scopeOpts += '<option value="role:' + r + '">' + roles[r] + '</option>';
  var centers = {};
  for (var k in USERS) {
    if (USERS[k].centerKeyword) centers[USERS[k].centerKeyword] = true;
    if (USERS[k].dept && !USERS[k].centerKeyword) centers[USERS[k].dept] = true;
  }
  scopeOpts += '<option disabled>── 按中心/部门 ──</option>';
  for (var c in centers) scopeOpts += '<option value="center:' + c + '">' + c + '</option>';
  return '<div class="ds-filter-bar">' +
    '<select id="dsScope" class="ds-select" onchange="_dsOnFilter()">' + scopeOpts + '</select>' +
    '<select id="dsPeriod" class="ds-select" onchange="_dsOnFilter()"><option value="week">本周</option><option value="month">本月</option><option value="quarter">本季度</option><option value="ytd">年度 YTD</option></select>' +
    '<select id="dsSort" class="ds-select" onchange="_dsOnFilter()"><option value="score_desc">积分 ↓</option><option value="score_asc">积分 ↑</option><option value="name">姓名</option><option value="gold_desc">金牌数 ↓</option></select>' +
    '<button class="btn btn-outline btn-sm" onclick="_dsRefresh()" style="margin:0">🔄 刷新排名</button></div>';
}

function _dsBuildRankTable() {
  return '<div class="ds-table-wrap"><table class="ds-table"><thead><tr><th>#</th><th>姓名</th><th>中心/部门</th><th>积分</th><th>🥇</th><th>本周评级</th><th>📈 趋势</th></tr></thead><tbody id="dsTbody"><tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-hint)">点击刷新排名</td></tr></tbody></table></div>';
}

function _dsAnimate() {
  setTimeout(function () {
    var rings = document.querySelectorAll('.ds-donut-ring');
    for (var i = 0; i < rings.length; i++) {
      rings[i].style.strokeDashoffset = rings[i].getAttribute('data-offset');
    }
  }, 200);
  _dsRenderRankTable();
}

// ===== 占位页面 =====
function _dsBuildWeekly() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:60px;color:var(--text-hint)"><div style="font-size:48px;margin-bottom:12px">📋</div>本周行动详情页 — 建设中</div></div>'; }
function _dsBuildMonthly() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:60px;color:var(--text-hint)"><div style="font-size:48px;margin-bottom:12px">📅</div>月度计划页面 — 建设中</div></div>'; }
function _dsBuildAnnual() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:60px;color:var(--text-hint)"><div style="font-size:48px;margin-bottom:12px">🎯</div>年度目标页面 — 建设中</div></div>'; }
function _dsBuildQuality() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:60px;color:var(--text-hint)"><div style="font-size:48px;margin-bottom:12px">📊</div>任务质量分析 — 建设中</div></div>'; }
function _dsBuildTrend() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:60px;color:var(--text-hint)"><div style="font-size:48px;margin-bottom:12px">📈</div>趋势分析 — 建设中</div></div>'; }
function _dsBuildMedalBoard() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:60px;color:var(--text-hint)"><div style="font-size:48px;margin-bottom:12px">🏅</div>奖牌榜 — 建设中</div></div>'; }

// ===== 排名表 =====
function _dsOnFilter() {
  _dsFilter.scope = document.getElementById('dsScope').value;
  _dsFilter.period = document.getElementById('dsPeriod').value;
  _dsFilter.sort = document.getElementById('dsSort').value;
  _dsRefreshData();
  _dsRenderRankTable();
}

function _dsRefresh() {
  var btn = document.querySelector('.ds-filter-bar button');
  if (btn) { btn.textContent = '⏳ 计算中...'; btn.disabled = true; }
  setTimeout(function () {
    _dsRefreshData();
    _dsRenderRankTable();
    if (btn) { btn.textContent = '🔄 刷新排名'; btn.disabled = false; }
  }, 300);
}

function _dsRenderRankTable() {
  var tbody = document.getElementById('dsTbody');
  if (!tbody) return;
  var filtered = _dsRankData.filter(function (r) {
    if (_dsFilter.scope === 'all') return true;
    if (_dsFilter.scope.startsWith('role:')) return r.role === _dsFilter.scope.replace('role:', '');
    if (_dsFilter.scope.startsWith('center:')) { var c = _dsFilter.scope.replace('center:', ''); return r.center === c || r.dept === c; }
    return true;
  });
  if (_dsFilter.sort === 'score_desc') filtered.sort(function (a, b) { return b.score - a.score; });
  else if (_dsFilter.sort === 'score_asc') filtered.sort(function (a, b) { return a.score - b.score; });
  else if (_dsFilter.sort === 'name') filtered.sort(function (a, b) { return a.name.localeCompare(b.name); });
  else if (_dsFilter.sort === 'gold_desc') filtered.sort(function (a, b) { return b.gold - a.gold; });

  if (filtered.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-hint)">暂无数据</td></tr>'; return; }
  var rm = { gold: '🥇', silver: '🥈', bronze: '🥉', warn: '⚠️', danger: '⛔' };
  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var r = filtered[i];
    var ts = r.trend > 0 ? '<span style="color:#059669">↗ +' + r.trend + '</span>' : r.trend < 0 ? '<span style="color:#dc2626">↘ ' + r.trend + '</span>' : '<span style="color:#9ca3af">→ 0</span>';
    var rs = i === 0 ? 'background:#FFF8E1;font-weight:700;color:#B45309;border-radius:3px;padding:2px 6px' : i === 1 ? 'background:#F3F4F6;font-weight:700;color:#6B7280;border-radius:3px;padding:2px 6px' : i === 2 ? 'background:#FFF7ED;font-weight:700;color:#D97706;border-radius:3px;padding:2px 6px' : '';
    html += '<tr><td style="text-align:center"><span style="' + rs + '">' + (i + 1) + '</span></td>' +
      '<td><strong>' + _h(r.name) + '</strong></td>' +
      '<td style="font-size:12px;color:var(--text-secondary)">' + _h(r.center || r.dept) + '</td>' +
      '<td style="font-weight:600;color:' + (r.score >= 0 ? '#059669' : '#dc2626') + '">' + (r.score >= 0 ? '+' : '') + r.score + '</td>' +
      '<td style="text-align:center">' + (r.gold > 0 ? '×' + r.gold : '—') + '</td>' +
      '<td style="text-align:center;font-size:18px">' + (rm[r.rating] || '—') + '</td><td>' + ts + '</td></tr>';
  }
  tbody.innerHTML = html;
}

window.dashboardInit = dashboardInit;
window._dsOnFilter = _dsOnFilter;
window._dsRefresh = _dsRefresh;
window._dsSwitchTab = _dsSwitchTab;
