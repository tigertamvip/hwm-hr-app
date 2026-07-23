// 周六 10:00 周报预警
import { isEmailEnabled, isExcluded, isPersonallyEmailEnabled, sendEmail, SUPABASE_ANON_KEY, SUPABASE_URL } from "../_shared/smtp.ts";

Deno.serve(async (_req) => {
  const enabled = await isEmailEnabled();
  if (!enabled) return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });

  // 查询上周未提交计划的员工
  const url = "https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_employees?select=name,email";
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  const employees = await res.json();

  const now = new Date();
  const year = now.getFullYear();
  const weekNum = getISOWeek(now) - 1; // 上周

  const results: string[] = [];
  for (const emp of employees) {
    if (!emp.email || isExcluded(emp.name)) continue;
    if (!await isPersonallyEmailEnabled(emp.name)) continue;
    const weekId = `${year}_W${String(weekNum).padStart(2, "0")}`;

    // 查是否已提交
    const wpRes = await fetch(
      `${SUPABASE_URL}/rest/v1/hwm_workplans?select=plan_submitted,summary_submitted&username=eq.${encodeURIComponent(emp.name)}&week_id=eq.${weekId}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const plans = await wpRes.json();
    const planSubmitted = plans?.[0]?.plan_submitted;
    const sumSubmitted = plans?.[0]?.summary_submitted;

    if (planSubmitted && sumSubmitted) continue; // 都提交了，跳过

    const missing: string[] = [];
    if (!planSubmitted) missing.push("☐ 下周计划");
    if (!sumSubmitted) missing.push("☐ 上周小结");

    const html = `<div style="font-family:PingFang SC,Microsoft YaHei,sans-serif;max-width:600px;margin:0 auto">
<h2 style="color:#3B7DB4">⚠️ 周报提交提醒</h2>
<p>${emp.name} 你好，</p>
<p>温馨提醒：12:00 截止前你还有以下未提交：</p>
<p style="font-size:18px">${missing.join("<br>")}</p>
<p>⏰ 剩余 <b>2 小时</b></p>
<p>👉 <a href="https://hwm.tiger-buddy.com/app.html">立即提交</a></p>
<p style="color:#999;font-size:12px">本邮件系统自动提醒，无需回复。</p>
</div>`;

    await sendEmail(emp.email, `⚠️ 【MBO+AI 周报】还有 2 小时提交截止`, html);
    results.push(`${emp.name}: ${missing.join(", ")}`);
  }

  return new Response(JSON.stringify({ status: "ok", sent: results.length, details: results }), { status: 200 });
});

function getISOWeek(d: Date): number {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
