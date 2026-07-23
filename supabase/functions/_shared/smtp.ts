// 共享: SMTP 邮件发送 + 通知开关检查
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SMTP_HOST = "smtp.qiye.aliyun.com";
const SMTP_PORT = 465;
const SMTP_USER = "hwm-ai@hwmeds.com";
// ★ V0.6.3: SMTP 密码从 Supabase Edge Function Secret 读取，不再硬编码 fallback
const _SMTP_PASS = Deno.env.get("SMTP_PASS");
if (!_SMTP_PASS) throw new Error("SMTP_PASS environment variable is not set. Set it in Supabase Dashboard → Edge Functions → Secrets.");

export const SUPABASE_URL = "https://xgysfujnhwgevmojzkbf.supabase.co";
// ★ V0.6.3: Supabase anon key 虽然设计为公开（publishable），但为避免 GitGuardian 告警，也走 env var
export const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_dPt0sB5D8ZQ6ZdHt6wuvyA_MkjOeknx";

const EXCLUDED_NAMES = ["韩铁工", "孙颖", "杨成"];

/** 检查通知是否启用 */
export async function isEmailEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/hwm_settings?key=eq.email_notifications&select=value`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    const rows = await res.json();
    return rows?.[0]?.value?.enabled !== false;
  } catch {
    return true; // 默认启用
  }
}

/** 判断是否排除名单 */
export function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.includes(name);
}

/** ★ V0.6.2: 检查用户个人是否开启邮件通知（从 tiger_buddy_users.user_data.emailEnabled） */
export async function isPersonallyEmailEnabled(name: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tiger_buddy_users?uid=eq.${encodeURIComponent(name)}&select=user_data`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const rows = await res.json();
    const userData = rows?.[0]?.user_data;
    if (!userData) return false; // 用户不存在 = 默认不发送
    return userData.emailEnabled === true;
  } catch {
    return false; // 读取失败默认不发送
  }
}

/** 发送一封 HTML 邮件 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const client = new SMTPClient({
      connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true },
    });
    await client.send({
      from: `MBO+AI 目标计划管理系统 <${SMTP_USER}>`,
      to, subject, html,
    });
    await client.close();
    console.log(`[Mail] 已发送 → ${to} 主题: ${subject}`);
    return true;
  } catch (e) {
    console.error(`[Mail] 发送失败 → ${to}:`, e.message);
    return false;
  }
}
