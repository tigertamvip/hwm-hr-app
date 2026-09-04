-- 季度之星（V0.7.1fs 建表 + V0.7.1fu 点赞列）
-- 在 Supabase SQL Editor 执行一次即可（已建过表的只跑最后一行 ALTER 即可）
create table if not exists hwm_quarter_stars (
  id bigint generated always as identity primary key,
  quarter text not null,           -- 例如 '2026-Q3'
  slot int not null,               -- 1..4
  name text not null,
  dept text default '',
  story text default '',           -- ≤50 字
  photo text default '',           -- 400x400 WebP base64 dataURL
  likes int default 0,             -- 点赞数（V0.7.1fu）
  updated_at timestamptz default now()
);
create unique index if not exists hwm_quarter_stars_qs on hwm_quarter_stars(quarter, slot);

alter table hwm_quarter_stars enable row level security;
create policy "allow_all" on hwm_quarter_stars for all using (true) with check (true);

-- 已建过表的补点赞列：
alter table hwm_quarter_stars add column if not exists likes int default 0;
