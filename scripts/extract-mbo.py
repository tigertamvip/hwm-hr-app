#!/usr/bin/env python3
"""Extract MBO module from app.html into js/modules/mbo.js"""
import os

SRC = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html'
DST = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/js/modules/mbo.js'

with open(SRC, 'r') as f:
    lines = f.readlines()

# MBO code boundaries (0-indexed)
MBO_START = 15943   # line 15944 in 1-based = index 15943 in 0-based
MBO_END = 19670     # line 19671 in 1-based = index 19670 in 0-based (exclusive: end of aiAssessWP + blank line)

# Verify the boundaries
print(f'Start line ({MBO_START+1}): {lines[MBO_START][:80].rstrip()}')
print(f'End line ({MBO_END+1}): {lines[MBO_END+1][:80].rstrip()}')

# Extract MBO code
mbo_body = ''.join(lines[MBO_START:MBO_END+2])

# Create mbo.js with header
mbo_header = """// ===== HWM HR - MBO 模块 (Work Plan + 计分 + 协同 + Eisenhower Matrix) =====
// V0.5.75: 从 app.html 独立提取，首次模块拆分
// 
// 依赖（必须在此文件之前加载）：
//   config.js — APP_CONFIG, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_WP_TABLE
//   主程序 — showToast, _showAlert, _showConfirm, supabase, allEmployees, currentUser, USERS
//
// 导出（供后续模块调用）：
//   initWPModule(), renderWPTable(), getISOWeek(), getSubordinates(), _calcWeekScore()
//
// =============================================

"""

with open(DST, 'w') as f:
    f.write(mbo_header)
    f.write(mbo_body)

# Replace MBO code in app.html with script tag
script_tag = '<script src="js/modules/mbo.js"></script>\n'
new_lines = lines[:MBO_START] + [script_tag, '\n'] + lines[MBO_END+2:]

with open(SRC, 'w') as f:
    f.writelines(new_lines)

# Verify
mbo_size = os.path.getsize(DST)
app_size = os.path.getsize(SRC)
print(f'\nmbo.js: {mbo_size:,} bytes ({len(mbo_body.splitlines())} lines)')
print(f'app.html: {app_size:,} bytes ({len(new_lines):,} lines)')
print('Extraction complete.')
