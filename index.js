// index.js – WebSocket + PostgreSQL (Railway)
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
require('dotenv').config();
const createTables = require('./createTables');

// GLOBAL STATE
const clients = new Map();       // account_id → { background?: ws, popup?: ws }
const checkinStatus = new Map(); // account_id → boolean (đang check-in?)

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('✅ Database connected successfully.'))
  .catch(err => { console.error('❌ DB connection failed:', err); process.exit(1); });

// SUDDEN HANDLER – chỉ ghi log
async function handleSudden(account_id) {
  try {
    await pool.query(
      `INSERT INTO incident_sessions (account_id, status, reason, created_at)
       VALUES ($1, 'SUDDEN', 'Client Disconnected', $2)`,
      [account_id, new Date()]
    );
    checkinStatus.set(account_id, false);
    console.log(`🚀 Ghi log SUDDEN cho user ${account_id}`);
  } catch (err) {
    console.error('❌ Error in handleSudden:', err);
  }
}

// HTTP + WebSocket setup
const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end('Server is alive');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'ws://placeholder');
  const source = urlObj.searchParams.get('source') || 'background';
  ws.source = source;
  ws.isAlive = true;
  ws.lastSeen = new Date();
  ws.account_id = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { type, account_id } = msg;
      if (!type) return ws.send(JSON.stringify({ success: false, error: 'Missing message type' }));

      if (account_id) {
        ws.account_id = account_id;
        setClient(account_id, source, ws);

        // Nếu background reconnect và user đang cần check-in lại
        if (source === 'background' && checkinStatus.get(account_id) === false) {
          console.log(`📢 Gửi force-checkin sau reconnect cho ${account_id}`);
          ws.send(JSON.stringify({
            type: 'force-checkin',
            status: 'checkin-required',
            message: 'Kết nối vừa được khôi phục – vui lòng CHECK-IN lại để tiếp tục làm việc!'
          }));
        }
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
          console.log(`🚀 DA ghi log login `);
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
            }
          ws.send(JSON.stringify({ success: true, type: status }));
          console.log(`🚀 DA ghi log-work ${status}`);
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
          console.log(`🚀 DA ghi log-break ${status}`);
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
          console.log(`🚀 DA ghi log-incident ${status}`);
          break;
        }
        // ---------------- ACTIVE/ NOACTIVE --------------
        // ---------------- DISTRACTION ----------------
        case 'log-distraction': {
          const { status, note, created_at } = msg;
          await pool.query(
            `INSERT INTO distraction_sessions (account_id, status, note, created_at)
             VALUES ($1, $2, $3, $4)`,
            [account_id, status || 'unknown', note || '', created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          console.log(`🚀 Da gui log active/noactive `);
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
          if (status === 'checkout') {
            checkinStatus.set(account_id, false);
            ws.isCheckout = true;
          }
          ws.send(JSON.stringify({ success: true, type: 'log-loginout', status }));
          console.log(`🚀 DA ghi log-loginout ${status}`);
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
          console.log(`🚀 Da luu log screen `);
          break;
        }

        // ---------------- CHECK ALIVE ----------------
        case 'check-alive': {
          ws.isAlive = true;
          ws.lastSeen = new Date();
          ws.send(JSON.stringify({ type: 'alive' }));
          console.log(`🚀 alive `);
          break;
        }

        default:
          ws.send(JSON.stringify({ success: false, error: 'Unknown message type' }));
      }
    } catch (err) {
      console.error('❌ Error parsing message:', err);
      ws.send(JSON.stringify({ success: false, error: 'Invalid message format' }));
    }
  });

  // ───────── CLOSE EVENT ─────────
  ws.on('close', () => {
    const id = ws.account_id || [...clients.entries()]
      .find(([k, e]) => e[source] === ws)?.[0];
    if (!id) return console.log('⚠️ Không tìm thấy account_id khi close.');

    console.log(`🚪 ${source} socket closed – account ${id}`);
    if (ws.source === 'background' && checkinStatus.get(id) === true && !ws.isCheckout) {
      handleSudden(id);
      checkinStatus.delete(id);
    }
    removeClient(id, source);
  });

  ws.on('error', (err) => console.error('❌ WebSocket error:', err));
});

// HEARTBEAT CHECK
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUTS_ALLOWED = 2;

setInterval(() => {
  const now = Date.now();
  for (const [account_id, clientSet] of clients.entries()) {
    const ws = clientSet.background;
    if (!ws) continue;

    const lastSeen = ws.lastSeen?.getTime() || 0;
    if (now - lastSeen > HEARTBEAT_INTERVAL * HEARTBEAT_TIMEOUTS_ALLOWED) {
      console.log(`⚠️ Sự cố ping/pong – đánh dấu sudden cho ${account_id}`);
      handleSudden(account_id);
      ws.terminate();
      removeClient(account_id, 'background');
      continue;
    }

    try {
      ws.ping();
    } catch (err) {
      console.error(`❌ Gửi ping lỗi:`, err);
      ws.terminate();
      removeClient(account_id, 'background');
    }
  }
}, HEARTBEAT_INTERVAL);

server.listen(process.env.PORT || 8999, () => {
  console.log(`🚀 Server listening on port ${process.env.PORT || 8999}`);
  createTables(pool);
});
