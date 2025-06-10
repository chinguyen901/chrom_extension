// index.js – WebSocket + PostgreSQL (Railway)
// -----------------------------------------------------------------------------
/*
  ✔️  Hỗ trợ đồng thời hai kết nối WebSocket từ cùng một account_id:
      – source=background  ➜ giữ kết nối lâu dài, nhận ping/pong, ghi log SUDDEN
      – source=popup       ➜ kết nối ngắn hạn, KHÔNG ping/pong, KHÔNG ghi SUDDEN

  🔄  Cấu trúc clients: Map<account_id, { background?: ws, popup?: ws }>
      Giúp server phân biệt và quản lý từng nhánh.
*/

const http                = require('http');
const { WebSocketServer }  = require('ws');
const { Pool }             = require('pg');
const fetch               = require('node-fetch');
require('dotenv').config();
const createTables         = require('./createTables');

// ────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE MAPS
// ────────────────────────────────────────────────────────────────────────────
// account_id → { background?: WebSocket, popup?: WebSocket }
const clients            = new Map();
const inactivityCounters = new Map();   // account_id → số lần timeout liên tiếp
const checkinStatus      = new Map();   // account_id → boolean (đang check‑in?)
const hasPinged          = new Map();   // account_id → boolean (đã có ít nhất 1 ping/pong)
const expectingPong      = new Map();   // account_id → boolean (đang chờ pong)
const lastPingSentAt     = new Map();   // account_id → timestamp

// ────────────────────────────────────────────────────────────────────────────
// PING / PONG CONFIG
// ────────────────────────────────────────────────────────────────────────────
const PING_INTERVAL = 15_000; // 15 s
const PONG_TIMEOUT  = 10_000; // 10 s chờ phản hồi

function shouldPing(account_id) {
  return checkinStatus.get(account_id) === true;
}

// ────────────────────────────────────────────────────────────────────────────
// HELPER: Quản lý clients
// ────────────────────────────────────────────────────────────────────────────
function setClient(account_id, source, ws) {
  const entry = clients.get(account_id) || {};
  entry[source] = ws;
  clients.set(account_id, entry);
}

function removeClient(account_id, source) {
  const entry = clients.get(account_id) || {};
  delete entry[source];
  if (!entry.background && !entry.popup) clients.delete(account_id);
  else clients.set(account_id, entry);
}

function getPreferredSocket(account_id) {
  const entry = clients.get(account_id) || {};
  return entry.background || entry.popup || null;
}

// ────────────────────────────────────────────────────────────────────────────
// DATABASE POOL
// ────────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl             : { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('✅ Database connected successfully.'))
  .catch(err => {
    console.error('❌ Failed to connect to the database:', err);
    process.exit(1);
  });

// ────────────────────────────────────────────────────────────────────────────
// SUDDEN HANDLER (chỉ áp dụng cho background)
// ────────────────────────────────────────────────────────────────────────────
async function handleSudden(account_id, ws = null) {
  try {
    console.log(` Vào handleSudden .`);
    if (ws?.source === 'popup') return; // popup không ghi sudden
    
    // Nếu socket đã đóng, ta mới ghi log SUDDEN
    if (ws && ws.readyState !== ws.OPEN) {
      await pool.query(
        `INSERT INTO incident_sessions (account_id, status, reason, created_at)
         VALUES ($1, 'SUDDEN', 'Client Disconnected', $2)`,
        [account_id, new Date()]
      );

      // Reset trạng thái liên quan
      inactivityCounters.set(account_id, 0);
      expectingPong.set(account_id, false);
      hasPinged.set(account_id, false);
      checkinStatus.set(account_id, false);

      // Báo cho extension (nếu socket còn mở)
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type   : 'sudden',
          status : 'checkin-required',
          message: 'Kết nối mất ổn định – vui lòng CHECK-IN lại để tiếp tục làm việc!'
        }));
      }
    }
  } catch (err) {
    console.error('❌ Error in handleSudden:', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP SERVER + WEBSOCKET SERVER
// ────────────────────────────────────────────────────────────────────────────
const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end('Server is alive');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'ws://placeholder'); // URL tương đối ➜ thêm host giả
  const source = urlObj.searchParams.get('source') || 'background'; // mặc định background
  ws.source    = source; // lưu lại loại kết nối

  console.log(`✅ New ${source} socket connected.`);
  ws.isAlive  = true;
  ws.lastSeen = new Date();

  // ───────── MESSAGE HANDLER ─────────
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const { type, account_id } = msg;
      if (!type) return ws.send(JSON.stringify({ success: false, error: 'Missing message type' }));

      // Map socket ↔ account_id
      if (account_id) {
        setClient(account_id, ws.source, ws);
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
            console.log(`✅ line 174 : ${checkinStatus.set(account_id, true)}`);
            hasPinged.set(account_id, false);

            const bgSocket = getPreferredSocket(account_id);
            if (bgSocket?.readyState === bgSocket.OPEN) {
              bgSocket.send(JSON.stringify({ type: 'ping' }));
              expectingPong.set(account_id, true);
              lastPingSentAt.set(account_id, Date.now());
            }
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
                inactivityCounters.set(account_id, 0);
                hasPinged.set(account_id, true);
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

  // ───────── CLOSE HANDLER ─────────
  ws.on('close', () => {
    console.log(`🚪 ${ws.source} socket disconnected.`);

    const id         = ws.account_id;
    const isCheckin  = checkinStatus.get(id);
    const hasAnyPing = hasPinged.get(id);
    console.log(`🚪 ${ws.source} --- ${isCheckin} ---- ${id}.`);
    // CHỈ ghi sudden nếu background rớt
    if (ws.source === 'background' && id && isCheckin) {
      console.log(`🚪 ${ws.source} Vào if close.`);
      handleSudden(id, ws);
    }

    removeClient(id, ws.source);
    inactivityCounters.delete(id);
    checkinStatus.delete(id);
    hasPinged.delete(id);
    expectingPong.delete(id);
    lastPingSentAt.delete(id);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GLOBAL PING LOOP (chỉ ping background)
// ────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  for (const [account_id, entry] of clients.entries()) {
    const ws = entry.background;
    if (!ws || ws.readyState !== ws.OPEN) continue;
    if (!shouldPing(account_id))           continue;

    const graceCount = inactivityCounters.get(account_id) || 0;

    if (expectingPong.get(account_id)) {
      const lastPing = lastPingSentAt.get(account_id) || 0;
      if (Date.now() - lastPing > PONG_TIMEOUT) {
        if (graceCount >= 2) {
          console.log(`[PING] Timeout confirmed, closing socket for ${account_id}`);
          handleSudden(account_id, ws);
          try { ws.terminate?.(); } catch (_) {}
        } else {
          inactivityCounters.set(account_id, graceCount + 1);
        }
      }
      continue;
    }

    setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
        expectingPong.set(account_id, true);
        lastPingSentAt.set(account_id, Date.now());
        hasPinged.set(account_id, true);
      }
    }, 500);
  }
}, PING_INTERVAL);

// ────────────────────────────────────────────────────────────────────────────
// SELF-PING (giữ Railway không ngủ)
// ────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  fetch('https://chromextension-production.up.railway.app')
    .then(() => console.log('🔄 Self-ping success at', new Date().toISOString()))
    .catch(err => console.error('❌ Self-ping error:', err.message));
}, 60_000); // 60 s

// ────────────────────────────────────────────────────────────────────────────
// START SERVER
// ────────────────────────────────────────────────────────────────────────────
createTables().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () =>
    console.log(`✅ WebSocket server running on ws://localhost:${PORT}`));
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
