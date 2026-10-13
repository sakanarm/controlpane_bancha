# Bancha — Handoff

> อัปเดต: 14 Oct 2026 · สำหรับคนที่มารับงานต่อ
> อ่านลำดับนี้: ไฟล์นี้ → `docs/ROADMAP.md` (ต้องทำอะไรต่อ) → `docs/ARCHITECTURE.md` (ทำไมออกแบบแบบนี้)

---

## 1. Bancha คืออะไร

Control plane กลางของ Data Platform ทำหน้าที่ดูแล **ใคร** (users, groups), **ต่ออะไร** (connections ไป data source, OpenMetadata, Azure AD และ directory อื่น), **แอพไหนมีอยู่** (register และ unregister ตาม Bancha App Contract v1) และ **กระจายข้อมูลเหล่านี้** ไปให้ Arak (Data Access Control), Prajak (Data Quality), OpenMetadata และแอพที่จะตามมา (Likit)

Bancha ไม่ถือ business data เช่น DQ result, policy หรือ lineage (ARCHITECTURE D1)

---

## 2. สถานะตอนนี้

| ส่วน | สถานะ |
|---|---|
| UI | Prototype ครบทุกเมนู หน้าตาแบบ Arak (Untitled UI, font Inter, สีหลัก `#1570ef`) sidebar สี navy มีโลโก้ Arak, Prajak, OpenMetadata (ไฟล์ต้นฉบับใน `prototype/assets/` และฝังเป็น base64 ใน HTML) กระดิ่งแจ้งเตือนเปิดเป็น panel และนับเฉพาะเรื่องที่ยังไม่อ่าน |
| Connections | **ต่อจริง** แบบ read-only ผ่าน `server/server.js` |
| หน้าอื่น (Overview, Users & groups, App registry, Distribution) | ยังเป็น **sample data** ใน HTML |
| Login | ยังเป็น prototype: รหัสอะไรก็ได้ หรือเลือก sample account |
| DB ของ Bancha | ยังไม่มี (`db/schema.sql` เป็นแค่ร่าง) |
| Git | อยู่บน https://github.com/sakanarm/controlpane_bancha branch `main` |
| Prod | Deploy แล้ว 14 Oct 2026: pm2 ชื่อ `bancha` (id 13), `BIND_HOST=0.0.0.0` เข้าได้ที่ http://10.4.155.151:3950/ (แบบเดียวกับ Arak ที่ :8090) `pm2 save` แล้ว ยังไม่มี nginx `/Bancha` |

### ผลการต่อจริง (13 Oct 2026)

| Connection | ผล | หมายเหตุ |
|---|---|---|
| `arakdb` (10.4.155.151:5432/arakdb) | ✅ ผ่าน | PostgreSQL 16.15, user `arak` (ไม่ใช่ superuser), 22 MB, 77 tables (public 67, demo_sales 9, procurement 1) |
| `openmetadata-mfec` (http://10.6.150.110:8585) | ✅ ผ่าน | v2.0.1, 13 users, 13 teams, 114 tables, database services 3 ตัว |
| `employees-sample` (10.6.150.110:5432/employees) | ⏳ ไม่มี password | port เปิดอยู่ทั้งจาก local และ prod |
| `dtp-iprm` (10.6.150.102:55432/iprm) | ⏳ ไม่มี password + ต่อไม่ได้ | port ปิดทั้งจาก local และ prod ต้องเปิด firewall |
| `mfec-entra` (Azure AD) | ⏳ ไม่มี app registration | |
| `mfec-auth-service` (127.0.0.1:3900) | 🟡 health ผ่านจาก prod | ยังไม่มี API key จึงดูได้แค่ `/auth/health` บน local จะขึ้น ECONNREFUSED เพราะฟังแค่ loopback |

รายการของที่ต้องขอเพิ่มอยู่ใน `docs/ROADMAP.md` หัวข้อ Phase 0

---

## 3. File map

```
ControlPane_Bancha/
├─ prototype/control-plane.html   UI ทั้งหมด (HTML + CSS + JS ไฟล์เดียว ไม่มี build)
├─ server/server.js               Node server: เสิร์ฟ UI + API test connection จริง
├─ config/connections.json        รายการ connection (ไม่มี secret มีแค่ชื่อ env var)
├─ deploy/start.sh                entry point ของ pm2 (แบบเดียวกับ Arak)
├─ .env.example                   รายชื่อ env var ทั้งหมด (คัดลอกเป็น .env)
├─ contracts/                     Bancha App Contract v1: schema + manifest ตัวอย่าง
├─ db/schema.sql                  ร่าง schema ของ Phase 1 (ยังไม่ได้ใช้)
└─ docs/                          ARCHITECTURE, ROADMAP, HANDOFF
```

### `server/server.js`

- Node 20, ใช้แค่ `http` ของ Node และ `pg`
- Port `3950` และ bind `127.0.0.1` เป็นค่า default (เปลี่ยนได้ด้วย `PORT`, `BIND_HOST`)
- ตอน start จะ test ทุก connection แล้ว test ซ้ำทุก 5 นาที โดย timeout 8 วินาทีต่อครั้ง
- Routes
  - `GET /` เสิร์ฟ `prototype/control-plane.html`
  - `GET /api/health`
  - `GET /api/connections` ส่ง connection ทั้งหมด พร้อมผล test ล่าสุด, ข้อมูลที่เจอ และ credential ที่ยังขาด
  - `POST /api/connections/:id/test` test ทันที
  - ตัด prefix `/bancha` ออกได้ (case-insensitive) เพื่อรองรับการวางหลัง nginx ที่ `/Bancha/`
- Connector แต่ละประเภท **อ่านอย่างเดียว**
  - PostgreSQL: เปิด session ด้วย `default_transaction_read_only=on` แล้วอ่าน version, size และจำนวน table ต่อ schema
  - OpenMetadata: login แบบ basic (`POST /api/v1/users/login`, password เป็น base64) แล้ว GET จำนวน users/teams/tables และ database services โดย token อยู่ใน memory เท่านั้น
  - Azure AD: client credentials แล้ว GET organization และนับ users/groups
  - auth-service: `GET /auth/health` (ไม่ต้องใช้ key) และถ้ามี key จะ `GET /auth/users` ด้วย `x-api-key`
- เพิ่ม connection ใหม่: เพิ่ม entry ใน `config/connections.json` แล้วเพิ่ม env var ใน `.env.example` ถ้าเป็นประเภทใหม่ให้เพิ่ม function ใน `CONNECTORS`

### `prototype/control-plane.html`

- Sample data อยู่ใน array `USERS`, `GROUPS`, `CONNS`, `APPS` ช่วงต้นของ `<script>`
- ถ้าเปิดผ่าน server (ไม่ใช่ `file://`) จะเรียก `loadLive()` ดึง `api/connections` แล้วแทนที่ `CONNS` ด้วยข้อมูลจริง (`LIVE.on = true` และมุมขวาบนขึ้น "Live · real connections")
- Sidebar อยู่ที่ `navHTML()` และแต่ละหน้าอยู่ใน `PAGES`
- Session เก็บใน `sessionStorage` key `bancha-session`
- Admin คือคนที่อยู่ group `DG-Platform-Admins` หรือ `bg.admin` ส่วนคนอื่นเห็นแค่ My apps
- เปิดหน้าด้วย `?app=arak` ได้ เมื่อ login แล้วจะเด้งไปแอพนั้นเลย

---

## 4. รันบนเครื่อง local

```bash
cd ControlPane_Bancha
npm install
cp .env.example .env      # ใส่ password ที่มี ช่องที่เว้นว่างจะขึ้นเป็น "Needs credentials"
set -a; source .env; set +a
npm start                 # http://127.0.0.1:3950/
```

- Login แบบ prototype ใช้รหัสอะไรก็ได้ ลองใช้ `sakan.pu` (Sakan Punyanon, admin) หรือ `bg.admin` (admin) และ `siriporn.k` (ไม่ใช่ admin) หรือกด "Sign in with MFEC" แล้วเลือก sample account
- เปิดไฟล์ HTML ตรง ๆ ได้ แต่จะเห็นแค่ sample data และไม่มี live connection

---

## 5. Prod (`appadm@10.4.155.151`, hostname pipeappsrv09)

### สิ่งที่สำรวจแล้ว (อ่านอย่างเดียว ไม่ได้แก้อะไร)

- Ubuntu 24.04, node v20.20.0, pm2 6.0.14, psql 16, nginx 1.24
- แอพใน pm2 ของคนอื่น **ห้ามแตะ**: presale-app (3000), wiki-app (8000), dts-workbench (5174), dmhub (6060), flowlio (3001), auth-service (127.0.0.1:3900), pikascrape, msync-timesheet (127.0.0.1:8788), arak (8090 และ 127.0.0.1:8091)
- Port 3950 ไม่ชนกับแอพใน pm2 (ตรวจอีกครั้งก่อน deploy ด้วย `ss -ltn | grep 3950`)
- แบบของ Arak ที่ Bancha ทำตาม
  - `pm2 start ~/Arak/deploy/start.sh --name arak --exp-backoff-restart-delay=3000` แล้ว `pm2 save`
  - Deploy ด้วย `cd ~/Arak && git pull origin main && pm2 restart arak`
  - `start.sh` อ่าน `.env` และไม่ยอม start ถ้าไม่มี `.env`
- Arak ใช้ Entra tenant ของ MFEC และ auth-service กลางอยู่แล้ว (ดูจากชื่อ key ใน `.env.example` ของ Arak เท่านั้น ไม่ได้เปิดอ่าน secret)
- nginx: `/etc/nginx/sites-enabled/unified-proxy` include `/etc/nginx/snippets/apps-locations.conf` เป็นของ root และใช้ร่วมกับทุกแอพ TLS hostname คือ `dmhub.mfec.dev`

### Deploy ครั้งแรก (ทำแล้ว 14 Oct 2026)

```bash
ssh appadm@10.4.155.151
git clone https://github.com/sakanarm/controlpane_bancha.git ~/ControlPane_Bancha
cd ~/ControlPane_Bancha
cp .env.example .env && chmod 600 .env && nano .env
chmod +x deploy/start.sh
pm2 start ~/ControlPane_Bancha/deploy/start.sh --name bancha --exp-backoff-restart-delay=3000
pm2 save
curl -s http://127.0.0.1:3950/api/health
pm2 logs bancha --lines 30
```

Deploy ครั้งต่อไป:

```bash
cd ~/ControlPane_Bancha && git pull origin main && pm2 restart bancha
```

`start.sh` จะรัน `npm ci` ให้เองเมื่อ `package-lock.json` เปลี่ยน

### nginx `/Bancha` (ต้องให้เจ้าของ server ทำ เพราะต้องใช้ sudo และเป็นไฟล์ที่แชร์กัน)

ตัวอย่าง location ที่จะขอให้เพิ่ม:

```nginx
location = /Bancha { return 301 /Bancha/; }
location /Bancha/ {
    proxy_pass http://127.0.0.1:3950/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

UI เรียก API ด้วย relative path (`api/...`) จึงทำงานได้ทั้งที่ root และใต้ `/Bancha/`

ระหว่างรอ ให้เข้าผ่าน SSH tunnel ได้: `ssh -L 3950:127.0.0.1:3950 appadm@10.4.155.151` แล้วเปิด http://127.0.0.1:3950/

---

## 6. กติกาที่ต้องรักษา

1. **ห้ามแก้ของคนอื่น** ทั้งระบบจริงและโฟลเดอร์ของแอพอื่นบน prod ให้ทำงานเฉพาะใน `~/ControlPane_Bancha` อ่านดูวิธีของคนอื่นได้ แต่ห้ามแก้
2. ทุกการต่อไประบบจริงต้อง **read-only** (Postgres ใช้ read-only session และ HTTP ใช้แค่ GET ยกเว้น login ที่ต้องใช้ขอ token)
3. **Secret อยู่ใน `.env` เท่านั้น** ห้าม commit ห้ามเขียนลงไฟล์อื่นหรือ log (server ปิดค่า `password=` ใน error message ไว้แล้ว) ห้ามเปิดอ่าน `.env` ของแอพอื่น
4. ดูบน local ให้เจ้าของงานเห็นก่อน แล้วค่อย push และ deploy โดย **ต้องถามก่อนทุกครั้ง**
5. nginx และ config ที่ใช้ร่วมกันต้องให้เจ้าของ server อนุมัติ

---

## 7. งานถัดไปที่แนะนำ

1. ขอของที่ขาดตาม ROADMAP Phase 0 (0.1–0.7) แล้วใส่ใน `.env` และกด Test all ในหน้า Connections
2. ได้รับอนุมัติแล้วค่อย deploy prod ตามหัวข้อ 5 (ตอนอยู่บน prod จะ test auth-service ได้)
3. เริ่ม Phase 1: ตกลงเรื่อง DB ของ Bancha ก่อน (ROADMAP 1.1) แล้วตามด้วย Azure AD sync เพื่อให้หน้า Users & groups ใช้ข้อมูลจริง

## 8. ความเสี่ยงที่ควรรู้

- Credential หลายตัว (OM, arakdb, Arak admin, SSH) ถูกส่งผ่านแชทระหว่างพัฒนา **ควร rotate**
- ตอนนี้ Bancha ใช้ user ของแอพอื่น (`arak` และ account OM ส่วนตัว) ควรขอ user read-only ของ Bancha เอง
- `prototype/control-plane.html` เป็นไฟล์เดียวขนาดประมาณ 1,700 บรรทัด (รวมโลโก้ base64) เมื่อเข้า Phase 1 ควรแยกเป็น frontend project (เช่น Vite) หรืออย่างน้อยแยก JS ออกมา
