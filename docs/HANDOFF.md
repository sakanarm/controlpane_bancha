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
| Users & groups | ใช้ **DB ของ Bancha** เมื่อตั้ง `BANCHA_DB_NAME` (เพิ่ม/แก้/ปิด/ลบ user, group, สมาชิก, role แล้ว push เข้า Arak เอง) ถ้าไม่มี DB ยังเป็น sample data แท็บ Across apps อ่านจาก Arak และ OM จริง |
| หน้าอื่น (Overview, App registry, Distribution) | ยังเป็น **sample data** ใน HTML |
| Login | ด้วยบัญชี Arak รับเฉพาะ `PLATFORM_ADMIN` (`server/auth.js`) ส่วน Sign in with MFEC รอ Azure AD |
| DB ของ Bancha | Migration และ admin API พร้อมแล้ว ทดสอบกับ Postgres local บน prod **ยังไม่มี** database `bancha` รอเจ้าของ Postgres สร้าง (หัวข้อ 5 "DB ของ Bancha") ระหว่างนี้ prod ตอบ 503 ที่ `/api/v1/admin` และหน้า Users & groups เป็น sample data |
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
├─ server/arak-push.js            push user, group, role, connection เข้า Arak ผ่าน admin API (--plan/--apply/--undo)
├─ server/arak-push.test.json     ชุดทดสอบ bancha-test* ที่ลองบน prod แล้ว
├─ server/arak-sync-account.js    สร้างบัญชี bancha-sync ใน Arak และเขียน login ลง .env
├─ server/auth.js                 login ของคอนโซล: ตรวจรหัสกับ Arak รับเฉพาะ PLATFORM_ADMIN, session ใน memory
├─ server/arak-sync.js            ให้ server รัน arak-push --apply เอง (start, ไฟล์เปลี่ยน, DB เปลี่ยน, ทุกคืน)
├─ server/db.js                   pool ของ DB Bancha + รัน migration (`node server/db.js [--status]`)
├─ server/admin-api.js            /api/v1/admin: users, groups, members, role bindings, apps, audit
├─ server/arak-desired.js         อ่าน DB แล้วบอกว่า Arak ควรมีอะไร รวมถึงสิ่งที่ต้องเอาคืน
├─ server/manifests.js            อ่าน manifest ใน contracts/examples (app และ role ที่ให้ได้)
├─ config/arak.json               สิ่งที่ Bancha push เข้า Arak อัตโนมัติ (ตอนนี้แค่ connection)
├─ config/connections.json        รายการ connection (ไม่มี secret มีแค่ชื่อ env var)
├─ deploy/start.sh                entry point ของ pm2 (แบบเดียวกับ Arak)
├─ .env.example                   รายชื่อ env var ทั้งหมด (คัดลอกเป็น .env)
├─ contracts/                     Bancha App Contract v1: schema + manifest ตัวอย่าง
├─ db/migrations/                 schema ของ DB Bancha (001_init.sql) รันตามลำดับ ห้ามแก้ไฟล์ที่รันไปแล้ว ให้เพิ่มไฟล์ใหม่
└─ docs/                          ARCHITECTURE, ROADMAP, HANDOFF
```

### `server/server.js`

- Node 20, ใช้แค่ `http` ของ Node และ `pg`
- Port `3950` และ bind `127.0.0.1` เป็นค่า default (เปลี่ยนได้ด้วย `PORT`, `BIND_HOST`)
- ตอน start จะ test ทุก connection แล้ว test ซ้ำทุก 5 นาที โดย timeout 8 วินาทีต่อครั้ง
- Routes
  - `GET /` เสิร์ฟ `prototype/control-plane.html`
  - `GET /api/health`
  - `GET /api/session`, `POST /api/login`, `POST /api/logout` login ด้วยบัญชี Arak (`server/auth.js`) route อื่นใต้ `/api/` ตอบ 401 ถ้ายังไม่ login และ POST จากเว็บอื่นตอบ 403
  - `GET /api/connections` ส่ง connection ทั้งหมด พร้อมผล test ล่าสุด, ข้อมูลที่เจอ และ credential ที่ยังขาด
  - `POST /api/connections/:id/test` test ทันที
  - `GET /api/arak-sync` สถานะ push อัตโนมัติเข้า Arak: เปิดอยู่ไหม, ไฟล์ที่ดู, รอบถัดไป และผลรอบล่าสุด (ไม่มี secret)
  - `GET /api/db` สถานะ DB ของ Bancha (เปิดไหม, พร้อมไหม, migration ที่รันแล้ว)
  - `/api/v1/admin/*` admin API (`server/admin-api.js` มีรายการ route ที่หัวไฟล์) ทุก write ลง `audit_log` และ `change_log` ใน transaction เดียวกัน แล้วสั่ง push เข้า Arak ภายในไม่กี่วินาที ถ้า DB ยังไม่พร้อมตอบ 503
  - `GET /api/identity` user ของ Arak (`principal` พร้อม attribute, group และ role ที่มี scope) และ OpenMetadata (users API) จับคู่ด้วย email อ่านซ้ำทุก 5 นาทีหลัง test connection ใส่ `?refresh` เพื่ออ่านทันที ถ้าอ่านแอพไหนไม่ได้จะใช้รายชื่อล่าสุดที่อ่านได้ **มีชื่อและอีเมลจริง**
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
- `loadIdentity()` ดึง `api/identity` แล้วเปิดแท็บ **Across apps** ใน Users & groups (`matchView()`)
  - ตาราง field mapping อยู่ใน `XFIELDS`, ของที่แอพเก็บเองใน `XKEEP`, role ของ Arak ใน `XROLES` ต้องตรงกับ ARCHITECTURE §3.5 และ manifest ใน `contracts/`
  - คลิกชื่อคนเปิด `xuserDrawer()` พรีวิว event ที่จะส่ง เป็นพรีวิวเท่านั้น ไม่ส่งอะไรออกไป
- Prod เปิดผ่าน http ธรรมดาบน IP ไม่ใช่ secure context: ห้ามใช้ `crypto.randomUUID`, `crypto.subtle`, `navigator.clipboard` โดยไม่มี fallback (เคยทำให้หน้าขาวทั้งหน้า) หลัง deploy ให้เปิดเช็คจาก URL จริง ไม่ใช่แค่ localhost
- DB mode: `loadDb()` เช็ค `api/db` ถ้าพร้อมจะโหลด user, group, app, role binding ลง `BDB` แล้วหน้า Users & groups ใช้ `dbIdentity()` แทน sample data drawer ต่าง ๆ ชื่อขึ้นต้นด้วย `db` (`dbUserDrawer`, `dbGroupDrawer`, `dbGrantDrawer`) ฟอร์มส่งผ่าน `dbSubmit()` และหลังแก้จะดูผล push เข้า Arak ด้วย `dbWatchSync()`
- Sidebar อยู่ที่ `navHTML()` และแต่ละหน้าอยู่ใน `PAGES`
- Login: ถ้าเปิดผ่าน server ที่ `BANCHA_AUTH=arak` (default) หน้า login จะส่งรหัสไป `api/login` และไม่มีปุ่ม MFEC (`AUTH.mode = 'arak'`, คนที่ login แล้วสร้างด้วย `arakUser()` ไม่ได้อยู่ใน `USERS`) ถ้าเปิดเป็น `file://` หรือ `BANCHA_AUTH=off` จะใช้ sample account แบบเดิม และ session อยู่ใน `sessionStorage` key `bancha-session`
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
- DB ของ Bancha บน local: ต้องมี Postgres 15+ ที่สร้าง role และ database ไว้ (เหมือนหัวข้อ 5 "DB ของ Bancha") แล้วใส่ `BANCHA_DB_*` ใน `.env` server จะ migrate เอง ไม่ใส่ก็ได้ หน้า Users & groups จะเป็น sample data
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

### Push เข้า Arak (ARCHITECTURE §3.6)

บัญชี `bancha-sync` สร้างแล้วบน prod และ login อยู่ใน `.env` ของ Bancha (`ARAK_URL`, `ARAK_USER`, `ARAK_PASSWORD`) ไม่ต้องใช้รหัส admin อีก

```bash
cd ~/ControlPane_Bancha && set -a && . ./.env && set +a
node server/arak-push.js server/arak-push.test.json            # --plan: พิมพ์สิ่งที่จะทำ ไม่แก้อะไร
node server/arak-push.js server/arak-push.test.json --apply
node server/arak-push.js server/arak-push.test.json --undo     # ถอนของที่ไฟล์นี้ใส่
```

Push อัตโนมัติเปิดด้วย `ARAK_SYNC_FILE=config/arak.json` ใน `.env` (เปิดแล้วบน prod) แก้ `config/arak.json` หรือ `config/connections.json` แล้ว `git pull` บน prod ไม่ต้อง restart server จะ push เองภายในไม่กี่วินาที

ถ้าต้องสร้าง `bancha-sync` ใหม่ (Arak ตัวอื่น หรือเปลี่ยนรหัส) ส่งรหัส admin ทาง stdin ไม่ต้องเขียนลงไฟล์:
`printf '%s
' '<admin password>' | ARAK_ADMIN_USER=admin node server/arak-sync-account.js [--rotate]`

### DB ของ Bancha (ROADMAP 1.1, รอเจ้าของ Postgres)

เจ้าของ Postgres บน 10.4.155.151 (superuser) รันทีละคำสั่ง:

```sql
CREATE ROLE bancha LOGIN PASSWORD '<รหัสใหม่>';
CREATE DATABASE bancha OWNER bancha;
REVOKE ALL ON DATABASE bancha FROM PUBLIC;
```

ถ้า `pg_hba.conf` ไม่รับ user ใหม่จาก 127.0.0.1 ให้เพิ่ม `host bancha bancha 127.0.0.1/32 scram-sha-256` แล้ว reload role `bancha` ไม่ต้องเป็น superuser และไม่ต้องมี CREATEROLE ส่วน `pgcrypto` และ `citext` เป็น trusted extension เจ้าของ database สร้างเองได้

จากนั้นใส่ใน `.env` ของ Bancha (mode 600) แล้ว restart:

```bash
BANCHA_DB_NAME=bancha
BANCHA_DB_USER=bancha
BANCHA_DB_PASSWORD=<รหัสใหม่>
```

```bash
pm2 restart bancha && sleep 3 && curl -s http://127.0.0.1:3950/api/health && pm2 logs bancha --lines 20 --nostream | grep -F "[db]"
```

server รัน migration เองตอน start (ถ้า DB ยังไม่ตอบจะลองใหม่ทุกนาที) ห้ามใช้ user `arak` และห้ามสร้างตารางใน arakdb

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

ระหว่างรอ เข้าได้ตรงที่ http://10.4.155.151:3950/ (`BIND_HOST=0.0.0.0`) ยังไม่มี login จริง ใครอยู่ใน network เดียวกันเปิดได้ (ROADMAP 0.13)

---

## 6. กติกาที่ต้องรักษา

1. **ห้ามแก้ของคนอื่น** ทั้งระบบจริงและโฟลเดอร์ของแอพอื่นบน prod ให้ทำงานเฉพาะใน `~/ControlPane_Bancha` อ่านดูวิธีของคนอื่นได้ แต่ห้ามแก้
2. ทุกการต่อไประบบจริงต้อง **read-only** (Postgres ใช้ read-only session และ HTTP ใช้แค่ GET ยกเว้น login ที่ต้องใช้ขอ token)
   ข้อยกเว้นเดียว: push เข้า Arak ผ่าน admin API ของ Arak ด้วยบัญชี `bancha-sync` (เจ้าของงานอนุมัติ 14 Oct 2026) ห้ามแตะ source `arak-live-pg` และห้ามเขียน arakdb ตรง
3. **Secret อยู่ใน `.env` เท่านั้น** ห้าม commit ห้ามเขียนลงไฟล์อื่นหรือ log (server ปิดค่า `password=` ใน error message ไว้แล้ว) ห้ามเปิดอ่าน `.env` ของแอพอื่น
4. ดูบน local ให้เจ้าของงานเห็นก่อน แล้วค่อย push และ deploy โดย **ต้องถามก่อนทุกครั้ง**
5. nginx และ config ที่ใช้ร่วมกันต้องให้เจ้าของ server อนุมัติ

---

## 7. งานถัดไปที่แนะนำ

1. ขอของที่ขาดตาม ROADMAP Phase 0 (0.1–0.7) แล้วใส่ใน `.env` และกด Test all ในหน้า Connections
2. ได้รับอนุมัติแล้วค่อย deploy prod ตามหัวข้อ 5 (ตอนอยู่บน prod จะ test auth-service ได้)
3. Phase 1: ขอให้เจ้าของ Postgres สร้าง database `bancha` (หัวข้อ 5) แล้วใส่ใน `.env` ของ prod ต่อด้วย connection secret ใน DB (1.4) และ Azure AD sync (1.5)

## 8. ความเสี่ยงที่ควรรู้

- Login ของคอนโซลยังเป็น http ธรรมดา รหัสและ cookie ดักได้ใน network จนกว่าจะมี nginx + HTTPS session อยู่ใน memory restart แล้วทุกคนต้อง login ใหม่ ทนได้ 10 ครั้งที่ผิดต่อ IP ใน 15 นาที
- Credential หลายตัว (OM, arakdb, Arak admin, SSH) ถูกส่งผ่านแชทระหว่างพัฒนา **ควร rotate** Bancha ไม่ใช้รหัส `admin` ของ Arak แล้ว เปลี่ยนได้เลย
- บน Arak prod ยังมีของทดสอบ `bancha-test`, `bancha-test-group`, source `bancha-test-pg` (disabled) ลบได้ด้วย `node server/arak-push.js server/arak-push.test.json --undo`
- ตอนนี้ Bancha ใช้ user ของแอพอื่น (`arak` และ account OM ส่วนตัว) ควรขอ user read-only ของ Bancha เอง
- `prototype/control-plane.html` เป็นไฟล์เดียวขนาดประมาณ 1,700 บรรทัด (รวมโลโก้ base64) เมื่อเข้า Phase 1 ควรแยกเป็น frontend project (เช่น Vite) หรืออย่างน้อยแยก JS ออกมา
