#!/usr/bin/env python3
"""商业化改造脚本 — 品牌配置化 + CSS 变量 + 文字替换"""
import re

with open('/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html', 'r') as f:
    content = f.read()

changes = 0

# === 1. 注入 CSS 变量声明 ===
old_init = "var supabase=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);"
new_init = """var supabase=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);

// ===== V0.5.74: 品牌 CSS 变量注入（切换客户品牌只需改 config.js） =====
(function injectBrandVars(){
  var c=window.APP_CONFIG.brand;
  var r=document.documentElement.style;
  r.setProperty('--brand-primary',c.primary);
  r.setProperty('--brand-tech',c.techBlue);
  r.setProperty('--brand-accent',c.accent);
  var hexToRgb=function(hex){var h=hex.replace('#','');return parseInt(h.substring(0,2),16)+','+parseInt(h.substring(2,4),16)+','+parseInt(h.substring(4,6),16);};
  r.setProperty('--brand-primary-rgb',hexToRgb(c.primary));
  r.setProperty('--brand-accent-rgb',hexToRgb(c.accent));
})();"""
if old_init in content:
    content = content.replace(old_init, new_init)
    changes += 1
    print('1. CSS variable injection: OK')
else:
    print('1. CSS variable injection: FAILED - pattern not found')

# === 2. CSS 品牌色替换（仅在 <style> 块内） ===
style_start = content.index('<style>')
style_end = content.index('</style>', style_start)
style_block = content[style_start:style_end]

css_changes = 0
new_style = style_block
for old_color, var_name in [
    ('#003472', 'var(--brand-primary)'),
    ('#1B6EC4', 'var(--brand-tech)'),
    ('#0F7BE1', 'var(--brand-accent)'),
]:
    count = new_style.count(old_color)
    if count > 0:
        new_style = new_style.replace(old_color, var_name)
        css_changes += count
        print(f'   {old_color} -> {var_name}: {count} occurrences')

content = content[:style_start] + new_style + content[style_end:]
print(f'2. CSS color replacement: {css_changes} total')

# === 3. 品牌文字配置化 ===

# 3a. Portal 标题
content = content.replace(
    '<h2>幸福工场AI辅助信息管理系统</h2>',
    '<h2 id="portal-title"></h2>'
)
changes += 1

# 3b. Footer copyright
content = content.replace(
    '&copy; 安徽省幸福工场医疗设备有限公司 版权所有',
    '<span id="footer-copy">&copy; 安徽省幸福工场医疗设备有限公司 版权所有</span>'
)
changes += 1

# 3c. 品牌文本注入函数（在 pdf.js worker 之后）
old_pdf_worker = "// ===== pdf.js worker 配置 ====="
new_pdf_worker = old_pdf_worker + """
// V0.5.74: 品牌文本注入（从 APP_CONFIG 读取，切换客户只需改 config.js）
(function setBrandTexts(){
  var c=window.APP_CONFIG.company;
  var t=document.getElementById('portal-title');
  if(t)t.textContent=c.shortName+'AI\u8f85\u52a9\u4fe1\u606f\u7ba1\u7406\u7cfb\u7edf';
  var f=document.getElementById('footer-copy');
  if(f)f.textContent='\u00a9 '+c.copyright+' \u7248\u6743\u6240\u6709';
})();"""
content = content.replace(old_pdf_worker, new_pdf_worker)
changes += 1

# 3d. 制度流程中心地址
old_addr = "地址：安徽省合肥市 · 幸福工场医疗设备有限公司"
new_addr = "'+window.APP_CONFIG.company.address+' \u00b7 '+window.APP_CONFIG.company.fullName+'"
if old_addr in content:
    content = content.replace(old_addr, new_addr)
    changes += 1
    print('3d. Policy address: OK')
else:
    print('3d. Policy address: not found (may be in data file)')

# 3e. AI 上下文
old_ai = "var AI_ASSIST_CONTEXT='幸福工场（HWM）为III类医疗器械企业，主营内窥镜和铥激光碎石机，专注泌尿结石解决方案。受集采影响售价下降约50%，2026年预计亏损1700万，与投资人签有2026-2028年业绩对赌协议。公司设SMP→SOP→PD培训体系及酷学院LMS平台（100+视频课）。核心团队：Lara（注册）、徐亮（财务）、周冬林（研发）、Charlie（硬件降本）。';"
new_ai = "var AI_ASSIST_CONTEXT=window.APP_CONFIG.aiContext;"
if old_ai in content:
    content = content.replace(old_ai, new_ai)
    changes += 1
    print('3e. AI context: OK')
else:
    print('3e. AI context: NOT FOUND')

# 3f. JD AI 提示
old_jd_tip = "基于幸福工场（III类器械·集采降价·业绩对赌）的实际情况生成"
if old_jd_tip in content:
    content = content.replace(old_jd_tip, "'+window.APP_CONFIG.company.shortName+'的实际情况生成")
    changes += 1
    print('3f. JD tip: OK')
else:
    print('3f. JD tip: not found')

print(f'\nTotal changes: {changes} script-level + {css_changes} CSS-level')

with open('/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html', 'w') as f:
    f.write(content)
print('File saved successfully.')
