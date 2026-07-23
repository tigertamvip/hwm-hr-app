// 每日 8:00 任务到期提醒
import { isEmailEnabled, isExcluded, isPersonallyEmailEnabled, sendEmail, SUPABASE_ANON_KEY, SUPABASE_URL } from "../_shared/smtp.ts";

Deno.serve(async (_req) => {
  const enabled = await isEmailEnabled();
  if (!enabled) return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });

  // 排除节假日（与系统逻辑一致）
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const holidays = ["2026-01-01","2026-01-02","2026-01-03","2026-02-15","2026-02-16","2026-02-17","2026-02-18","2026-02-19","2026-02-20","2026-02-21","2026-02-22","2026-02-23","2026-04-04","2026-04-05","2026-04-06","2026-05-01","2026-05-02","2026-05-03","2026-05-04","2026-05-05","2026-06-19","2026-06-20","2026-06-21","2026-09-25","2026-09-26","2026-09-27","2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07"];
  if (holidays.includes(dateStr)) {
    return new Response(JSON.stringify({ status: "holiday", date: dateStr }), { status: 200 });
  }

  const year = now.getFullYear();
  const weekNum = getISOWeek(now) - 1;
  const weekId = `${year}_W${String(weekNum).padStart(2, "0")}`;

  const url = "https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_employees?select=name,email";
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  const employees = await res.json();

  const results: string[] = [];
  const deadline = new Date(now.getTime() + 8 * 3600 * 1000); // 8小时后

  for (const emp of employees) {
    if (!emp.email || isExcluded(emp.name)) continue;
    if (!await isPersonallyEmailEnabled(emp.name)) continue;

    const wpRes = await fetch(
      `https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_workplans?select=tasks&username=eq.${encodeURIComponent(emp.name)}&week_id=eq.${weekId}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const plans = await wpRes.json();
    if (!plans?.length) continue;

    const tasks = plans[0].tasks || [];
    const urgent: { name: string; date: string; priority: string }[] = [];
    for (const t of tasks) {
      if (t.status === "已完成" || t.status === "按时完成" || !t.plannedDate) continue;
      const planDate = new Date(t.plannedDate);
      if (planDate <= deadline) {
        const pLabels: Record<string,string> = { a: "重要紧急", b: "重要不急", c: "日常紧急", d: "日常事项" };
        urgent.push({ name: t.content || t.name || "未命名任务", date: t.plannedDate, priority: pLabels[t.priority] || "" });
      }
    }
    if (!urgent.length) continue;

    const taskLines = urgent.map((u, i) => `${i+1}. ${u.name}  ⏰ ${u.date}  ${u.priority}`).join("<br>");

    const html = `<div style="font-family:PingFang SC,Microsoft YaHei,sans-serif;max-width:600px;margin:0 auto">
<h2 style="color:#f59e0b">⏰ 任务即将到期提醒</h2>
<p>${emp.name} 你好，</p>
<p>以下 <b>${urgent.length}</b> 项任务距截止不足 8 小时：</p>
<p style="font-size:15px">${taskLines}</p>
<p>👉 <a href="https://hwm.tiger-buddy.com/app.html">立即处理</a></p>
<p style="color:#999;font-size:12px">本邮件系统自动提醒，无需回复。</p>
</div>`;

    await sendEmail(emp.email, `⏰ 【MBO+AI 任务提醒】${urgent.length} 项任务今日到期`, html);
    results.push(`${emp.name}: ${urgent.length} tasks`);
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
