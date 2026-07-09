#!/usr/bin/env python3
"""Extract full Policies module from app.html"""
import re

SRC = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html'
DST = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/js/modules/policies.js'

with open(SRC, 'r') as f:
    content = f.read()
    lines = content.split('\n')

# Policies starts at the first POLICY_CATEGORIES definition
# Find the opening <script> that contains it
# Pattern: The shared <script> block that starts after kpi.js and contains Policies

# Let me find the boundaries by looking for "人力资源制度模块"
start_marker = "// ===== 人力资源制度模块 — UI Design v2 ====="
start_idx = content.index(start_marker)

# The code before this marker is shared code inside a <script> block
# We need to close the script before Policies and reopen after

# Find the end of Policies code
# Last Policies-related line: initImportButtons function ends around line 15202
end_marker = "// ===== 离职判定规则（唯一权威） ====="
end_idx = content.index(end_marker) if end_marker in content else None

# Actually find where the shared code that's not Policies begins
# After Policies (which ends with initImportButtons), the next code is:
# ...some blank lines...
# </script>
# <script src="js/modules/mbo.js">

# Find the end of initImportButtons function
init_end = content.index("}\n\n\n</script>", start_idx) if "}\n\n\n</script>" in content[start_idx:] else None

# Simpler approach: split at known markers
# The Policies code is in the same script block as shared code
# We need to:
# 1. Close the current script before Policies
# 2. Load policies.js
# 3. Reopen script for remaining shared code

# Insert points (character positions)
prefix = content[:start_idx]
# Backtrack to find where to close the script - look for last non-Policies code
# Find the last function/variable before Policies
before_policies = prefix.rfind('}\n\n')
if before_policies > 0:
    before_policies += 3  # after the last }

# Extract Policies code (from start_marker to just before mbo.js)
# Find where mbo.js is loaded
mbo_pos = content.index('<script src="js/modules/mbo.js"></script>')

# The Policies code goes from start_marker to just before mbo.js
# Find the </script> that closes the current block before mbo.js
script_close = content.rfind('</script>', start_idx, mbo_pos)

# Policies code: from start_marker to the last line before </script>
policies_block = content[start_idx:script_close]

print(f"Policies start: position {start_idx}")
print(f"Script close before mbo: position {script_close}")
print(f"Policies block: {len(policies_block):,} chars")

# Write policies.js
header = """// ===== HWM HR - 制度流程中心模块 (Policies & HR Center) =====
// V0.5.78: 从 app.html 独立提取
//
// 功能:
//   - 员工手册/薪资/绩效/培训/岗位说明书 浏览
//   - PDF 上传/下载/预览
//   - 岗位说明书 Word/Batch 导入
//   - 收藏功能 + 搜索
//   - 联系人力资源
//
// 依赖: config.js, 主程序 (showToast, supabase, allEmployees)
// 导出: initPoliciesModule(), onPoliciesSearch(), switchPolicyCategory()
//
// =============================================

"""

with open(DST, 'w') as f:
    f.write(header)
    f.write(policies_block)
    f.write('\n')

# Rebuild app.html:
# before_policies_pos + \n</script>\n<script src="js/modules/policies.js"></script>\n<script>\n + remaining after script_close
before = content[:before_policies]
after = content[script_close:]

# The script_close is the position of </script>, we need to keep the mbo.js and beyond
new_content = (before + '\n</script>\n<script src="js/modules/policies.js"></script>\n<script>\n' + after)

with open(SRC, 'w') as f:
    f.write(new_content)

policies_lines = policies_block.count('\n') + 2
new_lines = new_content.count('\n')
old_lines = content.count('\n')

print(f'policies.js: {os.path.getsize(DST):,} bytes ({policies_lines} lines)')
print(f'app.html: {old_lines} → {new_lines} lines (-{old_lines - new_lines})')
print('Extraction complete.')

import os
