# Bancha — Roadmap

> อัปเดต: 14 Oct 2026 · อ่านคู่กับ `docs/ARCHITECTURE.md` (design) และ `docs/HANDOFF.md` (สถานะปัจจุบันและวิธีรัน)
>
> สัญลักษณ์: ✅ เสร็จ · 🟡 กำลังทำหรือทำได้บางส่วน · ⏳ รอของจากเจ้าของระบบ · ⬜ ยังไม่เริ่ม

---

## ภาพรวม

| Phase | เป้าหมาย | สถานะ |
|---|---|---|
| **0 · Prototype + Live check** | UI ครบทุกเมนู และต่อ connection จริงแบบ read-only | 🟡 UI เสร็จ ต่อจริงได้ 2 จาก 6 |
| **1 · Foundation** | Bancha มี DB ของตัวเอง เก็บ users, groups, connections, app registry จริง และ Arak ดึงไปใช้ได้ | ⬜ |
| **2 · Federation** | SSO ผ่าน Keycloak, Prajak integration, OpenMetadata adapter, sync matrix + dead letter | ⬜ |
| **3 · Hardening** | Vault, app-to-app token, Likit, SCIM, four-eyes approval, drift check | ⬜ |

---

## Phase 0 · Prototype + Live check (ตอนนี้)

### เสร็จแล้ว

- ✅ Architecture และการตัดสินใจหลัก D1–D7 (`docs/ARCHITECTURE.md`)
- ✅ Bancha App Contract v1: JSON Schema + manifest ตัวอย่างของ Arak, Prajak, OpenMetadata (`contracts/`)
  - 14 Oct 2026: role มี `appValue` และ `scoped`, user มี `match` และ `keeps`, manifest ของ Arak ใช้ role และ attribute จริงจาก arakdb
- ✅ Database schema ร่าง (`db/schema.sql`) ยังไม่ได้ใช้จริง
- ✅ Prototype UI หน้าตาแบบ Arak, sidebar สี navy, มีโลโก้แอพ (`prototype/control-plane.html`)
  - หน้า Login แบบเดียวกับ Arak: Sign in with MFEC หรือ username/password
  - Sidebar 2 กลุ่ม: **Control plane** (Overview, Users & groups, Connections, App registry, Distribution) เฉพาะ admin และ **Go to app** (My apps + แอพที่มีสิทธิ์)
  - user ทั่วไปเห็นแค่ My apps
- ✅ Backend ตัวแรก (`server/server.js`): เสิร์ฟ UI และ test connection จริงแบบ read-only ทุก 5 นาที
- ✅ ต่อจริงผ่าน
  - **arakdb**: PostgreSQL 16.15 ที่ 10.4.155.151 มี 77 tables ใน 3 schemas
  - **OpenMetadata**: v2.0.1 ที่ 10.6.150.110:8585 มี 13 users, 13 teams, 114 tables
- ✅ หน้า Connections แสดงผลจริงและบอกว่ายังขาด credential ตัวไหน
- ✅ `deploy/start.sh` สำหรับ pm2 แบบเดียวกับ Arak
- ✅ **Identity → Across apps** (14 Oct 2026): อ่าน user จาก Arak (45) และ OpenMetadata (13) แบบ read-only จับคู่ด้วย email ได้ 57 คน ตรงกันทั้งสองแอพ 1 คน
  - ตาราง "What Bancha sends to each app" และพรีวิว event รายคน (ARCHITECTURE §3.5 และ §12 ขั้น 0)
- ✅ **Push เข้า Arak ผ่าน admin API** (14 Oct 2026, ARCHITECTURE §3.6): `server/arak-push.js` ส่ง user, group, role, attribute, data source และ OpenMetadata URL โดยไม่ต้องแก้โค้ด Arak ทดสอบบน prod ด้วยของทดสอบ `bancha-test*` แล้ว
  - Bancha login เป็น `bancha-sync` (สร้างด้วย `server/arak-sync-account.js`) ไม่ใช้ `admin` แล้ว

### ต้องทำต่อ

| # | งาน | สถานะ | ต้องการอะไร |
|---|---|---|---|
| 0.1 | ต่อ **employees-sample** (10.6.150.110:5432/employees) | ⏳ | password ของ user `postgres` หรือขอ user read-only แยก (ดีกว่า) |
| 0.2 | ต่อ **dtp-iprm** (10.6.150.102:55432/iprm) | ⏳ | password ของ user `iprm` และ **เปิด firewall** เพราะตอนนี้ port 55432 ต่อไม่ได้ทั้งจากเครื่อง local และจาก prod |
| 0.3 | ต่อ **Azure AD (MFEC tenant)** เพื่ออ่าน users/groups | ⏳ | App registration ของ Bancha: Tenant ID, Client ID, Client secret และ Graph application permission `User.Read.All` + `Group.Read.All` (ต้องให้ admin consent) |
| 0.4 | ต่อ **auth-service** (127.0.0.1:3900 บน prod) | ⏳ | API key ของ Bancha ที่ออกจากหน้า `/admin` ของ auth-service ต้องรัน Bancha บน prod ก่อน เพราะ auth-service ฟังแค่ loopback |
| 0.5 | ต่อ **Prajak** | ⏳ | URL และ DB ของ Prajak เพราะยังไม่เจอใน pm2 บน prod |
| 0.6 | LDAP (ถ้ามี) | ⏳ | host, base DN, bind user |
| 0.7 | เปลี่ยน OpenMetadata ไปใช้ **bot account** แทน account ส่วนตัว | ⏳ | bot token จาก OM (Settings → Bots) |
| 0.8 | ขึ้น Git: https://github.com/sakanarm/controlpane_bancha | ✅ | branch `main` |
| 0.9 | Deploy prod `appadm@10.4.155.151:~/ControlPane_Bancha` ด้วย pm2 ชื่อ `bancha` port 3950 | ✅ | 14 Oct 2026, `BIND_HOST=0.0.0.0` เปิดที่ http://10.4.155.151:3950/ จนกว่าจะมี nginx (0.10) |
| 0.10 | nginx location `/Bancha` | ⏳ | ไฟล์ nginx เป็นของ root และใช้ร่วมกับแอพอื่น ต้องให้เจ้าของ server อนุมัติและทำให้ (ไฟล์ตัวอย่างอยู่ใน HANDOFF) |
| 0.11 | ให้หน้าอื่น (Overview, Users & groups, App registry, Distribution) ใช้ข้อมูลจริง | ⬜ | ตอนนี้ยังเป็น sample data ต้องรอ Phase 1 (DB) และ 0.3 (Azure AD) |
| 0.12 | Login จริง | ⬜ | ตอนนี้เป็นการเลือก sample account ทำจริงได้หลัง 0.3 หรือใช้ auth-service `/auth/verify` (0.4) |
| 0.13 | ปิดข้อมูลจริงจากคนที่ไม่ได้ login | ⬜ | URL บน prod ยังไม่มี login จริง ใครอยู่ใน network เห็นชื่อและอีเมลในหน้า Across apps ได้ ต้องตัดสินใจ: ปิดหน้านี้บน prod, ใส่รหัสผ่านชั่วคราว หรือรอ 0.12 |

---

## Phase 1 · Foundation

เป้าหมาย: Bancha เป็น source of truth ของ users, groups, connections และ app registry แล้ว Arak ใช้งานจริง

| # | งาน | ขึ้นกับ |
|---|---|---|
| 1.1 | ตัดสินใจว่า **DB ของ Bancha** อยู่ที่ไหน (แนะนำ database `bancha` แยกบน Postgres 10.4.155.151 ใช้ user `bancha` ของตัวเอง ห้ามใช้ user `arak`) | เจ้าของ DB |
| 1.2 | Migration จาก `db/schema.sql` (เลือก tool: node-pg-migrate หรือ Prisma แบบเดียวกับ auth-service) | 1.1 |
| 1.3 | Admin API ตาม `ARCHITECTURE.md` §10: users, groups, role bindings, connections, apps | 1.2 |
| 1.4 | เก็บ connection secret แบบ envelope encryption ใน Postgres (master key อยู่ใน `.env`) แทนการใส่ทุกตัวใน `.env` | 1.2 |
| 1.5 | Azure AD sync: ดึง users/groups ตาม filter แล้วเก็บใน DB ทุก 15 นาที + delta | 0.3, 1.2 |
| 1.6 | Login จริงด้วย Entra OIDC (Authorization Code + PKCE) และ session cookie กำหนด admin จาก group ใน Azure AD | 0.3 |
| 1.7 | App registry: register ด้วย manifest + validate กับ JSON Schema และ health check `/.well-known/bancha/health` | 1.2 |
| 1.8 | Outbox `change_log` + webhook (CloudEvents, HMAC) + `GET /feed?after=seq` + snapshot | 1.2 |
| 1.9 | Arak integration ตาม ARCHITECTURE §12: ขั้น 1–2 ทำได้แล้วผ่าน admin API (§3.6) เหลือให้ Bancha push ข้อมูลจริงจาก DB ของตัวเอง ขั้น 3 (ล็อก field ใน UI ของ Arak และเก็บ `external_id`) | 1.2 และขั้น 3 ต้องให้ทีม Arak แก้โค้ดฝั่ง Arak เพราะ Bancha ห้ามแก้ของคนอื่น |
| 1.10 | Audit log ทุกการแก้ไข | 1.2 |

ผลลัพธ์ที่ใช้ตัดสินว่าจบ Phase 1: เพิ่ม user เข้า group ใน Bancha แล้ว Arak เห็นภายใน 1 นาที และ connection ที่ Arak ใช้ถูกจัดการจาก Bancha

---

## Phase 2 · Federation

| # | งาน |
|---|---|
| 2.1 | Keycloak เป็น OIDC broker (federate Azure AD + LDAP + local) หรือยืนยันว่าจะชี้ Entra ตรง (ARCHITECTURE §14 ข้อ 1) |
| 2.2 | Prajak integration แบบเดียวกับ Arak |
| 2.3 | OpenMetadata adapter: sync users/teams และสร้าง database service จาก connection ของ Bancha อัตโนมัติ (OM มีอยู่แล้ว 3 services: arakdb, dtp-iprm, postgres_employees_sample) |
| 2.4 | Sync matrix และ dead-letter UI ใช้ข้อมูลจริง (หน้า Distribution) |
| 2.5 | Registration token flow ให้แอพใหม่ register เองได้ |

## Phase 3 · Hardening

| # | งาน |
|---|---|
| 3.1 | Vault (dynamic DB credentials) ถ้าองค์กรมี |
| 3.2 | App-to-app token |
| 3.3 | Likit onboarding |
| 3.4 | SCIM adapter |
| 3.5 | Four-eyes approval สำหรับการแก้ connection และ admin role |
| 3.6 | Drift checksum ระหว่าง Bancha กับ projection ในแต่ละแอพ |
| 3.7 | แยก instance ต่อ environment (Dev/UAT/Prod) |

---

## Security follow-ups (ทำให้เร็วที่สุด)

- **Rotate password ที่ส่งผ่านแชท**: OpenMetadata (Sakan_pu), arakdb (`arak`), Arak web admin, SSH `appadm`
- ขอ user read-only สำหรับ Bancha บนทุก data source แทนการใช้ user ของแอพอื่น (`arak`, `postgres`, `iprm`)
- ใช้ OM bot token แทน account ส่วนตัว
