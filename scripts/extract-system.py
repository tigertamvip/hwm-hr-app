#!/usr/bin/env python3
"""Extract System Maintenance module from app.html"""
import os

SRC = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html'
DST = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/js/modules/system.js'

with open(SRC, 'r') as f:
    lines = f.readlines()

# System maintenance is in its own <script> block at the end
# L15208 (0-idx) to L15694 (0-idx) — JS content between <script> and </script>
SYS_START = 15207  # first JS line (after <script> tag)
SYS_END   = 15694  # last JS line (before </script> tag)

print(f'Start ({SYS_START+1}): {lines[SYS_START][:80].rstrip()}')
print(f'End ({SYS_END+1}): {lines[SYS_END][:80].rstrip()}')

# Extract
sys_body = ''.join(lines[SYS_START:SYS_END+1])

header = """// ===== HWM HR - 系统维护模块 (System Maintenance) =====
// V0.5.77: 从 app.html 独立提取
//
// 依赖: config.js, 主程序 (USERS, currentUser, supabase, HWM_MODULES)
// 导出: sysInitModule(), sysRenderUserTable(), sysCloseModal()
//
// =============================================

"""

with open(DST, 'w') as f:
    f.write(header)
    f.write(sys_body)

# Replace in app.html: the script block becomes a src reference
# Keep the </script> from previous block and <script> opening for PWA
old_block = '<script>\n' + ''.join(lines[SYS_START:SYS_END+1]) + '</script>\n'
new_tag = '<script src="js/modules/system.js"></script>\n'

content = ''.join(lines)
content = content.replace(old_block, new_tag)

with open(SRC, 'w') as f:
    f.write(content)

sys_size = os.path.getsize(DST)
sys_lines = len(sys_body.splitlines())
print(f'\nsystem.js: {sys_size:,} bytes ({sys_lines} lines)')
print('Extraction complete.')
