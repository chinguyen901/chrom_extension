// index.js - WebSocket + PostgreSQL (Railway) ---------------------------------
const http               = require('http');
const { WebSocketServer} = require('ws');
const { Pool }           = require('pg');
const fetch              = require('node-fetch');
require('dotenv').config();
const createTables       = require('./createTables');

// ────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE MAPS
// ────────────────────────────────────────────────────────────────────────────
const clients          = new Map();  // account_id → ws
const inactivityCounters = new Map();
const checkinStatus    = new Map();  // account_id → boolean (đang check-in?)
const hasPinged        = new Map();
const expectingPong    = new Map();
const lastPingSentAt   = new Map();

// ────────────────────────────────────────────────────────────────────────────
// PING / PONG CONFIG
// ────────────────────────────────────────────────────────────────────────────
const PING_INTERVAL = 30_000;  // 30 s
const PONG_TIMEOUT  = 10_000;  // 10 s chờ phản hồi

function shouldPing(account_id) {
  return checkinStatus.get(account_id) === true;
}

async function handleSudden(account_id, ws) {
  try {
    // Ghi log sudden
    await pool.query(
      `INSERT INTO incident_sessions (account_id, status,reason, created_at)
       VALUES ($1, 'SUDDEN','Client Disconect', $2)`,
      [account_id, new Date()]
    );

    // Reset trạng thái liên quan
    inactivityCounters.set(account_id, 0);
    expectingPong.set(account_id, false);
    hasPinged.set(account_id, false);
    checkinStatus.set(account_id, false);

    // Báo cho extension
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type   : 'sudden',
        status : 'checkin-required',
        message: 'Kết nối mất ổn định – vui lòng CHECK-IN lại để tiếp tục làm việc!'
      }));
    }
  } catch (err) {
    console.error('❌ handleSudden error:', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DATABASE POOL
// ────────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl             : { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ Database connected successfully."))
  .catch(err => {
    console.error("❌ Failed to connect to the database:", err);
    process.exit(1);
  });

// ────────────────────────────────────────────────────────────────────────────
// HTTP SERVER + WEBSOCKET SERVER
// ────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Server is alive");
});

const wss = new WebSocketServer({ server });

// ───────── CONNECTION HANDLER ─────────
wss.on('connection', (ws) => {
  console.log("✅ New client connected.");
  ws.isAlive  = true;
  ws.lastSeen = new Date();

  ws.on('message', async (data) => {
    try {
      const msg          = JSON.parse(data);
      const { type, account_id } = msg;
      if (!type) return ws.send(JSON.stringify({ success: false, error: "Missing message type" }));

      // Map socket ↔ account_id
      if (account_id) {
        clients.set(account_id, ws);
        ws.account_id = account_id;
        inactivityCounters.set(account_id, 0);
      }

      switch (type) {
        // ---------------- LOGIN ----------------
        case 'login': {
          const { username, password } = msg;
          const result = await pool.query(
            `SELECT account_id AS id, full_name AS name
             FROM accounts
             WHERE LOWER(username) = $1 AND password = $2`,
            [(username || '').toLowerCase().trim(), (password || '').trim()]
          );
          if (result.rows.length) {
            ws.send(JSON.stringify({ success: true, ...result.rows[0] }));
            checkinStatus.set(result.rows[0].id, true);
          } else {
            ws.send(JSON.stringify({ success: false, error: 'Username hoặc mật khẩu không đúng' }));
          }
          break;
        }

        // ---------------- WORK ----------------
        case 'log-work': {
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO work_sessions (account_id, status, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          if (status === 'checkin') {
            checkinStatus.set(account_id, true);
            hasPinged      .set(account_id, false);
            ws.isAlive = true;
          }
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        // ---------------- BREAK ----------------
        case 'log-break': {
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO break_sessions (account_id, status, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, status || 'unknown', created_at || new Date()]
          );
          if (status === 'break-done') checkinStatus.set(account_id, true);
          else                          checkinStatus.set(account_id, false);
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        // ---------------- INCIDENT ----------------
        case 'log-incident': {
          const { status, reason, created_at } = msg;
          await pool.query(
            `INSERT INTO incident_sessions (account_id, status, reason, created_at)
             VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', reason || '', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        // ---------------- LOGIN / LOGOUT ----------------
        case 'log-loginout': {
          const { status, created_at } = msg;
          await pool.query(
            `INSERT INTO login_logout_sessions (account_id, status, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, status, created_at || new Date()]
          );
          if (status === 'checkout') checkinStatus.set(account_id, false);
          ws.send(JSON.stringify({ success: true, type: 'log-loginout', status }));
          break;
        }

        // ---------------- SCREENSHOT ----------------
        case 'log-screenshot': {
          const { hash, created_at } = msg;
          await pool.query(
            `INSERT INTO photo_sessions (account_id, hash, created_at)
             VALUES ($1, $2, $3)`,
            [account_id, hash, created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        // ---------------- DISTRACTION ----------------
        case 'log-distraction': {
          const { status, note, created_at } = msg;
          await pool.query(
            `INSERT INTO distraction_sessions (account_id, status, note, created_at)
             VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', note || '', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        // ---------------- PONG ----------------
        case 'pong': {
          if (account_id && shouldPing(account_id)) {
            const sentAt  = lastPingSentAt.get(account_id) || 0;
            const delayMs = Date.now() - sentAt;

            if (expectingPong.get(account_id)) {
              if (delayMs >= 500 && delayMs <= PONG_TIMEOUT) {
                inactivityCounters.set(account_id, 0);  // nhận pong hợp lệ
              }
              expectingPong.set(account_id, false);
            }

            ws.isAlive  = true;
            ws.lastSeen = new Date();
          }
          break;
        }

        // ---------------- DEFAULT ----------------
        default:
          ws.send(JSON.stringify({ success: false, error: 'Unknown message type' }));
      }
    } catch (err) {
      console.error('❌ Error processing message:', err);
      ws.send(JSON.stringify({ success: false, error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('🚪 Client disconnected.');
    if (ws.account_id) {
      clients         .delete(ws.account_id);
      inactivityCounters.delete(ws.account_id);
      checkinStatus   .delete(ws.account_id);
      hasPinged       .delete(ws.account_id);
      expectingPong   .delete(ws.account_id);
      lastPingSentAt  .delete(ws.account_id);
    }
  });
});

// ───────── GLOBAL PING LOOP ─────────
setInterval(() => {
  for (const [account_id, ws] of clients.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!shouldPing(account_id))   continue;

    // Nếu đã ping mà chưa nhận pong trong 10 s  → sudden
    if (expectingPong.get(account_id)) {
      if (Date.now() - (lastPingSentAt.get(account_id) || 0) > PONG_TIMEOUT) {
        handleSudden(account_id, ws);
      }
      continue; // vẫn đang chờ pong
    }

    // Gửi ping mới
    ws.send(JSON.stringify({ type: 'ping' }));
    expectingPong.set(account_id, true);
    lastPingSentAt.set(account_id, Date.now());
  }
}, PING_INTERVAL);

// ────────────────────────────────────────────────────────────────────────────
// SELF-PING (giữ Railway không ngủ)
// ────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  fetch('https://chromextension-production.up.railway.app')
    .then(() => console.log('🔄 Self-ping success at', new Date().toISOString()))
    .catch(err => console.error('❌ Self-ping error:', err.message));
}, 5_000);  // 60 s là đủ

// ────────────────────────────────────────────────────────────────────────────
// START SERVER
// ────────────────────────────────────────────────────────────────────────────
createTables().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () =>
    console.log(`✅ WebSocket server running on ws://localhost:${PORT}`)
  );
}).catch(err => {
  console.error('❌ Failed to create tables:', err);
  process.exit(1);
});

// ────────────────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('Application is shutting down…');
  pool.end(() => {
    console.log('Database connection closed');
    process.exit(0);
  });
});
