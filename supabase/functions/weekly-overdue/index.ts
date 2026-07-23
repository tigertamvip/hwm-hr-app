// 周一 8:00 已逾期
import { isEmailEnabled, isExcluded, isPersonallyEmailEnabled, sendEmail } from "../_shared/smtp.ts";

Deno.serve(async (_req) => {
  const enabled = await isEmailEnabled();
  if (!enabled) return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });

  const url = "https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_employees?select=name,email";
  const res = await fetch(url, {
    headers: { apikey: "sb_publishable_dPt0sB5D8ZQ6ZdHt6wuvyA_MkjOeknx", Authorization: "Bearer sb_publishable_dPt0sB5D8ZQ6ZdHt6wuvyA_MkjOeknx" },
  });
  const employees = await res.json();

  const now = new Date();
  const year = now.getFullYear();
  const weekNum = getISOWeek(now) - 1;

  const results: string[] = [];
  for (const emp of employees) {
    if (!emp.email || isExcluded(emp.name)) continue;
    if (!await isPersonallyEmailEnabled(emp.name)) continue;
    const weekId = `${year}_W${String(weekNum).padStart(2, "0")}`;

    const wpRes = await fetch(
      `https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_workplans?select=plan_submitted,summary_submitted&username=eq.${encodeURIComponent(emp.name)}&week_id=eq.${weekId}`,
      { headers: { apikey: "sb_publishable_dPt0sB5D8ZQ6ZdHt6wuvyA_MkjOeknx", Authorization: "Bearer sb_publishable_dPt0sB5D8ZQ6ZdHt6wuvyA_MkjOeknx" } }
    );
    const plans = await wpRes.json();
    const planSubmitted = plans?.[0]?.plan_submitted;
    const sumSubmitted = plans?.[0]?.summary_submitted;

    if (planSubmitted && sumSubmitted) continue;

    const missing: string[] = [];
    if (!planSubmitted) missing.push("☐ 下周计划");
    if (!sumSubmitted) missing.push("☐ 上周小结");

    const html = `<div style="font-family:PingFang SC,Microsoft YaHei,sans-serif;max-width:600px;margin:0 auto">
<h2 style="color:#dc2626">⛔ 周报已逾期未提交</h2>
<p>${emp.name} 你好，</p>
<p>上周周报（截止周六 12:00）未提交：</p>
<p style="font-size:18px">${missing.join("<br>")}</p>
<p style="color:#dc2626">📉 积分影响：周计划 -1 + 周小结 -1（累计4次后 -2）</p>
<p>本周是新的开始，请尽快补提。<br>👉 <a href="https://hwm.tiger-buddy.com/app.html">立即提交</a></p>
<p style="color:#999;font-size:12px">本邮件系统自动提醒，无需回复。</p>
</div>`;

    await sendEmail(emp.email, `⛔ 【MBO+AI 周报】上周未提交`, html);
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
