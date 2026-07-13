// ===== HWM AI 人力资源管理系统配置 =====
// 部署到新客户时，只需修改此文件
//
// 新客户三步走：
//   1. 修改本文件中 [公司品牌] 和 [Supabase] 配置
//   2. 注册独立 Supabase 项目，创建对应数据表
//   3. 部署 app.html 到任意静态托管（GitHub Pages / 腾讯云 COS / Nginx）
//
// =============================================

// ===== 公司品牌 =====
window.APP_CONFIG = {
  company: {
    fullName: '安徽省幸福工场医疗设备有限公司',
    shortName: '幸福工场',
    brandName: 'HWM',
    iconText: 'HWM',
    address: '安徽省合肥市',
    copyright: 'Tiger-Buddy+AI',
  },
  
  // ===== 品牌色 =====
  // 修改以下色号即可切换整个系统的配色方案
  brand: {
    primary:   '#003472',   // 主色（门户卡片/标题/深色背景）
    techBlue:  '#1B6EC4',   // 科技蓝（选中态/高亮/图表线条）
    accent:    '#0F7BE1',   // 强调蓝（按钮/链接/交互反馈）
  },
  
  // ===== AI 助手上下文 =====
  // 给 AI 助手的公司背景介绍，影响智能分析的回答质量
  aiContext: '幸福工场（HWM）为III类医疗器械企业，主营内窥镜和铥激光碎石机，专注泌尿结石解决方案。受集采影响售价下降约50%，2026年预计亏损1700万，与投资人签有2026-2028年业绩对赌协议。公司设SMP→SOP→PD培训体系及酷学院LMS平台（100+视频课）。核心团队：Lara（注册）、徐亮（财务）、周冬林（研发）、Charlie（硬件降本）。',
  
  // ===== 功能模块开关 =====
  // true=显示, false=隐藏。新客户可只买需要的模块
  features: {
    kpi:       true,   // KPI 关键绩效指标
    mbo:       true,   // MBO 目标管理/周计划
    employees: true,   // 员工档案
    policies:  true,   // 制度流程中心
    system:    true,   // 系统维护
    decision:  false,  // 决策数据链（开发中）
    talent:    false,  // 人才盘点（开发中）
    payroll:   false,  // 薪资核算（开发中）
    learning:  false,  // 学习中心（开发中）
    dashboard: false,  // 管理仪表盘（开发中）
    ideas:     false,  // 合理化建议（开发中）
    rdpm:      false,  // 研发PM（开发中）
  },
};

// ===== Supabase 数据库配置 =====
// 每个新客户需注册独立 Supabase 项目，替换以下地址和 Key
var SUPABASE_URL = 'https://xgysfujnhwgevmojzkbf.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_dPt0sB5D8ZQ6ZdHt6wuvyA_MkjOeknx';

// ★ V0.6.1ef: 智能同步 — 跳过无需系统账号的职位（工人/检验员/操作类/生产类等）
// 模糊匹配：position 包含其中任一关键词即跳过
var SKIP_POSITIONS = [
  // 一线生产
  '工人','普工','操作工','装配工','包装工','生产工','车间','产线',
  // 检验/质控
  '检验员','质检','品检','QC','QA','实验室测试',
  // 仓储/物流
  '仓管','仓库','物流','装卸','搬运',
  // 样品/制作
  '样品制作','制作员',
  // 基础文员
  '文员','前台','行政专员',
  // 司机
  '司机',
  // 实习生/学徒
  '实习生','学徒'
];

// ★ V0.6.1ee: 智能同步 — 状态黑名单（这些状态的员工不导入）
var SKIP_STATUS = ['已离职','离职','quit','left','resigned'];

// ★ V0.6.1ee: 智能同步 — 需要保留的状态（只导入在职员工）
var ACTIVE_STATUS = ['已转正','在职','正式','试用','试用期','active'];

// Supabase 数据表名（一般不需要改，除非客户有用到多项目共享表的需求）
var SUPABASE_TABLE = 'hwm_employees';
var SUPABASE_WP_TABLE = 'hwm_workplans';
var SUPABASE_USERS_TABLE = 'hwm_users';
var SUPABASE_JD_TABLE = 'hwm_jobdesc';
var SUPABASE_FAV_TABLE = 'hwm_favorites';
