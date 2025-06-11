const http = require('http');
const { Pool } = require('pg');
const { parse } = require('url');
require('dotenv').config();
const createTables = require('./createTables');

// Kết nối PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ Database connected."))
  .catch(err => {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  });

// Hàm đọc JSON body
const parseBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });

// Server
const startServer = () => {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = parse(req.url, true);
    const path = parsedUrl.pathname;
    const method = req.method;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
      if (method === 'POST' && path === '/login') {
        console.log("🔐 Login endpoint hit");
        const { username, password } = await parseBody(req);
        const result = await pool.query(
          'SELECT account_id AS id, full_name AS name FROM accounts WHERE LOWER(username) = $1 AND password = $2',
          [username.toLowerCase().trim(), (password || '').trim()]
        );

        if (result.rows.length > 0) {
          console.log("✅ Login thành công:", result.rows[0]);
          return res.end(JSON.stringify({ success: true, ...result.rows[0] }));
        } else {
          console.warn("❌ Login thất bại: Sai username hoặc mật khẩu");
          return res.end(JSON.stringify({ success: false, error: 'Username hoặc mật khẩu không đúng' }));
        }
      }

      else if (method === 'POST' && path === '/log-incident') {
        console.log("📒 Logging incident session");
        const { account_id, status = 'unknown', reason = '' } = await parseBody(req);
        await pool.query(
          `INSERT INTO incident_sessions (account_id, status, reason, created_at)
           VALUES ($1, $2, $3, $4)`,
          [account_id, status, reason, new Date()]
        );
        return res.end(JSON.stringify({ success: true }));
      }

      else if (method === 'POST' && path === '/log-work') {
        console.log("🕒 Logging work session");
        const { account_id, status = 'unknown' } = await parseBody(req);
        await pool.query(
          `INSERT INTO work_sessions (account_id, status, created_at)
           VALUES ($1, $2, $3)`,
          [account_id, status, new Date()]
        );
        return res.end(JSON.stringify({ success: true }));
      }

      else if (method === 'POST' && path === '/log-break') {
        console.log("☕ Logging break session");
        const { account_id, status = 'unknown' } = await parseBody(req);
        await pool.query(
          `INSERT INTO break_sessions (account_id, status, created_at)
           VALUES ($1, $2, $3)`,
          [account_id, status, new Date()]
        );
        return res.end(JSON.stringify({ success: true }));
      }

      else if (method === 'POST' && path === '/log-loginout') {
        console.log("🔁 Logging login/logout");
        const { account_id, status = 'logout' } = await parseBody(req);
        await pool.query(
          `INSERT INTO login_logout_session (account_id, status, created_at)
           VALUES ($1, $2, $3)`,
          [account_id, status, new Date()]
        );
        return res.end(JSON.stringify({ success: true }));
      }

      else if (method === 'POST' && path === '/log-screenshot') {
        console.log("📸 Logging screenshot");
        const { account_id, hash } = await parseBody(req);
        await pool.query(
          `INSERT INTO photo_sessions (account_id, hash, created_at)
           VALUES ($1, $2, $3)`,
          [account_id, hash, new Date()]
        );
        return res.end(JSON.stringify({ success: true }));
      }

      else {
        console.warn("🚫 Endpoint not found:", path);
        res.statusCode = 404;
        return res.end(JSON.stringify({ success: false, error: 'Not Found' }));
      }

    } catch (err) {
      console.error("❌ Server error:", err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`✅ Server is running at http://localhost:${PORT}`);
  });
};

// Tạo bảng xong thì khởi động server
createTables()
  .then(() => {
    console.log("✅ Tables are ready. Starting server...");
    startServer();
  })
  .catch(err => {
    console.error("❌ Failed to initialize database tables:", err);
    process.exit(1);
  });

// Xử lý shutdown gọn gàng
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down server...');
  pool.end(() => {
    console.log('✅ PostgreSQL connection closed');
    process.exit(0);
  });
});
