# Track Lap Counter (กล้อง + Supabase)

เว็บแอปนับรอบวิ่งด้วยกล้องมือถือตั้งนิ่ง ตรวจจับการวิ่งผ่านเส้นชัยอัตโนมัติ ถ่ายภาพ + บันทึกเวลาไว้ทุกรอบ
ข้อมูลนักกีฬาและประวัติการวิ่ง sync ขึ้น Supabase ให้อัตโนมัติ

ไฟล์ทั้งหมดเป็น **static site ล้วนๆ** ไม่มีขั้นตอน build เปิด `index.html` ทดสอบตรงๆ ได้เลย

## โครงสร้างไฟล์

```
index.html            หน้าเว็บหลัก (UI, กล้อง, การ์ดต่างๆ)
app.js                ลอจิกทั้งหมด: กล้อง/ตรวจจับ, นักกีฬา, จับเวลา, sync กับ Supabase
config.js             ใส่ Supabase URL / anon key ของคุณตรงนี้
supabase-schema.sql   SQL สร้างตาราง athletes + laps บน Supabase
netlify.toml          ตั้งค่าการ deploy บน Netlify
```

## ขั้นตอนที่ 1 — ตั้งค่า Supabase

1. สร้างโปรเจกต์ที่ [supabase.com](https://supabase.com) (ฟรี)
2. ไปที่ **SQL Editor** วางเนื้อหาทั้งหมดจาก `supabase-schema.sql` แล้วกด **Run**
   จะได้ตาราง `athletes` และ `laps` พร้อม RLS
3. ไปที่ **Project Settings > API** คัดลอก **Project URL** และ **anon public key**
4. แก้ไฟล์ `config.js`:
   ```js
   window.SUPABASE_URL = "https://xxxxxxxx.supabase.co";
   window.SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```

> ถ้ายังไม่ตั้งค่า ปล่อย `config.js` ไว้แบบเดิมได้ — แอปยังใช้งานได้ปกติ
> แต่ข้อมูลจะไม่ถูกบันทึกข้ามการรีเฟรชหน้า (เหมือนเวอร์ชันเดิมที่ไม่มีฐานข้อมูล)

## ขั้นตอนที่ 2 — ขึ้น GitHub

```bash
cd lap-counter-web
git init
git add .
git commit -m "Track Lap Counter"
git branch -M main
git remote add origin https://github.com/<username>/<repo-name>.git
git push -u origin main
```

## ขั้นตอนที่ 3 — Deploy บน Netlify

1. เข้า [app.netlify.com](https://app.netlify.com) ด้วย GitHub
2. **Add new site > Import an existing project** เลือก repo ที่ push ไป
3. **Build command:** ปล่อยว่าง, **Publish directory:** `.`
4. **Deploy site** — ได้ลิงก์ `https://xxxx.netlify.app` ทันที

หลังจากนี้ push โค้ดใหม่ขึ้น GitHub ทีไร Netlify จะ deploy ให้อัตโนมัติ

**สำคัญ:** เว็บที่ deploy แล้วจะให้ HTTPS อัตโนมัติจาก Netlify ซึ่งจำเป็นสำหรับการขอสิทธิ์กล้อง
(เบราว์เซอร์ส่วนใหญ่ไม่อนุญาตให้เปิดกล้องบนหน้าที่ไม่ใช่ HTTPS ยกเว้น localhost)

## วิธีข้อมูลถูกเก็บ

- **นักกีฬา** (`athletes`): ชื่อ/สี ต่อคน ผูกกับ `session_id` ที่สุ่มสร้างและเก็บไว้ใน localStorage
  ของเบราว์เซอร์เครื่องนั้น (คนละเครื่อง/เบราว์เซอร์ = คนละชุดข้อมูล)
- **รอบที่นับได้** (`laps`): ทุกครั้งที่นับรอบ (ทั้งอัตโนมัติและกดเอง) จะถูกส่งขึ้น Supabase ทันที
  พร้อมเวลาแข่ง เวลานาฬิกา และรูปถ่าย (เก็บเป็น base64 ในคอลัมน์ `photo`)
- กด **รีเซ็ตทั้งหมด** จะลบแถวใน `laps` ของเซสชันนั้นบน Supabase ด้วย (นักกีฬาที่เพิ่มไว้จะไม่หาย)
- ถ้า Supabase เชื่อมต่อไม่ได้ชั่วคราว แอปจะยังทำงานต่อได้ในเครื่องนั้น
  (ข้อมูลรอบที่บันทึกไม่สำเร็จจะมี toast แจ้งเตือน)

## ความปลอดภัยของข้อมูล (สำคัญ)

แอปนี้ไม่มีระบบล็อกอิน ใช้ `session_id` แบบสุ่มแยกข้อมูลแต่ละเครื่อง เหมาะกับใช้งานส่วนตัว/ทีมเล็ก
ถ้าต้องการให้โค้ชหลายคนแชร์ข้อมูลเดียวกัน หรือมีระบบบัญชีผู้ใช้จริง แนะนำเพิ่ม
[Supabase Auth](https://supabase.com/docs/guides/auth) แล้วปรับ policy ให้อิงจาก `auth.uid()`

ถ้าต้องการเก็บรูปจำนวนมากในระยะยาว แนะนำย้ายไปใช้ **Supabase Storage** แทนการเก็บ base64
ในตาราง (ตอนนี้เก็บใน DB โดยตรงเพื่อความง่าย เหมาะกับการใช้งานทั่วไป)

## ฟีเจอร์หลัก

- ตั้งกล้องมือถือนิ่ง ปรับตำแหน่งเส้นชัย/ความไว/ระยะกันนับซ้ำได้
- ตรวจจับการเคลื่อนไหวผ่านเส้นอัตโนมัติ ถ่ายภาพ + จับเวลาให้ทันที
- รองรับหลายนักกีฬา พร้อมหน้าต่างเลือกว่าใครวิ่งผ่านเมื่อมีมากกว่า 1 คน
- ปุ่ม +1 กดเองสำรองไว้ทุกคน
- ส่งออกบันทึกทั้งหมดเป็น CSV
- ข้อมูลนักกีฬา + ประวัติการวิ่ง sync ขึ้น Supabase อัตโนมัติ
