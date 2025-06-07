const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
require('dotenv').config();
const createTables = require('./createTables');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Kiểm tra kết nối PostgreSQL
pool.connect()
  .then(() => console.log("✅ Database connected successfully."))
  .catch(err => {
    console.error("❌ Failed to connect to the database:", err);
    process.exit(1);
  });

// Khởi tạo server
const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log("✅ New client connected.");

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const type = msg.type;

      if (!type) return ws.send(JSON.stringify({ success: false, error: "Missing message type" }));

      switch (type) {
        case 'login': {
          const { username, password } = msg;
          const result = await pool.query(
            'SELECT account_id AS id, full_name AS name FROM accounts WHERE LOWER(username) = $1 AND password = $2',
            [(username || '').toLowerCase().trim(), (password || '').trim()]
          );
          if (result.rows.length > 0) {
            ws.send(JSON.stringify({ success: true, ...result.rows[0] }));
          } else {
            ws.send(JSON.stringify({ success: false, error: 'Username hoặc mật khẩu không đúng' }));
          }
          break;
        }

        case 'log-work': {
          const { account_id, status } = msg;
          await pool.query(
            `INSERT INTO work_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-break': {
          const { account_id, status } = msg;
          await pool.query(
            `INSERT INTO break_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-incident': {
          const { account_id, status, reason } = msg;
          await pool.query(
            `INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', reason || '', new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-loginout': {
          const { account_id, status } = msg;
          await pool.query(
            `INSERT INTO login_logout_session (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'logout', new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-screenshot': {
          const { account_id, hash } = msg;
          await pool.query(
            `INSERT INTO photo_sessions (account_id, hash, created_at) VALUES ($1, $2, $3)`,
            [account_id, hash, new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-distraction': {
          const { account_id, status, note } = msg;
          await pool.query(
            `INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', note || '', new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        default:
          ws.send(JSON.stringify({ success: false, error: "Unknown message type" }));
      }

    } catch (err) {
      console.error("❌ Error processing message:", err);
      ws.send(JSON.stringify({ success: false, error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log("🚪 Client disconnected.");
  });
});

// Khởi động server sau khi đã tạo bảng
createTables().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`✅ WebSocket server running on ws://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("❌ Failed to create tables:", err);
  process.exit(1);
});

// Đóng kết nối khi nhận SIGTERM
process.on('SIGTERM', () => {
  console.log('Application is shutting down...');
  pool.end(() => {
    console.log('Database connection closed');
    process.exit(0);
  });
});
