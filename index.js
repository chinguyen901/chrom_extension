const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const fetch = require('node-fetch'); // Self-ping giữ Railway luôn online
require('dotenv').config();
const createTables = require('./createTables');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ Database connected successfully."))
  .catch(err => {
    console.error("❌ Failed to connect to the database:", err);
    process.exit(1);
  });

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Server is alive");
});

const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  console.log("✅ New client connected.");
  ws.isAlive = true;
  ws.lastSeen = new Date();

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastSeen = new Date();
    if (ws.account_id) {
      logDistraction(ws.account_id, 'ACTIVE', 0);
    }
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const type = msg.type;

      if (!type) return ws.send(JSON.stringify({ success: false, error: "Missing message type" }));

      if (msg.account_id) {
        clients.set(msg.account_id, ws);
        ws.account_id = msg.account_id;
      }

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
          const { account_id, status, created_at } = msg;
          await pool.query(
            `INSERT INTO work_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        case 'log-break': {
          const { account_id, status, created_at } = msg;
          await pool.query(
            `INSERT INTO break_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        case 'log-incident': {
          const { account_id, status, reason, created_at } = msg;
          await pool.query(
            `INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', reason || '', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        case 'log-loginout': {
          const { account_id, status, created_at } = msg;
          await pool.query(
            `INSERT INTO login_logout_session (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'logout', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: "log-loginout" }));
          break;
        }

        case 'log-screenshot': {
          const { account_id, hash, created_at } = msg;
          await pool.query(
            `INSERT INTO photo_sessions (account_id, hash, created_at) VALUES ($1, $2, $3)`,
            [account_id, hash, created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-distraction': {
          const { account_id, status, note, created_at } = msg;
          await pool.query(
            `INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', note || '', created_at || new Date()]
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
    if (ws.account_id) clients.delete(ws.account_id);
  });
});

// ⏱ Ping-Pong logic & log distraction
setInterval(() => {
  const now = new Date();
  for (const [account_id, ws] of clients.entries()) {
    if (ws.isAlive === false || (now - ws.lastSeen > 5 * 60 * 1000)) {
      console.warn(`⚠️ No pong from ${account_id}, logging SUDDEN incident.`);
      pool.query(
        `INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)`,
        [account_id, 'SUDDEN', 'Client disconnected or inactive > 5m', now]
      );
      ws.terminate();
      clients.delete(account_id);
    } else {
      ws.isAlive = false;
      ws.ping();
      if (ws.account_id) {
        logDistraction(ws.account_id, 'NO ACTIVE ON TAB', 0);
      }
    }
  }
}, 10 * 1000);

// 🧠 Hàm ghi distraction_sessions
function logDistraction(account_id, status, note = 0) {
  const timestamp = new Date();
  pool.query(
    `INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)`,
    [account_id, status, note, timestamp]
  ).catch(err => console.error("❌ Failed to log distraction:", err));
}

// 🔄 Self-ping Railway để giữ server hoạt động
setInterval(() => {
  fetch('https://chromextension-production.up.railway.app/')
    .then(() => console.log('⏰ Self-ping sent to keep Railway alive.'))
    .catch(err => console.error('❌ Self-ping failed:', err.message));
}, 1000 * 60 * 5); // 5 phút

// 🚀 Start server
createTables().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`✅ WebSocket server running on ws://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("❌ Failed to create tables:", err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('Application is shutting down...');
  pool.end(() => {
    console.log('Database connection closed');
    process.exit(0);
  });
});
