#!/usr/bin/env python3
"""Fix system.js extraction — properly remove inline code from app.html"""
import re

SRC = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/app.html'

with open(SRC, 'r') as f:
    content = f.read()

# The system.js inline code is between mbo.js and PWA
# Pattern: <script src="js/modules/mbo.js"></script>\n<script>\n[system code]\n</script>
pattern = r'(<script src="js/modules/mbo\.js"></script>\n)<script>\n.*?</script>\n(<script>\n// PWA)'
replacement = r'\1<script src="js/modules/system.js"></script>\n\2'

new_content = re.sub(pattern, replacement, content, count=1, flags=re.DOTALL)

if new_content == content:
    print("NO MATCH — checking alternate patterns...")
    # Check what comes after mbo.js
    idx = content.find('js/modules/mbo.js')
    if idx >= 0:
        snippet = content[idx:idx+100]
        print(f"After mbo.js: {repr(snippet)}")
else:
    with open(SRC, 'w') as f:
        f.write(new_content)
    old_lines = content.count('\n')
    new_lines = new_content.count('\n')
    print(f"Fixed! {old_lines} → {new_lines} lines (-{old_lines - new_lines})")
