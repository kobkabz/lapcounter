-- ==========================================================
-- Track Lap Counter — Supabase schema
-- วิธีใช้: เปิด Supabase Dashboard > SQL Editor > New query
-- วางโค้ดทั้งหมดนี้แล้วกด Run
-- ==========================================================

create extension if not exists pgcrypto;

-- นักกีฬาแต่ละคนในแต่ละเซสชัน (session_id ผูกกับเบราว์เซอร์ของโค้ช/ผู้ใช้)
create table if not exists athletes (
  id uuid primary key,
  session_id text not null,
  name text not null,
  color text not null,
  face_descriptors jsonb not null default '[]'::jsonb, -- ตัวอย่างใบหน้าที่ลงทะเบียนไว้ (สูงสุด 3 ตัวอย่าง/คน)
  created_at timestamptz not null default now()
);
create index if not exists athletes_session_id_idx on athletes (session_id);

-- ถ้าเคยสร้างตาราง athletes ไว้ก่อนหน้านี้แล้ว (ไม่มีคอลัมน์ face_descriptors) ให้รันบรรทัดนี้เพิ่ม:
alter table athletes add column if not exists face_descriptors jsonb not null default '[]'::jsonb;

-- บันทึกทุกครั้งที่นับรอบ (ทั้งแบบมีนักกีฬาและแบบไม่ระบุ)
create table if not exists laps (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  athlete_id uuid references athletes(id) on delete set null,
  athlete_name text not null,
  lap_no integer,
  elapsed_ms integer not null default 0,
  split_ms integer not null default 0,
  wall_time timestamptz not null,
  source text,
  photo text,           -- เก็บรูปเป็น base64 data URL (jpeg คุณภาพย่อ ~20-60KB ต่อรูป)
  created_at timestamptz not null default now()
);
create index if not exists laps_session_id_idx on laps (session_id);
create index if not exists laps_athlete_id_idx on laps (athlete_id);

-- เปิดใช้งาน Row Level Security
alter table athletes enable row level security;
alter table laps enable row level security;

-- นโยบายสำหรับผู้ใช้ทั่วไป (anon key) — ไม่มีระบบล็อกอิน
-- แยกข้อมูลด้วย session_id ที่สร้างแบบสุ่มและเก็บไว้ในเบราว์เซอร์ของแต่ละเครื่อง
-- เหมาะสำหรับเครื่องมือส่วนตัว/ทีมเล็ก ไม่เหมาะกับข้อมูลที่ต้องการความปลอดภัยสูง
-- ถ้าต้องการระบบผู้ใช้จริงในอนาคต ให้เพิ่ม Supabase Auth แล้วเปลี่ยนนโยบายให้อิงจาก auth.uid()

drop policy if exists "allow anon insert athletes" on athletes;
create policy "allow anon insert athletes" on athletes for insert to anon with check (true);
drop policy if exists "allow anon select athletes" on athletes;
create policy "allow anon select athletes" on athletes for select to anon using (true);
drop policy if exists "allow anon delete athletes" on athletes;
create policy "allow anon delete athletes" on athletes for delete to anon using (true);

drop policy if exists "allow anon insert laps" on laps;
create policy "allow anon insert laps" on laps for insert to anon with check (true);
drop policy if exists "allow anon select laps" on laps;
create policy "allow anon select laps" on laps for select to anon using (true);
drop policy if exists "allow anon delete laps" on laps;
create policy "allow anon delete laps" on laps for delete to anon using (true);
