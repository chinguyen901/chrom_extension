// ✅ index.js (đã sửa lỗi đếm NO ACTIVE không tăng đều)

const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const fetch = require('node-fetch');
require('dotenv').config();
const createTables = require('./createTables');

const clients = new Map();
const inactivityCounters = new Map();
const checkinStatus = new Map();
const hasPinged = new Map();
const expectingPong = new Map(); // ✅ Biến cờ kiểm soát PONG

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

wss.on('connection', (ws) => {
  console.log("✅ New client connected.");
  ws.isAlive = true;
  ws.lastSeen = new Date();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const { type, account_id } = msg;

      if (!type) return ws.send(JSON.stringify({ success: false, error: "Missing message type" }));

      if (account_id) {
        clients.set(account_id, ws);
        ws.account_id = account_id;
        inactivityCounters.set(account_id, 0);
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
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO work_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          if (status === 'checkin') {
            checkinStatus.set(account_id, true);
            hasPinged.set(account_id, false);
            expectingPong.set(account_id, false);
            ws.isAlive = true;
          }
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        case 'log-break': {
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO break_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          if (status === 'break-done') checkinStatus.set(account_id, true);
          else checkinStatus.set(account_id, false);
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        case 'log-incident': {
          const { status, reason, created_at } = msg;
          await pool.query(
            `INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', reason || '', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        case 'log-loginout': {
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO login_logout_sessions (account_id, status, created_at) VALUES ($1, $2, $3)`,
            [account_id, status, created_at || new Date()]
          );
          if (status === 'checkout') checkinStatus.set(account_id, false);
          ws.send(JSON.stringify({ success: true, type: "log-loginout", status }));
          break;
        }

        case 'log-screenshot': {
          const { hash, created_at } = msg;
          await pool.query(
            `INSERT INTO photo_sessions (account_id, hash, created_at) VALUES ($1, $2, $3)`,
            [account_id, hash, created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'log-distraction': {
          const { status, note, created_at } = msg;
          await pool.query(
            `INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', note || '', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        case 'pong': {
          if (account_id && shouldPing(account_id)) {
            if (expectingPong.get(account_id)) {
              ws.isAlive = true;
              ws.lastSeen = new Date();
              logDistraction(account_id, 'ACTIVE', 0);
              inactivityCounters.set(account_id, 0);
              expectingPong.set(account_id, false);
            }
          }
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
    if (ws.account_id) {
      clients.delete(ws.account_id);
      inactivityCounters.delete(ws.account_id);
      checkinStatus.delete(ws.account_id);
      hasPinged.delete(ws.account_id);
      expectingPong.delete(ws.account_id);
    }
  });
});

function shouldPing(account_id) {
  return checkinStatus.get(account_id) === true;
}

setInterval(() => {
  const now = new Date();

  for (const [account_id, ws] of clients.entries()) {
    if (!shouldPing(account_id)) continue;
    if (ws.readyState !== ws.OPEN) continue;

    if (hasPinged.get(account_id) && ws.isAlive === false) {
      let count = inactivityCounters.get(account_id) || 0;
      count++;
      inactivityCounters.set(account_id, count);

      logDistraction(account_id, 'NO ACTIVE ON TAB', count);

      if (count >= 30) {
        console.warn(`⚠️ No pong from ${account_id} for 5 minutes. Logging SUDDEN.`);
        pool.query(
          `INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)`,
          [account_id, 'SUDDEN', 'Client inactive > 5min', now]
        );
        try {
          ws.send(JSON.stringify({ type: 'force-checkin', message: 'SUDDEN - Please check in again to work' }));
        } catch (e) {
          console.error("❌ Failed to send force-checkin to client:", e.message);
        }

        ws.terminate();
        clients.delete(account_id);
        inactivityCounters.delete(account_id);
        checkinStatus.delete(account_id);
        hasPinged.delete(account_id);
        expectingPong.delete(account_id);
        continue;
      }
    }

    ws.isAlive = false;
    hasPinged.set(account_id, true);
    expectingPong.set(account_id, true);

    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {
      console.error("❌ Failed to send ping to", account_id);
    }
  }
}, 10000);

function logDistraction(account_id, status, note = 0) {
  const timestamp = new Date();
  pool.query(
    `INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)`,
    [account_id, status, note, timestamp]
  ).catch(err => console.error("❌ Failed to log distraction:", err));
}

setInterval(() => {
  fetch('https://chromextension-production.up.railway.app')
    .then(() => console.log('🔄 Self-ping success at', new Date().toISOString()))
    .catch(err => console.error('❌ Self-ping error:', err.message));
}, 1000);

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
