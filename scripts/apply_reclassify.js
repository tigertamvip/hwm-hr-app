const fs = require('fs');

// Load changes
const changes = JSON.parse(fs.readFileSync(__dirname + '/requirements_changes_v2.json', 'utf-8'));

// Build change map: job_id -> { req_idx: new_category }
const changeMap = {};
for (const c of changes) {
  if (!changeMap[c.job_id]) changeMap[c.job_id] = {};
  changeMap[c.job_id][c.req_idx] = c.new_category;
}

// Load index.html
let html = fs.readFileSync(__dirname + '/../index.html', 'utf-8');

// Find JOBDESC_DATA block
const start = html.indexOf('var JOBDESC_DATA={');
let depth = 0, endIdx = -1;
for (let i = start + 18; i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') {
    if (depth === 0) { endIdx = i; break; }
    depth--;
  }
}

// Extract and eval
const block = html.substring(start, endIdx + 2);
eval(block);

// Apply changes
let applied = 0;
for (const job of JOBDESC_DATA.jobs) {
  const reqMap = changeMap[job.id];
  if (!reqMap) continue;
  for (const [idx, newCat] of Object.entries(reqMap)) {
    if (idx < (job.requirements || []).length) {
      job.requirements[idx].category = newCat;
      applied++;
    }
  }
}

console.log('Applied ' + applied + ' category changes');

// Generate new block
const newBlock = 'var JOBDESC_DATA=' + JSON.stringify(JOBDESC_DATA, null, 2) + ';';

// Replace in html
const newHtml = html.substring(0, start) + newBlock + html.substring(endIdx + 2);

// Write
fs.writeFileSync(__dirname + '/../index.html', newHtml);
console.log('Written index.html, ' + newHtml.length + ' chars');

// Verify
const vStart = newHtml.indexOf('var JOBDESC_DATA={');
let vDepth = 0, vEnd = -1;
for (let i = vStart + 18; i < newHtml.length; i++) {
  if (newHtml[i] === '{') vDepth++;
  else if (newHtml[i] === '}') {
    if (vDepth === 0) { vEnd = i; break; }
    vDepth--;
  }
}
const vBlock = newHtml.substring(vStart, vEnd + 2);
eval(vBlock);

// Count categories
const catCount = {};
JOBDESC_DATA.jobs.forEach(function(j) {
  (j.requirements||[]).forEach(function(r) {
    var cat = r.category || '(空)';
    catCount[cat] = (catCount[cat]||0)+1;
  });
});
console.log('\n最终分类分布:');
Object.entries(catCount).sort(function(a,b){return b[1]-a[1]}).forEach(function(e) {
  console.log('  ' + e[0] + ': ' + e[1] + '条');
});

// Verify HR负责人
var hrJob = JOBDESC_DATA.jobs.find(function(j) { return j.id === 'jd-008'; });
console.log('\n=== 人力资源部负责人 (标准) ===');
(hrJob.requirements||[]).forEach(function(r,i) {
  console.log('  ' + (i+1) + '. [' + r.category + '] ' + (r.content||'').substring(0,60));
});
