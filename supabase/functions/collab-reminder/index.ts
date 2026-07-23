// 每日 8:00 协同超 24h 未响应提醒
import { isEmailEnabled, isPersonallyEmailEnabled, sendEmail, SUPABASE_ANON_KEY, SUPABASE_URL } from "../_shared/smtp.ts";

Deno.serve(async (_req) => {
  const enabled = await isEmailEnabled();
  if (!enabled) return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });

  const now = new Date();
  const year = now.getFullYear();
  const weekNum = getISOWeek(now) - 1;
  const weekId = `${year}_W${String(weekNum).padStart(2, "0")}`;

  // 查所有员工
  const res = await fetch("https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_employees?select=name,email", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  const employees = await res.json();
  const emailMap: Record<string, string> = {};
  for (const e of employees) { if (e.email) emailMap[e.name] = e.email; }

  const results: string[] = [];
  const threshold = new Date(now.getTime() - 24 * 3600 * 1000); // 24小时前

  for (const emp of employees) {
    if (!emp.email) continue;

    const wpRes = await fetch(
      `https://xgysfujnhwgevmojzkbf.supabase.co/rest/v1/hwm_workplans?select=collab_tasks&username=eq.${encodeURIComponent(emp.name)}&week_id=eq.${weekId}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const plans = await wpRes.json();
    if (!plans?.length) continue;

    const collabTasks = plans[0].collab_tasks || [];
    for (const ct of collabTasks) {
      if (ct.status !== "pending") continue;
      const createdAt = ct.created_at ? new Date(ct.created_at) : new Date(Date.now() - 48 * 3600 * 1000);
      if (createdAt > threshold) continue;

      const fromName = ct.collab_from || "未知同事";
      const toName = emp.name;
      const taskName = ct.content || ct.name || "未命名协同任务";
      const toEmail = emailMap[toName];

      if (!toEmail) continue;
      if (!await isPersonallyEmailEnabled(toName)) continue;

      const html = `<div style="font-family:PingFang SC,Microsoft YaHei,sans-serif;max-width:600px;margin:0 auto">
<h2 style="color:#7C3AED">🤝 协同任务待响应</h2>
<p>${toName} 你好，</p>
<p>来自 <b>${fromName}</b> 的协同任务已超过 24 小时未响应：</p>
<p style="font-size:16px;background:#f5f3ff;padding:12px;border-radius:8px">
  📋 ${taskName}<br>
  ⏰ 创建时间：${createdAt.toLocaleString("zh-CN")}
</p>
<p>👉 <a href="https://hwm.tiger-buddy.com/app.html">立即响应</a></p>
<p style="color:#999;font-size:12px">本邮件系统自动提醒，无需回复。</p>
</div>`;

      await sendEmail(toEmail, `🤝 【MBO+AI 协同】来自 ${fromName} 的协同任务待你回应`, html);
      results.push(`${toName} ← ${fromName}: ${taskName}`);
    }
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
