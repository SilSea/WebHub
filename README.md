# webhub

**ศูนย์รวมเว็บสำหรับเครื่อง dev** — เปิดทุก project บนเครื่องผ่าน `http://<ชื่อ>.localhost` จากที่เดียว โดยไม่ต้องแก้ไฟล์ใน project เลย

> **สถานะ: กำลังออกแบบ** — ยังใช้งานไม่ได้. Design เสร็จแล้ว ([DESIGN.md](DESIGN.md)), กำลังเริ่มพัฒนาตาม [แผน](docs/PLAN.md)

---

## ปัญหาที่ webhub แก้

ถ้าคุณมีหลาย project บนเครื่อง (Vite, Next, Express, Bun, FastAPI, Docker Compose …) มักเจอว่า:

- ต้องจำว่า project ไหนรันด้วยคำสั่งอะไร port อะไร
- port ชนกัน (ทุกตัวอยากได้ 3000 / 5173)
- แต่ละ project มี Postgres / Redis ของตัวเอง กินแรมซ้ำๆ
- ต้องสลับไปมาระหว่าง pgAdmin, RedisInsight, Postman
- project ต้องการ Node / Python คนละ version

webhub จัดการทั้งหมดนี้จากที่เดียว — **และไม่แตะไฟล์ของ project คุณ** (ไม่แก้ `.env`, `package.json`, `docker-compose.yml` ฯลฯ) ทุกการตั้งค่าอยู่ใน webhub

## ทำอะไรได้

| | |
|---|---|
| 🔍 **Scan** | หา project ที่เป็นเว็บในโฟลเดอร์ที่คุณเลือก — ทุกภาษา (Node, Bun, Python, PHP, Go, …) แล้วให้คุณกดยืนยัน |
| ▶️ **Start / Stop** | รันให้ตามชนิด project: dev server ปกติ, Docker Compose, หรือ container |
| 🌐 **URL สวย** | `http://pos.localhost`, `http://shop.localhost` แทน `localhost:5173` — frontend + API อยู่ domain เดียว |
| 🔌 **Port** | เห็น port ทุกตัวในตารางเดียว, แก้ได้ทุกตัว, เตือนเมื่อชน |
| 🗄️ **Database รวม** | ย้าย Postgres / Redis / MySQL / MongoDB ของทุก project มาไว้ server กลาง (import ข้อมูลเดิมให้) |
| 🧰 **DB Studio** | จัดการ SQL / MongoDB / Redis ในตัว — ดู/แก้ข้อมูล, เขียน query, schema, export |
| 📡 **API Studio** | ยิง API แบบ Postman ผูกกับแต่ละ site, import OpenAPI ได้, ดูว่า API แก้อะไรใน DB |
| 🧩 **หลาย version** | โหลด Node / Bun / Python ตาม version ที่ project ต้องการให้เอง ไม่กระทบเครื่อง |
| 🖥️ **Dashboard + CLI** | ใช้ผ่านหน้าเว็บ `http://hub.localhost` หรือคำสั่ง `webhub` |

## หน้าตาการใช้งาน (เป้าหมาย)

```bash
npm i -g webhub          # ติดตั้ง (ต้องมี Node 22+)
webhub setup             # เลือกโฟลเดอร์ project, ตรวจ Docker, ตั้งค่าครั้งแรก
webhub scan              # หา project
webhub approve pos       # ยืนยันว่าจะใช้ site นี้
webhub up pos            # เปิด → http://pos.localhost
webhub ports             # ดู port ทั้งหมด
webhub db list           # ดู database ทุก project
```

## ต้องมีอะไร

- **Windows** (รองรับก่อน; macOS / Linux ตามมา)
- **Node.js 22+** (สำหรับตัว webhub เอง)
- **Docker Desktop** — ไม่บังคับ. ไม่มี Docker ใช้ **Lite mode** ได้ (รันเว็บได้ แต่ไม่มี database กลาง)

## หลักการ

- **Zero-touch** — ไม่แก้ไฟล์ใน project ของคุณ ลบ webhub ออก project ยังเหมือนเดิมทุกอย่าง
- **ปลอดภัยไว้ก่อน** — ทุกอย่างเปิดแค่ในเครื่อง (`127.0.0.1`), dashboard มี token, ก่อนรันคำสั่งของ project ใหม่จะโชว์ให้ยืนยันก่อน
- **ไม่ส่งข้อมูลออกนอกเครื่อง** — ไม่มี telemetry

## เอกสาร

| เอกสาร | สำหรับ |
|---|---|
| [DESIGN.md](DESIGN.md) | ออกแบบระบบทั้งหมด (ภาษาไทย) |
| [docs/PLAN.md](docs/PLAN.md) | แผนพัฒนา + ลำดับงาน |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | ขั้นตอน + กฎการพัฒนา (English) |
| [docs/features/](docs/features/README.md) | สถานะแต่ละ feature |
| [docs/reports/](docs/reports/README.md) | ผลทดสอบ / review / security |
| `docs/manual/` | คู่มือการใช้งาน (HTML) — มาเมื่อ MVP แรกเสร็จ |

## Roadmap ย่อ

1. **MVP-1** scan + detect project, daemon + CLI
2. **MVP-2** เปิดเว็บผ่าน `<ชื่อ>.localhost`
3. **MVP-3** จัดการ port, รัน dev server, จัดการ runtime version
4. **MVP-4** Docker Compose
5. **MVP-5** Database กลาง + เครื่องมือ DB
6. **MVP-6** Dashboard ครบ, autostart, tray

รายละเอียด: [docs/PLAN.md](docs/PLAN.md)

## License

[MIT](LICENSE)
