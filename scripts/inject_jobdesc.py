#!/usr/bin/env python3
"""将生成的 JOBDESC_DATA 替换到 index.html 并更新 _selectedJobId"""

import re, shutil

INDEX = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/index.html'
GEN_JS = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/scripts/JOBDESC_DATA_generated.js'

with open(GEN_JS, 'r', encoding='utf-8') as f:
    new_data = f.read()

with open(INDEX, 'r', encoding='utf-8') as f:
    html = f.read()

# 备份原文件
shutil.copy2(INDEX, INDEX + '.bak_v56')

# 找到旧 JOBDESC_DATA 的范围并替换
old_start = html.find('var JOBDESC_DATA={')
old_end = html.find('};', old_start + 100) + 2  # include };

if old_start < 0 or old_end < 2:
    print('❌ 找不到旧的 JOBDESC_DATA')
    exit(1)

# 确保 new_data 以 var JOBDESC_DATA= 开头
new_data = new_data.strip()

# 替换
html_new = html[:old_start] + new_data + '\n' + html[old_end:]

# 验证
if 'var JOBDESC_DATA={' not in html_new:
    print('❌ 替换失败: 新数据不包含 JOBDESC_DATA')
    exit(1)

# 确保 _selectedJobId 指向一个有效岗位（jd-001）
html_new = html_new.replace("_selectedJobId='jd-001'", "_selectedJobId='jd-001'")
# 确保部门筛选默认值不变
html_new = html_new.replace("_jdFilteredDept='全部部门'", "_jdFilteredDept='全部部门'")

with open(INDEX, 'w', encoding='utf-8') as f:
    f.write(html_new)

print(f'✅ 替换完成')
print(f'   旧数据: {old_end - old_start} bytes')
print(f'   新数据: {len(new_data)} bytes')
print(f'   总大小: {len(html_new)} bytes')
