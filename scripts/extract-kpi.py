#!/usr/bin/env python3
"""Extract KPI module from app.html into js/modules/kpi.py"""
import os

SRC = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html'
DST = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/js/modules/kpi.js'

with open(SRC, 'r') as f:
    lines = f.readlines()

# KPI code boundaries (0-indexed)
KPI_START = 3602   # line 3603 (1-based) = '// ===== KPI 模块 ====='
KPI_END   = 4343   # line 4344 (1-based) = blank line after last KPI function's }

# Verify
print(f'Start line {KPI_START+1}: {lines[KPI_START][:80].rstrip()}')
print(f'End line {KPI_END+1}: {lines[KPI_END][:80].rstrip()}')

# Extract KPI code
kpi_body = ''.join(lines[KPI_START:KPI_END+1])

# Create kpi.js
header = """// ===== HWM HR - KPI 模块 (关键绩效指标) =====
// V0.5.76: 从 app.html 独立提取
// 
// 依赖（必须在此文件之前加载）：
//   config.js — APP_CONFIG
//   主程序 — showToast, _showAlert, _showConfirm, allEmployees, currentUser, USERS
//
// 导出（供后续模块调用）：
//   loadKPIModule(), renderKPI(), getKPISubordinates()
//
// =============================================

"""

with open(DST, 'w') as f:
    f.write(header)
    f.write(kpi_body)

# Replace in app.html: close script, add kpi.js, reopen script
script_tag = '</script>\n<script src="js/modules/kpi.js"></script>\n<script>\n'
new_lines = lines[:KPI_START] + [script_tag] + lines[KPI_END+1:]

with open(SRC, 'w') as f:
    f.writelines(new_lines)

kpi_size = os.path.getsize(DST)
app_size = os.path.getsize(SRC)
kpi_lines = len(kpi_body.splitlines())
app_lines = len(new_lines)
print(f'\nkpi.js: {kpi_size:,} bytes ({kpi_lines} lines)')
print(f'app.html: {app_size:,} bytes ({app_lines:,} lines)')
print(f'Reduction: {kpi_lines} lines extracted')
print('Extraction complete.')
