// ===== HWM HR - 数据中心 v2 =====
// 驾驶舱风格：左侧导航 + 圆饼图 + 统计模块 + 评级分布 + 排名表

var _dsFilter = { scope: 'all', period: 'week', sort: 'score_desc' };
var _dsRankData = [];
var _dsTab = 'cockpit';

function dashboardInit() {
  try {
    _dsFilter = { scope: 'all', period: 'week', sort: 'score_desc' };
    _dsTab = 'cockpit';
    _dsBuildNav();
    _dsSwitchTab('cockpit');
  } catch (e) {
    console.error('[DS] dashboardInit error:', e);
    var content = document.getElementById('dashboardContent');
    if (content) {
      content.innerHTML = '<div class="ds-card" style="padding:40px;text-align:center;color:#dc2626"><div style="font-size:16px;font-weight:600;margin-bottom:8px">⚠️ 数据中心初始化异常</div><div style="font-size:12px;color:var(--text-hint);font-family:monospace;text-align:left;max-width:600px;margin:0 auto;white-space:pre-wrap">' + (e.stack || e.message || '未知错误') + '</div></div>';
    }
  }
}

function _h(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function _dsBuildNav() {
  var nav = document.getElementById('dsNavItems');
  if (!nav) return;
  var html = '<div class="ds-nav-section-title">📊 数据驾驶舱</div>';
  var items = [
    { icon: '📋', label: '本周行动', tab: 'cockpit' },
    { icon: '📅', label: '月度计划', tab: 'monthly' },
    { icon: '🎯', label: '年度目标', tab: 'annual' },
    { icon: '🏆', label: '三年规划', tab: 'plan3y', disabled: true },
    '<sep>',
    '<group>数据报告</group>',
    { icon: '🔬', label: '研发数据', tab: 'data_report' },
    { icon: '🏭', label: '制造数据', tab: 'data_report' },
    { icon: '📦', label: '采购数据', tab: 'data_report' },
    { icon: '✅', label: '质量数据', tab: 'data_report' },
    { icon: '📣', label: '营销数据', tab: 'data_report' },
    { icon: '👥', label: '人力数据', tab: 'data_report' },
    { icon: '💰', label: '财务数据', tab: 'data_report' },
    { icon: '📋', label: '注册数据', tab: 'data_report' },
    { icon: '📑', label: '其他数据', tab: 'data_report' }
  ];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it === '<sep>') { html += '<div class="ds-nav-sep"></div>'; continue; }
    if (it === '<group>数据报告</group>') { html += '<div class="ds-nav-group">数据报告</div>'; continue; }
    var cls = 'ds-nav-item' + (_dsTab === it.tab ? ' ds-nav-active' : '') + (it.disabled ? ' disabled' : '');
    var onclick = it.disabled ? '' : ' onclick="_dsSwitchTab(\'' + it.tab + '\')"';
    html += '<div class="' + cls + '"' + onclick + ' style="' + (it.disabled ? 'opacity:.4;cursor:default' : '') + '"><span class="ds-nav-icon">' + it.icon + '</span>' + it.label + '</div>';
  }
  nav.innerHTML = html;
}

function _dsSwitchTab(tab) {
  try {
    _dsTab = tab;
    _dsBuildNav();
    var content = document.getElementById('dashboardContent');
    if (!content) return;
    _dsRefreshData();
    switch (tab) {
      case 'cockpit': content.innerHTML = _dsBuildCockpit(); _dsRenderRankTable(); break;
      case 'weekly': content.innerHTML = _dsBuildCockpit(); _dsRenderRankTable(); break;
      case 'monthly': content.innerHTML = _dsBuildMonthly(); break;
      case 'annual': content.innerHTML = _dsBuildAnnual(); break;
      case 'data_report': content.innerHTML = _dsBuildDataReport(); break;
      case 'quality': content.innerHTML = _dsBuildQuality(); break;
      case 'trend': content.innerHTML = _dsBuildTrend(); break;
      case 'medalboard': content.innerHTML = _dsBuildMedalBoard(); break;
      default: content.innerHTML = _dsBuildCockpit();
    }
  } catch (e) {
    console.error('[DS] _dsSwitchTab error:', e);
    var content = document.getElementById('dashboardContent');
    if (content) {
      content.innerHTML = '<div class="ds-card" style="padding:40px;text-align:center;color:#dc2626"><div style="font-size:16px;font-weight:600;margin-bottom:8px">⚠️ 页面切换异常</div><div style="font-size:12px;color:var(--text-hint);font-family:monospace;text-align:left;max-width:600px;margin:0 auto;white-space:pre-wrap">' + (e.stack || e.message || '未知错误') + '</div></div>';
    }
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
    // Step 1: 从 localStorage 读取所有 hwm_workplans_* 数据
    for (var k in localStorage) {
      if (k.startsWith('hwm_workplans_')) {
        var d = JSON.parse(localStorage.getItem(k) || '{}');
        for (var wk in d) { if (!allPlans[wk]) allPlans[wk] = {}; allPlans[wk][k.replace('hwm_workplans_', '')] = d[wk]; }
      }
    }
    // ★ V0.6.1.hs: 智能合并 _wpData — 只覆盖较新的版本
    if (typeof _wpData !== 'undefined' && _wpData) {
      for (var wk2 in _wpData) {
        if (!allPlans[wk2]) { allPlans[wk2] = {}; }
        var uk = (_wpData[wk2] && _wpData[wk2].name) || ((currentUser && currentUser.name) || 'me');
        var lp = allPlans[wk2][uk];
        var wpp = _wpData[wk2];
        // 比较 updatedAt，只保留较新版本（避免陈旧 _wpData 覆盖 localStorage 新数据）
        if (!lp || (wpp.updatedAt && lp.updatedAt && wpp.updatedAt > lp.updatedAt)) {
          allPlans[wk2][uk] = wpp;
        }
      }
    }
  } catch (e) {}

  var users = {};
  for (var uid in USERS) {
    if (uid === '管理员' || USERS[uid].role === 'admin') continue;
    users[USERS[uid].name || uid] = USERS[uid];
  }
  var totalUsers = Object.keys(users).length;
  // ★ V0.6.1.hx: 把 ISO 周转月-周（与 plan 字段匹配）
  var sMapped = (typeof isoWeekToMonthWeek === 'function') ? isoWeekToMonthWeek(week) : { month: 1, week: week };
  var cMonth = sMapped.month, cWeekInMonth = sMapped.week;
  var pWeekInMonth = cWeekInMonth - 1, pMonth = cMonth;
  if (pWeekInMonth < 1) { pWeekInMonth = 4; pMonth = cMonth - 1; }
  if (pMonth < 1) pMonth = 12; // 跨年回退
  // 本周字段值（用于 YTD 排除本周等）
  var currentPlans = { month: cMonth, week: cWeekInMonth };
  var prevPlans = { month: pMonth, week: pWeekInMonth };

  var planSub = 0, sumSub = 0, prevPlan = 0, prevSum = 0, ytdPlan = 0, ytdSum = 0, ytdWeeks = 0;
  var ratings = { gold: 0, silver: 0, bronze: 0, warn: 0, danger: 0 };

  for (var uname in users) {
    // ★ V0.6.1.hx: 用 plan 字段判断本周/上周（避免 wkId 格式不匹配）
    var currentPlan = null, prevPlanObj = null;
    for (var wkK in allPlans) {
      var ppK = allPlans[wkK][uname];
      if (!ppK) continue;
      if (ppK.year === year && ppK.month === cMonth && ppK.week === cWeekInMonth) currentPlan = ppK;
      if (ppK.year === year && ppK.month === pMonth && ppK.week === pWeekInMonth) prevPlanObj = ppK;
    }
    if (currentPlan) {
      if (currentPlan.submittedAt || currentPlan.firstSubmittedAt) planSub++;
      if (currentPlan.summarySubmittedAt) sumSub++;
    }
    if (prevPlanObj) {
      if (prevPlanObj.submittedAt || prevPlanObj.firstSubmittedAt) prevPlan++;
      if (prevPlanObj.summarySubmittedAt) prevSum++;
    }

    for (var wkId in allPlans) {
      var parts = wkId.split('-W');
      if (parseInt(parts[0]) !== year) continue;
      var pp = allPlans[wkId][uname] || {};
      if (pp.submittedAt || pp.firstSubmittedAt) ytdPlan++;
      if (pp.summarySubmittedAt) ytdSum++;
      ytdWeeks++;
      // ★ V0.6.1.hn: 评级统计 - 累计全年所有周的评级
      var rr = pp.weeklyRating || '';
      if (ratings[rr] !== undefined) ratings[rr]++;
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
  var myScore = 0, myRank = '—', myGold = 0, myGivenGold = 0, myGivenTotal = 0;
  // ★ V0.6.1.hv: 统计「我评出的奖牌」— 只统计有效评级（gold/silver/bronze/warn/danger）
  var _validRatings = ['gold','silver','bronze','warn','danger'];
  for (var wkId2 in allPlans) {
    var pplans = allPlans[wkId2];
    if (!pplans) continue;
    for (var pname in pplans) {
      var pp2 = pplans[pname];
      if (!pp2) continue;
      if (_validRatings.indexOf(pp2.weeklyRating) >= 0 && pp2.bossEvaluatedBy === myName) {
        myGivenTotal++;
        if (pp2.weeklyRating === 'gold') myGivenGold++;
      }
    }
  }
  for (var ri = 0; ri < _dsRankData.length; ri++) {
    if (_dsRankData[ri].name === myName) { myScore = _dsRankData[ri].score; myRank = (ri + 1) + '/' + _dsRankData.length; myGold = _dsRankData[ri].gold; break; }
  }

  _dsData = {
    totalUsers: totalUsers, myScore: myScore, myRank: myRank, myGold: myGold,
    myGivenGold: myGivenGold, myGivenTotal: myGivenTotal,
    cMonth: cMonth, cWeekInMonth: cWeekInMonth, week: week,
    planRate: totalUsers ? Math.round(planSub / totalUsers * 100) : 0, planSub: planSub,
    sumRate: totalUsers ? Math.round(sumSub / totalUsers * 100) : 0, sumSub: sumSub,
    prevPlanRate: totalUsers ? Math.round(prevPlan / totalUsers * 100) : 0, prevPlanSub: prevPlan,
    prevSumRate: totalUsers ? Math.round(prevSum / totalUsers * 100) : 0, prevSumSub: prevSum,
    ytdPlanRate: ytdWeeks ? Math.round(ytdPlan / ytdWeeks * 100) : 0,
    ytdPlanSub: ytdPlan,
    ytdSumRate: ytdWeeks ? Math.round(ytdSum / ytdWeeks * 100) : 0,
    ytdSumSub: ytdSum,
    ratings: ratings, totalRatings: ratings.gold + ratings.silver + ratings.bronze + ratings.warn + ratings.danger,
    lastUpdate: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  // ★ V0.6.1.hs: 异步从 Supabase 同步最新评分数据（跨设备一致）
  _dsSyncFromCloud();
}

// ★ V0.6.1.hs: 从 Supabase 拉取最新评分（补充跨设备同步）
function _dsSyncFromCloud() {
  if (typeof supabase === 'undefined' || !supabase || !supabase.from) return;
  (async function () {
    try {
      var resp = await supabase.from('hwm_workplans').select('username,week_id,plan_data').order('updated_at', { ascending: false }).limit(500);
      if (resp.error || !resp.data) return;
      var merged = false;
      for (var i = 0; i < resp.data.length; i++) {
        var row = resp.data[i];
        var wk = row.week_id;
        var un = row.username;
        var pd = row.plan_data;
        if (!pd || !pd.weeklyRating) continue;
        // 只同步有评级变化的数据
        var localKey = 'hwm_workplans_' + un;
        try {
          var local = JSON.parse(localStorage.getItem(localKey) || '{}');
          var localPlan = local[wk] || {};
          var localRating = localPlan.weeklyRating || '';
          var cloudRating = pd.weeklyRating || '';
          if (cloudRating && cloudRating !== localRating) {
            // 云端有本地没有的评级：更新本地
            localPlan.weeklyRating = cloudRating;
            localPlan.updatedAt = pd.updatedAt || row.updated_at || '';
            local[wk] = localPlan;
            localStorage.setItem(localKey, JSON.stringify(local));
            merged = true;
          }
        } catch (e) {}
      }
      if (merged) {
        // 重新计算排名
        _dsRefreshData();
        // ★ V0.6.1.ht: 云端同步后有新数据，重新渲染整个驾驶舱（包括奖牌卡片）
        var content = document.getElementById('dashboardContent');
        if (content && (_dsTab === 'cockpit' || _dsTab === 'weekly')) {
          content.innerHTML = _dsBuildCockpit();
        }
        setTimeout(function () { _dsRenderRankTable(); }, 50);
      }
    } catch (e) { console.warn('[DS] Cloud sync error (non-critical):', e.message); }
  })();
}

function _dsCalcUserScore(userName, allPlans, period) {
  var net = 0, gold = 0, trend = 0, cr = '';
  var now = new Date(), year = now.getFullYear(), week = _getISOWeek(now);
  // ★ V0.6.1.hv: 把 ISO 周转为月-周（与 makeWPId 格式一致："yyyy-mm-Ww"）
  var sMapped = (typeof isoWeekToMonthWeek === 'function') ? isoWeekToMonthWeek(week) : { month: now.getMonth() + 1, week: week };
  var cMonth = sMapped.month, cWeekInMonth = sMapped.week;
  // 上一周（简化处理：同月 week-1；跨月则月份-1）
  var pMonth = cMonth, pWeekInMonth = cWeekInMonth - 1;
  if (pWeekInMonth < 1) { pMonth = cMonth - 1; pWeekInMonth = 4; }
  var cw = 0, pw = 0;
  for (var wkId in allPlans) {
    var pp = allPlans[wkId][userName] || {};
    if (!pp.year) continue;
    var ws = 0;
    if (pp._taskScores) for (var ti = 0; ti < pp._taskScores.length; ti++) ws += pp._taskScores[ti] || 0;
    var rm = { gold: 2, silver: 1, bronze: 0, warn: -1, danger: -2 };
    if (pp.weeklyRating && rm[pp.weeklyRating] !== undefined) { ws += rm[pp.weeklyRating]; if (pp.weeklyRating === 'gold') gold++; }
    // ★ V0.6.1.hv: 用 plan 自身的 year/month/week 字段判断当前周/上周期（避免 wkId 格式不匹配）
    var isCurrentWeek = (pp.year === year && pp.month === cMonth && pp.week === cWeekInMonth);
    var isPrevWeek = (pp.year === year && pp.month === pMonth && pp.week === pWeekInMonth);
    if (isCurrentWeek) { cr = pp.weeklyRating || ''; cw = ws; }
    if (isPrevWeek) pw = ws;
    var include = false;
    if (period === 'week') include = isCurrentWeek;
    else if (period === 'month') include = (pp.year === year && pp.month === now.getMonth() + 1);
    else if (period === 'quarter') include = (pp.year === year && Math.ceil(pp.month / 3) === Math.ceil((now.getMonth() + 1) / 3));
    else if (period === 'ytd') include = (pp.year === year);
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
  try {
    return '<div class="ds-grid">' +
      _dsBuildHeroStats() +
      _dsBuildRatingPanel() +
      _dsBuildFilterBar() +
      _dsBuildRankTable() +
      '</div>';
  } catch (e) {
    console.error('[DS] _dsBuildCockpit error:', e);
    return '<div class="ds-grid"><div class="ds-card" style="padding:40px;text-align:center;color:#dc2626"><div style="font-size:16px;font-weight:600;margin-bottom:8px">⚠️ 驾驶舱渲染异常</div><div style="font-size:12px;color:var(--text-hint)">' + (e.message || '未知错误') + '</div></div></div>';
  }
}

// ★ V0.6.1.hx: 全员 4 大提交率卡片（年度×计划/小结 + 上周×计划/小结）
function _dsBuildHeroStats() {
  var dd = _dsData || {};
  var cards = [
    { title: '📋 全员年度周计划及时提交率', num: dd.ytdPlanRate || 0, sub: (dd.ytdPlanSub || 0) + ' 次 / ' + ((dd.ytdWeeks || 0) * (dd.totalUsers || 0)) + ' 人周', color: '#EF4444' },
    { title: '📝 全员年度周小结及时提交率', num: dd.ytdSumRate || 0, sub: (dd.ytdSumSub || 0) + ' 次 / ' + ((dd.ytdWeeks || 0) * (dd.totalUsers || 0)) + ' 人周', color: '#3B82F6' },
    { title: '📋 上周周计划及时提交率', num: dd.prevPlanRate || 0, sub: (dd.prevPlanSub || 0) + ' / ' + (dd.totalUsers || 0) + ' 人', color: '#10B981' },
    { title: '📝 上周周小结及时提交率', num: dd.prevSumRate || 0, sub: (dd.prevSumSub || 0) + ' / ' + (dd.totalUsers || 0) + ' 人', color: '#F59E0B' }
  ];
  var html = '<div class="ds-hero-row">';
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    html += '<div class="ds-hero-card" style="border-top:4px solid ' + c.color + '">' +
      '<div class="ds-hero-title">' + c.title + '</div>' +
      '<div class="ds-hero-num" style="color:' + c.color + '">' + c.num + '<span class="ds-hero-pct">%</span></div>' +
      '<div class="ds-hero-sub">' + c.sub + '</div>' +
      '<div class="ds-hero-bar"><div style="width:' + c.num + '%;background:' + c.color + '"></div></div>' +
      '</div>';
  }
  html += '</div>';
  return html;
}

// ★ V0.6.1.hx: 全员上级评价分布（独立面板）
function _dsBuildRatingPanel() {
  var dd = _dsData, rt = dd.ratings || {}, tr = dd.totalRatings || 0;
  // 默认收起（如果总评分为 0）— 节省空间
  var collapsed = (tr === 0) ? ' ds-rating-collapsed' : '';
  var rItems = [
    { label: '🥇 金牌', key: 'gold', color: '#FFD700' },
    { label: '🥈 银牌', key: 'silver', color: '#C0C0C0' },
    { label: '🥉 铜牌', key: 'bronze', color: '#CD7F32' },
    { label: '⚠️ 待改进', key: 'warn', color: '#F59E0B' },
    { label: '⛔ 严重偏离', key: 'danger', color: '#EF4444' }
  ];
  var rhtml = '<div class="ds-rating-bars">';
  for (var i = 0; i < rItems.length; i++) {
    var ri = rItems[i], v = rt[ri.key] || 0, w = tr ? Math.round(v / tr * 100) : 0;
    rhtml += '<div class="ds-rating-row"><span class="ds-r-label" style="width:90px;text-align:left">' + ri.label + '</span><div class="ds-r-bar"><div style="width:' + w + '%;background:' + ri.color + '"></div></div><span class="ds-r-count" style="width:50px">' + v + ' 次</span></div>';
  }
  rhtml += '</div>';
  return '<div class="ds-rating-panel' + collapsed + '">' +
    '<div class="ds-rating-panel-head" onclick="_dsToggleRatingPanel(this)" style="cursor:pointer;user-select:none">' +
    '<span>🏅 全员上级评价分布 <span class="ds-rating-panel-sub">（年度累计）</span></span>' +
    '<span class="ds-rating-panel-toggle">▼ 收起</span>' +
    '</div>' +
    '<div class="ds-rating-panel-body">' + rhtml +
    '<div class="ds-rating-panel-foot">共 <strong>' + tr + '</strong> 次评价</div>' +
    '</div>' +
    '</div>';
}

// ★ V0.6.1.ic: 展开/收起「全员上级评价分布」面板
function _dsToggleRatingPanel(head) {
  var panel = head.parentElement;
  if (!panel) return;
  var isCollapsed = panel.classList.toggle('ds-rating-collapsed');
  var toggle = head.querySelector('.ds-rating-panel-toggle');
  if (toggle) toggle.textContent = isCollapsed ? '▶ 展开' : '▼ 收起';
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

// ===== 占位页面 =====
function _dsBuildDataReport() { return '<div class="ds-grid"><div class="ds-card" style="text-align:center;padding:80px 40px"><div style="font-size:64px;margin-bottom:16px;opacity:.5">🔧</div><div style="font-size:18px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">业务数据报告中</div><div style="font-size:13px;color:var(--text-hint)">该模块正在建设中，敬请期待</div></div></div>'; }
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
window._dsToggleRatingPanel = _dsToggleRatingPanel;
