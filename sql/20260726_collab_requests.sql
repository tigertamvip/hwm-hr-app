-- ===== MBO+AI 协同任务根治迁移 =====
-- 执行方式：Supabase Dashboard -> SQL Editor -> New query，完整执行本文件。
-- 目标：协同请求脱离 hwm_workplans.plan_data，A 的撤回状态成为唯一权威来源。

CREATE TABLE IF NOT EXISTS hwm_collab_requests (
  request_id     TEXT PRIMARY KEY,
  owner_uid      TEXT NOT NULL,
  owner_name     TEXT NOT NULL,
  owner_dept     TEXT DEFAULT '',
  receiver_uid   TEXT NOT NULL,
  receiver_name  TEXT DEFAULT '',
  week_id        TEXT NOT NULL,
  owner_task_id  TEXT NOT NULL,
  task_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'rejected', 'revoked')),
  responded_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hwm_collab_receiver_week_active
  ON hwm_collab_requests(receiver_uid, week_id, updated_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hwm_collab_owner_week_active
  ON hwm_collab_requests(owner_uid, week_id, updated_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hwm_collab_owner_task
  ON hwm_collab_requests(owner_uid, week_id, owner_task_id);

ALTER TABLE hwm_collab_requests ENABLE ROW LEVEL SECURITY;

-- 当前系统使用匿名客户端直连且既有业务表采用 allow-all 策略。
-- 这里保持兼容；应用层只允许接收方响应，发起方只创建、更新或撤回自己的请求。
DROP POLICY IF EXISTS "collab_select_all" ON hwm_collab_requests;
DROP POLICY IF EXISTS "collab_insert_all" ON hwm_collab_requests;
DROP POLICY IF EXISTS "collab_update_all" ON hwm_collab_requests;
CREATE POLICY "collab_select_all" ON hwm_collab_requests FOR SELECT USING (true);
CREATE POLICY "collab_insert_all" ON hwm_collab_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "collab_update_all" ON hwm_collab_requests FOR UPDATE USING (true) WITH CHECK (true);

-- Realtime 是即时 UI 刷新的加速层；前端仍会在加载和轮询时向表对账。
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hwm_collab_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 旧模型把协同副本嵌入每个人的周计划 JSON，会被本地缓存整份回写而复活。
-- 新表创建后，清除这些旧运行时副本和旧状态映射；个人 tasks、评价和小结均不受影响。
UPDATE hwm_workplans
SET plan_data = plan_data - 'collab_tasks' - '_collab_statuses',
    updated_at = now()
WHERE plan_data ? 'collab_tasks' OR plan_data ? '_collab_statuses';
