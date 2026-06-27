#!/usr/bin/env python3
"""解析 A-SMP-001岗位说明书 文件夹中所有 docx，生成 JOBDESC_DATA JS 代码"""

import zipfile, xml.etree.ElementTree as ET, re, os, json, sys

NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

# ========== 部门映射（基于编号范围） ==========
DEPT_MAP = {
    '001': '总经办',
    '004': '人力资源部', '005': '人力资源部', '006': '人力资源部',
    '007': '总经办', '008': '人力资源部',
    '010': '生产部', '011': '生产部', '012': '生产部', '013': '生产部',
    '014': '生产部', '015': '生产部', '016': '生产部', '017': '生产部',
    '030': '研发中心', '031': '研发中心', '032': '研发中心', '033': '研发中心',
    '034': '研发中心', '035': '研发中心', '036': '研发中心', '037': '研发中心',
    '038': '研发中心', '039': '研发中心',
    '040': '研发中心', '041': '研发中心', '042': '研发中心', '043': '研发中心',
    '044': '研发中心', '046': '研发中心', '047': '研发中心', '048': '研发中心',
    '050': '供应链', '051': '供应链', '052': '供应链', '053': '供应链', '054': '供应链',
    '060': '质量部', '061': '质量部', '062': '质量部', '063': '质量部',
    '064': '质量部', '065': '质量部', '066': '质量部', '067': '质量部',
    '068': '质量部', '069': '质量部',
    '070': '质量部', '071': '质量部', '072': '总经办', '073': '质量部', '074': '质量部',
    '080': '工程技术部', '081': '工程技术部',
    '090': '销售部', '091': '销售部', '092': '销售部',
    '100': '销售部', '101': '销售部',
    '110': '销售部', '111': '销售部', '112': '销售部', '113': '销售部',
    '114': '销售部', '115': '销售部', '116': '销售部', '117': '销售部',
    '118': '销售部', '119': '销售部',
    '120': '销售部', '121': '销售部', '122': '销售部',
    '130': '注册部', '131': '注册部', '132': '注册部', '133': '注册部',
    '140': '总经办',
    '150': '生产部', '151': '总经办', '152': '质量部', '153': '总经办',
    '154': '供应链', '155': '质量部', '156': '质量部', '157': '研发中心',
    '158': '质量部', '159': '质量部',
    '160': '质量部', '161': '质量部', '162': '质量部', '163': '销售部',
    '164': '研发中心', '165': '销售部', '166': '研发中心',
}

def extract_text(docx_path):
    """从 docx 提取纯文本行"""
    z = zipfile.ZipFile(docx_path)
    xml = z.read('word/document.xml')
    root = ET.fromstring(xml)
    texts = []
    for p in root.iter(f'{{{NS}}}p'):
        line_parts = []
        for t in p.iter(f'{{{NS}}}t'):
            if t.text:
                line_parts.append(t.text)
        line = ''.join(line_parts).strip()
        if line:
            texts.append(line)
    return texts


def parse_job(lines, fname=''):
    """从文本行解析岗位说明书结构化数据"""
    job = {
        'title': '',
        'code': '',
        'version': '1.0',
        'dept': '总经办',
        'issuer': '人力资源部',
        'effectiveDate': '',
        'info': [],
        'duties': [],
        'requirements': [],
        'authority': [],
        'relatedFiles': [],
        'qualityRecords': [],
        'revisionHistory': [],
    }

    full_text = '\n'.join(lines)

    # 文件名称
    m = re.search(r'文件名称\n(.+)', full_text)
    if m:
        job['title'] = m.group(1).strip()

    # 文件编号
    m = re.search(r'文件编号\n(.+)', full_text)
    if m:
        job['code'] = m.group(1).strip()

    # 版本号
    m = re.search(r'版本号\n(.+)', full_text)
    if m:
        job['version'] = m.group(1).strip()

    # 制定部门
    m = re.search(r'制定部门\n(.+)', full_text)
    dept_from_doc = ''
    if m:
        dept_from_doc = m.group(1).strip()

    # 生效日期
    m = re.search(r'生效日期\n(.+)', full_text)
    if m:
        job['effectiveDate'] = m.group(1).strip()

    # ★ 优先从文件名提取编号（文档内容可能写错）
    # 文件名格式: A-SMP-XXX XXX.docx
    # 如果文件名中的编号与内容不同，以文件名为准
    file_code_match = re.search(r'A-SMP-(\d+)', fname) if fname else None
    if file_code_match:
        file_code_num = file_code_match.group(1)
        # 覆盖文档内的编号
        if job['code'] != f'A-SMP-{file_code_num}':
            # print(f'  ⚠️ 编号修正: {job[\"code\"]} → A-SMP-{file_code_num}')
            job['code'] = f'A-SMP-{file_code_num}'

    # 从编号推断部门
    code_num = ''
    if job['code']:
        m = re.search(r'A-SMP-(\d+)', job['code'])
        if m:
            code_num = m.group(1)
            if code_num in DEPT_MAP:
                job['dept'] = DEPT_MAP[code_num]

    # ---- 解析 一、岗位基本信息 ----
    info_start = -1
    info_end = -1
    for i, line in enumerate(lines):
        if '岗位基本信息' in line:
            info_start = i + 1
        if info_start > 0 and ('岗位职责' in line or '二、' in line):
            info_end = i
            break

    if info_start > 0 and info_end > info_start:
        info_lines = lines[info_start:info_end]
        info_text = '\n'.join(info_lines)

        # 提取各类信息
        for label in ['工作地点', '工作时间', '工作场所', '直接上级', '直接下级', '岗位等级']:
            # 在 info_text 中查找标签后的值
            # 标签可能跨行，值可能在标签同一行或下一行
            pattern = re.escape(label)
            match = re.search(pattern + r'\s*\n?\s*(.+)', info_text, re.DOTALL)
            if match:
                val = match.group(1).strip()
                # 截断到下一个标签或空行
                # Clean up checkbox markers □
                val = re.sub(r'□[^\n]*', '', val).strip()
                val = val.split('\n')[0] if '\n' in val else val
                if val and val not in ['□标准工时', '非标准工时', '办公室', '□生产车间', '□其他']:
                    job['info'].append({'label': label, 'value': val})

        # 如果上面的方法没提取到，用逐行匹配
        if not job['info']:
            current_label = None
            for line in info_lines:
                line = line.strip()
                for label in ['工作地点', '工作时间', '工作场所']:
                    if label in line:
                        # 尝试从行中提取值
                        val = line.replace(label, '').replace('：', '').replace(':', '').strip()
                        if val:
                            job['info'].append({'label': label, 'value': val})

    # ---- 解析 二、岗位职责 ----
    duties_start = -1
    duties_end = -1
    for i, line in enumerate(lines):
        if '岗位职责' in line:
            duties_start = i + 1
        if duties_start > 0 and ('任职要求' in line or '三、' in line):
            duties_end = i
            break

    if duties_start > 0 and duties_end > duties_start:
        duty_lines = lines[duties_start:duties_end]
        duties = []
        for line in duty_lines:
            line = line.strip()
            # 跳过明显的章节标题（如"三、任职要求"等）
            if line and len(line) > 3 and not re.match(r'^[一二三四五六七八九十]、', line):
                # Clean up numbering like (1), (2), 1、 etc
                cleaned = re.sub(r'^[\(（]?\d+[\)）]?\s*[、.]?\s*', '', line).strip()
                if cleaned and len(cleaned) > 3:
                    duties.append(cleaned)
        if duties:
            job['duties'] = duties

    # ---- 解析 三、任职要求 ----
    req_start = -1
    req_end = -1
    for i, line in enumerate(lines):
        if '任职要求' in line:
            req_start = i + 1
        if req_start > 0 and ('工作权限' in line or '四、' in line):
            req_end = i
            break

    if req_start > 0 and req_end > req_start:
        req_lines = lines[req_start:req_end]
        req_text = '\n'.join(req_lines)
        # 提取各子项
        sub_items = ['最低学历', '专业要求', '经验要求', '专业知识要求', '专业技能要求', '素质要求', '专业资格及特殊要求']
        for sub in sub_items:
            pattern = re.escape(sub) + r'\s*\n?\s*(.*?)(?=' + '|'.join(re.escape(s) for s in sub_items if s != sub) + r')'
            match = re.search(pattern, req_text, re.DOTALL)
            if match:
                val = match.group(1).strip()
                # Clean up
                val = re.sub(r'^[\s\n]+', '', val)
                val = re.sub(r'[\s\n]+$', '', val)
                if val and len(val) > 1:
                    job['requirements'].append({'category': sub, 'content': val})

        # Fallback: if requirements empty, collect all non-empty lines as single entry
        if not job['requirements']:
            lines_collected = []
            for line in req_lines:
                line = line.strip()
                if line and len(line) > 3:
                    line = re.sub(r'^[\(（]?\d+[\)）]?\s*[、.]?\s*', '', line).strip()
                    if line:
                        lines_collected.append(line)
            if lines_collected:
                job['requirements'].append({'category': '任职要求', 'content': '\n'.join(lines_collected)})

    # ---- 解析 四、工作权限 ----
    auth_start = -1
    auth_end = -1
    for i, line in enumerate(lines):
        if '工作权限' in line:
            auth_start = i + 1
        if auth_start > 0 and ('相关文件' in line or '4 ' in line or '4、' in line):
            auth_end = i
            break

    if auth_start > 0 and auth_end > auth_start:
        auth_lines = lines[auth_start:auth_end]
        for line in auth_lines:
            line = line.strip()
            if line and len(line) > 3:
                job['authority'].append({'category': '工作权限', 'content': line})

    # ---- 解析 4 相关文件 ----
    rel_start = -1
    rel_end = -1
    for i, line in enumerate(lines):
        if re.search(r'^4[、\s]', line) or '相关文件' in line:
            rel_start = i + 1
        if rel_start > 0 and ('质量记录' in line or '5 ' in line or '5、' in line):
            rel_end = i
            break

    if rel_start > 0 and rel_end > rel_start:
        for line in lines[rel_start:rel_end]:
            line = line.strip()
            if line and len(line) > 2 and 'PD-' in line:
                job['relatedFiles'].append(line)

    # ---- 解析 5 质量记录 ----
    qr_start = -1
    qr_end = -1
    for i, line in enumerate(lines):
        if re.search(r'^5[、\s]', line) or '质量记录' in line:
            qr_start = i + 1
        if qr_start > 0 and ('修订记录' in line or '修订' in line):
            qr_end = i
            break
    if qr_start > 0 and qr_end < 0:
        qr_end = len(lines)

    if qr_start > 0 and qr_end > qr_start:
        for line in lines[qr_start:qr_end]:
            line = line.strip()
            if line and len(line) > 2 and line != '无':
                job['qualityRecords'].append(line)

    # ---- 解析修订记录 ----
    rev_start = -1
    for i, line in enumerate(lines):
        if '修订记录' in line:
            rev_start = i + 1
            break

    if rev_start > 0:
        rev_lines = lines[rev_start:]
        # 跳过表头行（章节、版本号、修订摘要等）
        table_header_seen = False
        revisions = []
        for line in rev_lines:
            line = line.strip()
            if not line:
                continue
            if '章节' in line or '版本号' in line or '修订摘要' in line:
                table_header_seen = True
                continue
            # 提取版本号和描述
            ver_match = re.search(r'(\d+\.\d+)', line)
            if ver_match:
                # 尝试找到描述
                desc_parts = re.split(r'\d+\.\d+', line, 1)
                desc = desc_parts[-1].strip() if len(desc_parts) > 1 else ''
                desc = re.sub(r'^[;\s、]+', '', desc)
                if desc:
                    revisions.append(desc)
                elif '新建' in line:
                    revisions.append('新建')

        # Remove duplicates
        seen = set()
        unique_revs = []
        for r in revisions:
            if r not in seen:
                seen.add(r)
                unique_revs.append(r)

        if unique_revs:
            job['revisionHistory'] = [{'description': r} for r in unique_revs]

    return job


def format_js_value(val, indent=0):
    """将 Python 值格式化为 JS 字面量"""
    if val is None or val == '':
        return 'null'
    if isinstance(val, bool):
        return 'true' if val else 'false'
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        escaped = val.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n')
        return f"'{escaped}'"
    if isinstance(val, list):
        if not val:
            return '[]'
        items = []
        for v in val:
            items.append(format_js_value(v, indent + 1))
        if len(items) <= 5 and all(len(i) < 60 for i in items):
            return '[' + ','.join(items) + ']'
        pad = '  ' * (indent + 1)
        inner_pad = '  ' * indent
        return '[\n' + ',\n'.join(f'{pad}{i}' for i in items) + f'\n{inner_pad}]'
    if isinstance(val, dict):
        if not val:
            return '{}'
        pad = '  ' * (indent + 1)
        inner_pad = '  ' * indent
        pairs = []
        for k, v in val.items():
            key_str = f"'{k}'" if not k.isidentifier() else k
            pairs.append(f'{pad}{key_str}:{format_js_value(v, indent + 1)}')
        return '{\n' + ',\n'.join(pairs) + f'\n{inner_pad}}}'
    return 'null'


def main():
    src_dir = '/Users/tigertam/Desktop/A-SMP-001岗位说明书'
    files = sorted([f for f in os.listdir(src_dir) if f.endswith('.docx')])

    jobs = []
    errors = []

    for fname in files:
        path = os.path.join(src_dir, fname)
        try:
            lines = extract_text(path)
            job = parse_job(lines, fname)
            # Generate ID from code
            if job['code']:
                code_match = re.search(r'A-SMP-(\d+)', job['code'])
                if code_match:
                    job['id'] = f"jd-{code_match.group(1)}"
                else:
                    job['id'] = f"jd-{len(jobs)+900}"
            else:
                job['id'] = f"jd-{len(jobs)+900}"

            jobs.append(job)
            print(f"✅ {fname} → {job['id']} | {job['title']} | dept={job['dept']} | duties={len(job['duties'])} | reqs={len(job['requirements'])} | auth={len(job['authority'])} | revs={len(job['revisionHistory'])}")
        except Exception as e:
            errors.append(f"❌ {fname}: {e}")
            print(f"❌ {fname}: {e}")

    print(f"\n总计: {len(jobs)} 个岗位解析成功, {len(errors)} 个失败")

    # 收集所有部门
    depts = sorted(set(j['dept'] for j in jobs))
    print(f"部门列表: {depts}")

    # ---- 生成 JS 代码 ----
    existing_depts = ['全部部门','研发中心','生产部','质量部','销售部','财务部','人力资源部','注册部','工程技术部','总经办']
    all_depts = ['全部部门']
    for d in existing_depts[1:]:  # skip '全部部门'
        if d in depts:
            all_depts.append(d)
    for d in depts:
        if d not in all_depts:
            all_depts.append(d)

    js_lines = []
    js_lines.append('var JOBDESC_DATA={')
    js_lines.append(f"  departments:{format_js_value(all_depts, 1)},")
    js_lines.append('  jobs:[')

    for job in jobs:
        js_lines.append('    {')
        js_lines.append(f"      id:'{job['id']}',dept:'{job['dept']}',title:'{job['title']}',")
        js_lines.append(f"      code:'{job['code']}',version:'{job['version']}',issuer:'{job['issuer']}',effectiveDate:'{job['effectiveDate']}',")

        # info
        if job['info']:
            info_entries = [f"{{label:'{i['label'].replace(chr(39), chr(92)+chr(39))}',value:'{i['value'].replace(chr(39), chr(92)+chr(39))}'}}" for i in job['info']]
            js_lines.append(f"      info:[{','.join(info_entries)}],")
        else:
            js_lines.append('      info:[],')

        # duties
        duty_entries = [f"'{d.replace(chr(39), chr(92)+chr(39)).replace(chr(10), ' ')}'" for d in job['duties']]
        js_lines.append(f"      duties:[{','.join(duty_entries)}],")

        # requirements
        req_entries = [format_js_value(r, 3) for r in job['requirements']]
        js_lines.append(f"      requirements:[{','.join(req_entries)}],")

        # authority
        auth_entries = [format_js_value(a, 3) for a in job['authority']]
        js_lines.append(f"      authority:[{','.join(auth_entries)}],")

        # relatedFiles
        rf_entries = [f"'{f.replace(chr(39), chr(92)+chr(39))}'" for f in job['relatedFiles']]
        js_lines.append(f"      relatedFiles:[{','.join(rf_entries)}],")

        # qualityRecords
        qr_entries = [f"'{q.replace(chr(39), chr(92)+chr(39))}'" for q in job['qualityRecords']]
        js_lines.append(f"      qualityRecords:[{','.join(qr_entries)}],")

        # revisionHistory
        rev_entries = []
        for rev in job['revisionHistory']:
            desc = rev.get('description', '').replace("'", "\\'")
            rev_entries.append(f"{{description:'{desc}'}}")
        js_lines.append(f"      revisionHistory:[{','.join(rev_entries)}]")

        js_lines.append('    },')

    js_lines.append('  ]')
    js_lines.append('};')

    js_code = '\n'.join(js_lines)

    # 写入文件
    out_path = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/scripts/JOBDESC_DATA_generated.js'
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(js_code)
    print(f"\n✅ JS 代码已生成: {out_path}")
    print(f"   文件大小: {len(js_code)} bytes")
    print(f"   部门数: {len(all_depts)}")
    print(f"   岗位数: {len(jobs)}")

    # 也输出 JSON 备用
    json_path = '/Users/tigertam/WorkBuddy/20260414080344/hr-personnel-app/scripts/JOBDESC_DATA.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({'departments': all_depts, 'jobs': jobs}, f, ensure_ascii=False, indent=2)
    print(f"   JSON 已生成: {json_path}")

    return jobs, all_depts


if __name__ == '__main__':
    main()
