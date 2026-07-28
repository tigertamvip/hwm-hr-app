-- ===== MBO+AI 研发项目管理（Stage-Gate）建表迁移 =====
-- 执行方式：Supabase Dashboard -> SQL Editor -> New query，完整执行本文件。
-- 目标：为 type='研发' 的项目提供阶段门引擎的数据底座（阶段/交付物/评审门）。
-- 依据：《MDR和FDA设计开发流程(1)》P1 方案（rdpm-p1-plan.md）。

-- 阶段实例：每个研发项目固定 7 行（预研/立项/输入/输出/验证/确认/转化）
CREATE TABLE IF NOT EXISTS rd_stages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_key     TEXT NOT NULL,        -- preresearch/initiation/input/output/verification/validation/transfer
  stage_name    TEXT NOT NULL,
  order_index   INT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'locked'
                CHECK (status IN ('locked','active','pending_review','passed','conditional','returned')),
  owner         TEXT DEFAULT '',
  plan_start    DATE,
  plan_end      DATE,
  actual_start  DATE,
  actual_end    DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, stage_key)
);

-- 交付物实例：由流程模板实例化生成（约 55 项/项目）
CREATE TABLE IF NOT EXISTS rd_deliverables (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_id      UUID NOT NULL REFERENCES rd_stages(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,        -- proposal/user_req/dfmea/bom/sop...
  name          TEXT NOT NULL,
  is_key        BOOLEAN NOT NULL DEFAULT true,  -- 关键交付物=评审前置条件
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','submitted','approved','na')),
  owner         TEXT DEFAULT '',
  due_date      DATE,
  version       TEXT DEFAULT '',      -- DMR 版本：1.0/1.1/...（设计输出用）
  iteration     TEXT DEFAULT '',      -- 迭代组标记：1.0/1.1/...（设计输出用）
  file_url      TEXT DEFAULT '',      -- NAS 路径/链接
  note          TEXT DEFAULT '',
  na_reason     TEXT DEFAULT '',      -- 不适用理由（标记 na 时必填）
  na_by         TEXT DEFAULT '',      -- 标记不适用的操作人（留痕）
  na_at         TIMESTAMPTZ,          -- 标记时间（留痕）
  order_index   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 评审门：每阶段 1~3 个；支持临时评审（型检问题立即评审场景）
CREATE TABLE IF NOT EXISTS rd_gates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_id      UUID NOT NULL REFERENCES rd_stages(id) ON DELETE CASCADE,
  gate_key      TEXT NOT NULL,
  gate_name     TEXT NOT NULL,
  is_adhoc      BOOLEAN NOT NULL DEFAULT false,
  iteration     TEXT DEFAULT '',      -- 试产迭代标记（设计输出的 DMR/试产评审用）
  result        TEXT NOT NULL DEFAULT 'pending'
                CHECK (result IN ('pending','passed','conditional','rejected')),
  review_date   DATE,
  attendees     JSONB NOT NULL DEFAULT '[]'::jsonb,
  conclusion    TEXT DEFAULT '',
  action_items  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 有条件通过的整改项（关联 project_tasks）
  reviewed_by   TEXT DEFAULT '',
  order_index   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rd_stages_project       ON rd_stages(project_id, order_index);
CREATE INDEX IF NOT EXISTS idx_rd_deliverables_stage   ON rd_deliverables(stage_id, order_index);
CREATE INDEX IF NOT EXISTS idx_rd_deliverables_project ON rd_deliverables(project_id);
CREATE INDEX IF NOT EXISTS idx_rd_gates_stage          ON rd_gates(stage_id, order_index);
CREATE INDEX IF NOT EXISTS idx_rd_gates_project        ON rd_gates(project_id);

ALTER TABLE rd_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE rd_gates ENABLE ROW LEVEL SECURITY;

-- 与 projects/project_tasks 现有策略保持一致（匿名客户端直连，应用层做权限判断）。
-- 评审结论提交在前端仅限项目负责人（owner/created_by）；交付物更新对项目组开放。
DROP POLICY IF EXISTS "rd_stages_select_all" ON rd_stages;
DROP POLICY IF EXISTS "rd_stages_insert_all" ON rd_stages;
DROP POLICY IF EXISTS "rd_stages_update_all" ON rd_stages;
DROP POLICY IF EXISTS "rd_stages_delete_all" ON rd_stages;
CREATE POLICY "rd_stages_select_all" ON rd_stages FOR SELECT USING (true);
CREATE POLICY "rd_stages_insert_all" ON rd_stages FOR INSERT WITH CHECK (true);
CREATE POLICY "rd_stages_update_all" ON rd_stages FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "rd_stages_delete_all" ON rd_stages FOR DELETE USING (true);

DROP POLICY IF EXISTS "rd_deliverables_select_all" ON rd_deliverables;
DROP POLICY IF EXISTS "rd_deliverables_insert_all" ON rd_deliverables;
DROP POLICY IF EXISTS "rd_deliverables_update_all" ON rd_deliverables;
DROP POLICY IF EXISTS "rd_deliverables_delete_all" ON rd_deliverables;
CREATE POLICY "rd_deliverables_select_all" ON rd_deliverables FOR SELECT USING (true);
CREATE POLICY "rd_deliverables_insert_all" ON rd_deliverables FOR INSERT WITH CHECK (true);
CREATE POLICY "rd_deliverables_update_all" ON rd_deliverables FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "rd_deliverables_delete_all" ON rd_deliverables FOR DELETE USING (true);

DROP POLICY IF EXISTS "rd_gates_select_all" ON rd_gates;
DROP POLICY IF EXISTS "rd_gates_insert_all" ON rd_gates;
DROP POLICY IF EXISTS "rd_gates_update_all" ON rd_gates;
DROP POLICY IF EXISTS "rd_gates_delete_all" ON rd_gates;
CREATE POLICY "rd_gates_select_all" ON rd_gates FOR SELECT USING (true);
CREATE POLICY "rd_gates_insert_all" ON rd_gates FOR INSERT WITH CHECK (true);
CREATE POLICY "rd_gates_update_all" ON rd_gates FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "rd_gates_delete_all" ON rd_gates FOR DELETE USING (true);
