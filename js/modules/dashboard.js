// ===== HWM HR - 数据中心模块 =====
// V0.6.1.hi: 积分排名 + 提交率统计 + 灵活筛选

var _dsFilter = { scope: 'all', period: 'week', sort: 'score_desc' };
var _dsRankData = [];

function dashboardInit() {
  var dv = document.getElementById('dashboardContent');
  if (!dv) return;
  _dsFilter = { scope: 'all', period: 'week', sort: 'score_desc' };
  dv.innerHTML = _buildDashboardHTML();
  _refreshDashboard();
}

function _h(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function _buildDashboardHTML() {
  // Build scope options from USERS roles + centers
  var scopeOpts = '<option value="all">全部员工</option>';
  var roles = { senior: '高层', middle_manager: '中层（经理级）', center_head: '中心负责人', staff: '普通员工' };
  for (var r in roles) scopeOpts += '<option value="role:' + r + '">' + roles[r] + '</option>';
  // Centers from USERS
  var centers = {};
  for (var k in USERS) {
    if (USERS[k].centerKeyword) centers[USERS[k].centerKeyword] = true;
    if (USERS[k].dept && !USERS[k].centerKeyword) centers[USERS[k].dept] = true;
  }
  scopeOpts += '<option disabled>── 按中心/部门 ──</option>';
  for (var c in centers) scopeOpts += '<option value="center:' + c + '">' + c + '</option>';

  return '<div class="ds-grid">' +
    // Overview Cards
    '<div class="ds-cards-row" id="dsCards">' +
      '<div class="ds-card"><div class="ds-card-num" id="dsMyScore">—</div><div class="ds-card-label">我的净积分</div></div>' +
      '<div class="ds-card"><div class="ds-card-num" id="dsMyRank">—</div><div class="ds-card-label">我的排名</div></div>' +
      '<div class="ds-card"><div class="ds-card-num" id="dsMyMedals">—</div><div class="ds-card-label">奖牌战绩</div></div>' +
      '<div class="ds-card"><div class="ds-card-num" id="dsPlanRate">—</div><div class="ds-card-label">周计划提交率</div></div>' +
      '<div class="ds-card"><div class="ds-card-num" id="dsSumRate">—</div><div class="ds-card-label">周小结提交率</div></div>' +
    '</div>' +
    // Filter Bar
    '<div class="ds-filter-bar">' +
      '<select id="dsScope" class="ds-select" onchange="_dsOnFilter()">' + scopeOpts + '</select>' +
      '<select id="dsPeriod" class="ds-select" onchange="_dsOnFilter()">' +
        '<option value="week">本周</option><option value="month">本月</option><option value="quarter">本季度</option><option value="ytd">年度 YTD</option>' +
      '</select>' +
      '<select id="dsSort" class="ds-select" onchange="_dsOnFilter()">' +
        '<option value="score_desc">积分 ↓</option><option value="score_asc">积分 ↑</option><option value="name">姓名</option><option value="gold_desc">金牌数 ↓</option>' +
      '</select>' +
      '<button class="btn btn-outline btn-sm" onclick="_dsRefresh()" style="margin:0">🔄 刷新排名</button>' +
    '</div>' +
    // Rank Table
    '<div class="ds-table-wrap">' +
      '<table class="ds-table" id="dsRankTable"><thead><tr>' +
        '<th>#</th><th>姓名</th><th>中心/部门</th><th>积分</th><th>🥇</th><th>本周评级</th><th>📈 周趋势</th>' +
      '</tr></thead><tbody id="dsTbody"><tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-hint)">加载排名数据中...</td></tr></tbody></table>' +
    '</div>' +
  '</div>';
}

function _dsOnFilter() {
  _dsFilter.scope = document.getElementById('dsScope').value;
  _dsFilter.period = document.getElementById('dsPeriod').value;
  _dsFilter.sort = document.getElementById('dsSort').value;
  _dsRenderRankTable();
}

function _dsRefresh() {
  var btn = document.querySelector('.ds-filter-bar button');
  if (btn) { btn.textContent = '⏳ 计算中...'; btn.disabled = true; }
  setTimeout(function () {
    _refreshDashboard();
    if (btn) { btn.textContent = '🔄 刷新排名'; btn.disabled = false; }
  }, 100);
}

function _refreshDashboard() {
  // 1. Collect all plan data from localStorage
  var allPlans = {};
  try {
    for (var k in localStorage) {
      if (k.startsWith('hwm_workplans_')) {
        var data = JSON.parse(localStorage.getItem(k) || '{}');
        for (var wk in data) {
          if (!allPlans[wk]) allPlans[wk] = {};
          allPlans[wk][k.replace('hwm_workplans_', '')] = data[wk];
        }
      }
    }
    if (typeof _wpData !== 'undefined' && _wpData) {
      for (var wk2 in _wpData) {
        if (!allPlans[wk2]) allPlans[wk2] = {};
        var userKey = (currentUser && currentUser.name) || 'me';
        if (_wpData[wk2] && _wpData[wk2].name) userKey = _wpData[wk2].name;
        allPlans[wk2][userKey] = _wpData[wk2];
      }
    }
  } catch (e) { console.warn('[DS] localStorage read error:', e); }

  // 2. Compute submission rates for current week
  var now = new Date();
  var currentYear = now.getFullYear();
  var currentWeek = _getISOWeek(now);
  var currentWeekId = currentYear + '-W' + currentWeek;
  var prevWeekId = currentYear + '-W' + (currentWeek - 1);

  var users = {};
  for (var uid in USERS) {
    if (uid === '管理员' || uid === 'admin' || USERS[uid].role === 'admin') continue;
    users[USERS[uid].name || uid] = USERS[uid];
  }

  var planSubmitted = 0, planTotal = 0;
  var sumSubmitted = 0, sumTotal = 0;
  var prevPlanSubmitted = 0, prevPlanTotal = 0;
  var prevSumSubmitted = 0, prevSumTotal = 0;
  var totalUsers = Object.keys(users).length;

  for (var uname in users) {
    planTotal++;
    prevPlanTotal++;
    sumTotal = planTotal;
    prevSumTotal = prevPlanTotal;
    var wp = (allPlans[currentWeekId] && allPlans[currentWeekId][uname]) || {};
    var wpPrev = (allPlans[prevWeekId] && allPlans[prevWeekId][uname]) || {};
    if (wp.submittedAt || wp.firstSubmittedAt) planSubmitted++;
    if (wp.summarySubmittedAt) sumSubmitted++;
    if (wpPrev.submittedAt || wpPrev.firstSubmittedAt) prevPlanSubmitted++;
    if (wpPrev.summarySubmittedAt) prevSumSubmitted++;
  }

  // 3. Compute scores for ranking
  _dsRankData = [];
  for (var uname2 in users) {
    var u = users[uname2];
    var score = _dsCalcUserScore(uname2, allPlans, _dsFilter.period);
    var goldCount = score._gold || 0;
    var netScore = score.net || 0;
    var rating = score.currentRating || '';
    var trend = score.trend || 0;

    _dsRankData.push({
      name: uname2,
      dept: u.dept || u.centerKeyword || '',
      center: u.centerKeyword || u.dept || '',
      role: u.role || '',
      score: netScore,
      gold: goldCount,
      rating: rating,
      trend: trend
    });
  }

  // 4. Update cards
  var myName = (currentUser && currentUser.name) || '';
  var myScore = 0, myRank = '—', myGold = 0;
  // Sort by score desc
  _dsRankData.sort(function (a, b) { return b.score - a.score; });
  for (var ri = 0; ri < _dsRankData.length; ri++) {
    if (_dsRankData[ri].name === myName) {
      myScore = _dsRankData[ri].score;
      myRank = (ri + 1) + '/' + _dsRankData.length;
      myGold = _dsRankData[ri].gold;
      break;
    }
  }

  var planRate = totalUsers > 0 ? Math.round(planSubmitted / totalUsers * 100) + '%' : '—';
  var sumRate = totalUsers > 0 ? Math.round(sumSubmitted / totalUsers * 100) + '%' : '—';

  var cds = document.getElementById('dsCards');
  if (cds) {
    cds.innerHTML =
      '<div class="ds-card"><div class="ds-card-num">' + (myScore >= 0 ? '+' : '') + myScore + '</div><div class="ds-card-label">我的净积分</div></div>' +
      '<div class="ds-card"><div class="ds-card-num">' + myRank + '</div><div class="ds-card-label">我的排名</div></div>' +
      '<div class="ds-card"><div class="ds-card-num">🥇×' + myGold + '</div><div class="ds-card-label">奖牌战绩</div></div>' +
      '<div class="ds-card"><div class="ds-card-num">' + planRate + '</div><div class="ds-card-label">周计划提交率 <span style="font-size:10px;opacity:.6">W' + currentWeek + '</span></div></div>' +
      '<div class="ds-card"><div class="ds-card-num">' + sumRate + '</div><div class="ds-card-label">周小结提交率 <span style="font-size:10px;opacity:.6">W' + currentWeek + '</span></div></div>';
  }

  // 5. Render table
  _dsRenderRankTable();
}

function _dsCalcUserScore(userName, allPlans, period) {
  var net = 0, gold = 0, trend = 0, currentRating = '';
  var now = new Date();
  var year = now.getFullYear();
  var week = _getISOWeek(now);
  var month = now.getMonth() + 1;
  var quarter = Math.ceil(month / 3);

  var thisWeekId = year + '-W' + week;
  var lastWeekId = year + '-W' + (week - 1);
  var thisWeekScore = 0, lastWeekScore = 0;

  for (var wkId in allPlans) {
    var planData = (allPlans[wkId] && allPlans[wkId][userName]) || {};
    if (!planData || !planData.year) continue;

    var parts = wkId.split('-W');
    var wkYear = parseInt(parts[0]);
    var wkNum = parseInt(parts[1]);
    var wkMonth = Math.ceil(wkNum / 4.33);

    // Period filter
    var include = false;
    if (period === 'week') {
      include = (wkId === thisWeekId);
    } else if (period === 'month') {
      include = (wkYear === year && wkMonth === month);
    } else if (period === 'quarter') {
      include = (wkYear === year && Math.ceil(wkMonth / 3) === quarter);
    } else if (period === 'ytd') {
      include = (wkYear === year);
    }

    if (!include) continue;

    // Score from plan data or computed scores
    var ws = 0;
    if (planData._taskScores) {
      for (var ti = 0; ti < planData._taskScores.length; ti++) ws += planData._taskScores[ti] || 0;
    }
    // Rating score
    var ratingMap = { gold: 2, silver: 1, bronze: 0, warn: -1, danger: -2 };
    if (planData.weeklyRating && ratingMap[planData.weeklyRating] !== undefined) {
      ws += ratingMap[planData.weeklyRating];
      gold += (planData.weeklyRating === 'gold' ? 1 : 0);
    }
    if (ws > 0) net += ws;
    else net += ws;

    // Current week rating
    if (wkId === thisWeekId && planData.weeklyRating) {
      currentRating = planData.weeklyRating;
    }

    if (wkId === thisWeekId) thisWeekScore = ws;
    if (wkId === lastWeekId) lastWeekScore = ws;
  }

  trend = thisWeekScore - lastWeekScore;
  return { net: net, _gold: gold, currentRating: currentRating, trend: trend };
}

function _getISOWeek(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function _dsRenderRankTable() {
  var tbody = document.getElementById('dsTbody');
  if (!tbody) return;

  // Filter by scope
  var filtered = _dsRankData.filter(function (r) {
    if (_dsFilter.scope === 'all') return true;
    if (_dsFilter.scope.startsWith('role:')) {
      return r.role === _dsFilter.scope.replace('role:', '');
    }
    if (_dsFilter.scope.startsWith('center:')) {
      var c = _dsFilter.scope.replace('center:', '');
      return r.center === c || r.dept === c;
    }
    return true;
  });

  // Sort
  if (_dsFilter.sort === 'score_desc') filtered.sort(function (a, b) { return b.score - a.score; });
  else if (_dsFilter.sort === 'score_asc') filtered.sort(function (a, b) { return a.score - b.score; });
  else if (_dsFilter.sort === 'name') filtered.sort(function (a, b) { return a.name.localeCompare(b.name); });
  else if (_dsFilter.sort === 'gold_desc') filtered.sort(function (a, b) { return b.gold - a.gold; });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-hint)">暂无数据</td></tr>';
    return;
  }

  var ratingMap = { gold: '🥇', silver: '🥈', bronze: '🥉', warn: '⚠️', danger: '⛔' };
  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var r = filtered[i];
    var trendStr = '';
    if (r.trend > 0) trendStr = '<span style="color:#059669">↗ +' + r.trend + '</span>';
    else if (r.trend < 0) trendStr = '<span style="color:#dc2626">↘ ' + r.trend + '</span>';
    else trendStr = '<span style="color:#9ca3af">→ 0</span>';

    var rankStyle = i === 0 ? 'background:#FFF8E1;font-weight:700;color:#B45309;border-radius:3px;padding:2px 6px' :
      i === 1 ? 'background:#F3F4F6;font-weight:700;color:#6B7280;border-radius:3px;padding:2px 6px' :
        i === 2 ? 'background:#FFF7ED;font-weight:700;color:#D97706;border-radius:3px;padding:2px 6px' : '';

    html += '<tr' + (_dsFilter.period === 'ytd' && i < 3 ? ' style="background:' + (i === 0 ? '#FFFDE7' : i === 1 ? '#F5F5F5' : '#FFF8E1') + '"' : '') + '>' +
      '<td style="text-align:center"><span style="' + rankStyle + '">' + (i + 1) + '</span></td>' +
      '<td><strong>' + _h(r.name) + '</strong></td>' +
      '<td style="font-size:12px;color:var(--text-secondary)">' + _h(r.center || r.dept) + '</td>' +
      '<td style="font-weight:600;color:' + (r.score >= 0 ? '#059669' : '#dc2626') + '">' + (r.score >= 0 ? '+' : '') + r.score + '</td>' +
      '<td style="text-align:center">' + (r.gold > 0 ? '×' + r.gold : '—') + '</td>' +
      '<td style="text-align:center;font-size:18px">' + (ratingMap[r.rating] || '—') + '</td>' +
      '<td>' + trendStr + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

window.dashboardInit = dashboardInit;
window._dsOnFilter = _dsOnFilter;
window._dsRefresh = _dsRefresh;
