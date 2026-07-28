/**
 * MBO+AI 研发项目管理 — 阶段门流程模板
 * 依据：《MDR和FDA设计开发流程(1)》逐项转录（2026-07-28）
 * 结构：7 阶段 × 交付物 × 评审门；设计输出含 11 项 DMR 迭代组
 * 说明：模板升级时递增 RD_TEMPLATE_VERSION，不影响已实例化的项目。
 */

var RD_TEMPLATE_VERSION = '2026-07-28';

// DMR 文件组（设计输出阶段，每次试产迭代成组克隆，版本联动）
var RD_DMR_GROUP = [
  {item_key:'dmr_material_spec', name:'原材料图纸和采购技术要求'},
  {item_key:'dmr_bom',           name:'BOM'},
  {item_key:'dmr_sop',           name:'生产作业指导书'},
  {item_key:'dmr_rework_sop',    name:'返工作业指导书'},
  {item_key:'dmr_process_record',name:'工序记录表'},
  {item_key:'dmr_inspection',    name:'原材料、半成品、成品检验规程和记录表'},
  {item_key:'dmr_prod_equip',    name:'生产设备、工装设计采购'},
  {item_key:'dmr_prod_equip_list',name:'生产设备、工装清单'},
  {item_key:'dmr_insp_equip',    name:'检验设备、工装设计采购'},
  {item_key:'dmr_insp_equip_list',name:'检验设备、工装清单'},
  {item_key:'dmr_product_spec',  name:'产品技术要求'}
];

var RD_TEMPLATE = [
  {
    stage_key:'preresearch', stage_name:'预研', weight:5,
    deliverables:[
      {item_key:'preresearch_report', name:'产品预研报告', is_key:true, note:'做出样品确认技术的可行性'}
    ],
    gates:[
      {gate_key:'preresearch_review', gate_name:'预研评审'}
    ]
  },
  {
    stage_key:'initiation', stage_name:'立项', weight:10,
    deliverables:[
      {item_key:'proposal',   name:'项目建议书',     is_key:true, note:'开会确定正式立项'},
      {item_key:'dev_plan',   name:'设计开发策划书', is_key:true, note:'确定项目组成员、设计开发的各阶段时间范围和适用范围等信息'},
      {item_key:'user_req',   name:'用户需求规格书', is_key:true, note:''},
      {item_key:'risk_plan',  name:'风险管理计划',   is_key:true, note:''}
    ],
    gates:[
      {gate_key:'proposal_review', gate_name:'项目建议书评审'},
      {gate_key:'plan_review',     gate_name:'设计开发策划评审（包含用户规格书，风险计划）'}
    ]
  },
  {
    stage_key:'input', stage_name:'设计输入', weight:15,
    deliverables:[
      {item_key:'input_list', name:'设计开发输入清单',       is_key:true, note:'技术指标，功能性能，安全有效性试验；都需要进行风险分析'},
      {item_key:'prd',        name:'产品需求规格书',         is_key:true, note:''},
      {item_key:'dfmea',      name:'DFMEA',                  is_key:true, note:'活文档，各阶段需更新'},
      {item_key:'pfmea',      name:'PFMEA',                  is_key:true, note:'活文档，各阶段需更新'},
      {item_key:'trace_input',name:'设计开发控制追溯表-输入', is_key:true, note:''}
    ],
    gates:[
      {gate_key:'input_review', gate_name:'设计开发输入评审'}
    ]
  },
  {
    stage_key:'output', stage_name:'设计输出', weight:30,
    deliverables:[
      {item_key:'design_record',   name:'产品设计记录',   is_key:true, note:'结构、硬件、软件，包含ID设计、模具3D的修改；原材料供应商初步确定（接触部分满足生物相容性、ROHS等）；迭代记录存NAS；打样研发组装确定初步工艺，保留生产和检验记录'},
      {item_key:'proto_verify',    name:'样机验证报告',   is_key:true, note:'性能功能摸底，安规和EMC摸底'},
      {item_key:'proto_confirm',   name:'样机确认报告',   is_key:true, note:'通过市场部给临床医生进行评价，有必要需要请医生在动物上实操'},
      {item_key:'mold_10',         name:'开模1.0记录',    is_key:true, note:''},
      // —— DMR 1.0 迭代组（11 项，由 RD_DMR_GROUP 生成，version/iteration='1.0'）——
      {item_key:'transfer_plan',   name:'设计转化计划',   is_key:true, note:''},
      {item_key:'material_purchase',name:'物料采购记录',  is_key:true, note:'包含检验入库'},
      {item_key:'trial_prod_1',    name:'第一次试产工单', is_key:true, note:''},
      {item_key:'pv_master_plan',  name:'过程确认主计划', is_key:true, note:'物料采购需计算PV+DV的样本量'},
      {item_key:'pv_plan',         name:'过程确认方案',   is_key:true, note:''},
      {item_key:'pv_exec',         name:'过程确认执行记录',is_key:true, note:''},
      {item_key:'pv_report',       name:'过程确认报告',   is_key:true, note:''},
      {item_key:'output_list_dmr', name:'设计开发输出清单（DMR）',      is_key:true, note:''},
      {item_key:'output_list_tech',name:'设计开发输出清单（技术文档）',  is_key:true, note:''},
      {item_key:'dfmea_output',    name:'DFMEA（更新）',  is_key:true, note:'活文档'},
      {item_key:'pfmea_output',    name:'PFMEA（更新）',  is_key:true, note:'活文档'}
    ],
    gates:[
      {gate_key:'proto_review',        gate_name:'样机的评审'},
      {gate_key:'premold_review',      gate_name:'开模前的评审'},
      {gate_key:'dmr_review_10',       gate_name:'1.0 DMR评审', iteration:'1.0'},
      {gate_key:'transfer_plan_review',gate_name:'设计转化计划评审'},
      {gate_key:'trial_prod_review_1', gate_name:'第一次试产评审', iteration:'1.0'},
      {gate_key:'dmr_review_n',        gate_name:'n版 DMR评审'},
      {gate_key:'output_review_dmr',   gate_name:'设计开发输出评审（DMR）'},
      {gate_key:'output_review_tech',  gate_name:'设计开发输出评审（技术文档）'}
    ]
  },
  {
    stage_key:'verification', stage_name:'设计验证', weight:20,
    deliverables:[
      {item_key:'dv_master_plan', name:'设计验证主计划',  is_key:true, note:''},
      {item_key:'dv_plan',        name:'设计验证方案',    is_key:true, note:''},
      {item_key:'usability_plan', name:'可用性方案',      is_key:true, note:''},
      {item_key:'dv_sample',      name:'DV样品生产记录',  is_key:true, note:''},
      {item_key:'type_test',      name:'型检报告',        is_key:true, note:'安规、EMC、功能性能、运输、老化、生物相容性，灭菌确认；型检过程中有任何问题需要立即评审，评估对设计开发的影响'},
      {item_key:'dv_report',      name:'设计验证报告',    is_key:true, note:''},
      {item_key:'usability_test', name:'可用性测试记录',  is_key:true, note:''},
      {item_key:'usability_report',name:'可用性报告',     is_key:true, note:''},
      {item_key:'dfmea_dv',       name:'DFMEA（更新）',   is_key:true, note:'活文档'},
      {item_key:'pfmea_dv',       name:'PFMEA（更新）',   is_key:true, note:'活文档'}
    ],
    gates:[
      {gate_key:'dv_plan_review', gate_name:'设计验证方案评审'},
      {gate_key:'dv_review',      gate_name:'设计开发验证评审（包含验证报告）'}
    ]
  },
  {
    stage_key:'validation', stage_name:'设计确认', weight:10,
    deliverables:[
      {item_key:'dval_plan',   name:'设计开发确认方案', is_key:true, note:''},
      {item_key:'dval_report', name:'设计开发确认报告', is_key:true, note:''},
      {item_key:'dfmea_dval',  name:'DFMEA（更新）',    is_key:true, note:'活文档'},
      {item_key:'pfmea_dval',  name:'PFMEA（更新）',    is_key:true, note:'活文档'}
    ],
    gates:[
      {gate_key:'dval_plan_review', gate_name:'设计开发确认方案评审'},
      {gate_key:'dval_review',      gate_name:'设计开发确认评审（包含确认报告）'}
    ]
  },
  {
    stage_key:'transfer', stage_name:'设计转化', weight:10,
    deliverables:[
      {item_key:'risk_report',     name:'风险管理报告',   is_key:true, note:''},
      {item_key:'transfer_summary',name:'设计转化总结报告',is_key:true, note:''},
      {item_key:'dfmea_final',     name:'DFMEA（终版）',  is_key:true, note:'活文档'},
      {item_key:'pfmea_final',     name:'PFMEA（终版）',  is_key:true, note:'活文档'},
      {item_key:'dmr_list',        name:'DMR清单',        is_key:true, note:''},
      {item_key:'dhf_list',        name:'DHF清单',        is_key:true, note:''}
    ],
    gates:[
      {gate_key:'transfer_review', gate_name:'设计转化评审'}
    ]
  }
];

// 试产迭代追加时克隆的内容（版本自动 +0.1）
function rdBuildIterationItems(version){
  var items = [];
  RD_DMR_GROUP.forEach(function(g){
    items.push({item_key:g.item_key, name:g.name, is_key:true, note:'', version:version, iteration:version});
  });
  items.push({item_key:'mold_rev_'+version.replace('.','_'), name:'修改模具'+version+'记录', is_key:true, note:'根据试产情况修改模具和DMR（如有）', version:version, iteration:version});
  items.push({item_key:'trial_prod_'+version.replace('.','_'), name:'试产工单（'+version+'）', is_key:true, note:'', version:version, iteration:version});
  return items;
}
function rdBuildIterationGates(version, trialNo){
  var cn = {'1':'一','2':'二','3':'三','4':'四','5':'五','6':'六','7':'七','8':'八','9':'九','10':'十'};
  var cnNo = cn[String(trialNo)]||String(trialNo);
  return [
    {gate_key:'dmr_review_'+version.replace('.','_'), gate_name:version+' DMR评审', iteration:version},
    {gate_key:'trial_prod_review_'+trialNo, gate_name:'第'+cnNo+'次试产评审', iteration:version}
  ];
}

console.log('[RD-TEMPLATE] loaded V'+RD_TEMPLATE_VERSION+' ('+RD_TEMPLATE.length+' stages)');
