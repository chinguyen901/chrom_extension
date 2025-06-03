# Client Logger Backend

## 🚀 Tech Stack
- Node.js + Express
- PostgreSQL (hosted on Railway)

## 📦 Setup

1. Clone repo & install
```bash
npm install
```

2. Tạo file `.env` dựa vào `.env.example` và dán DATABASE_URL từ Railway

3. Chạy server:
```bash
npm start
```

## 📥 API

### POST /log

**Body JSON:**
```json
{
  "user": "username",
  "action": "login" // hoặc "logout"
}
```

## 🗃 PostgreSQL Schema
```sql
CREATE TABLE client_logs (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  action VARCHAR(10) CHECK (action IN ('login', 'logout')),
  log_time TIMESTAMP NOT NULL
);
```
