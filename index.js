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
const { WebSocketServer } = require('ws');
const { Pool }            = require('pg');
require('dotenv').config();
const createTables        = require('./createTables');

// ────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE MAPS
// ────────────────────────────────────────────────────────────────────────────
// account_id → { background?: WebSocket, popup?: WebSocket }
const clients            = new Map();
const checkinStatus      = new Map();
const checkinAgain      = False;   // account_id → boolean (đang check‑in?)


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
      checkinStatus.set(account_id, false);
      checkinAgain = True;
      console.log(`🚀 Da ghi log SUDDEN `);
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
  ws.source = source; // lưu lại loại kết nối

  console.log(`✅ New ${source} socket connected.`);
  ws.isAlive = true;
  ws.lastSeen = new Date();
  ws.account_id = null; // KHỞI TẠO
  if (checkinAgain) {
    console.log(`🚀 Gui message checkin again ve client `);
    ws.send(JSON.stringify({
      type   : 'force-checkin',
      status : 'checkin-required',
      message: 'Kết nối mất ổn định – vui lòng CHECK-IN lại để tiếp tục làm việc!'
    }));
  }

  // ───────── MESSAGE HANDLER ─────────
  ws.on('message', async (data) => {
    try {
      let msg;
      if (typeof data === 'string') {
        msg = JSON.parse(data);
      } else if (Buffer.isBuffer(data)) {
        msg = JSON.parse(data.toString());
      } else {
        throw new Error('Received data is not a valid JSON string or Buffer');
      }

      const { type, account_id } = msg;
      if (!type) return ws.send(JSON.stringify({ success: false, error: 'Missing message type' }));

      // Map socket ↔ account_id
      console.log(`📢 Check account id`, account_id);
      if (account_id) {
        ws.account_id = account_id;          // LUÔN cập nhật ws.account_id
        setClient(account_id, ws.source, ws);
        console.log(`📢 source ${source} ---- needsCheckin : ${needsCheckin.get(account_id)}`);
        if (source === 'background' && needsCheckin.get(account_id)) {
          ws.send(JSON.stringify({
            type: 'force-checkin',
            status: 'checkin-required',
            message: 'Bạn vừa mất kết nối. Vui lòng Check‑in lại.'
          }));
          needsCheckin.delete(account_id);
          console.log(`📢 Đã gửi force-checkin sau reconnect cho account`, account_id);
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
    console.log(`🚪 ${ws.source} socket disconnected.`);

    let id = ws.account_id ;

    // Nếu chưa có, tìm trong clients map
    if (!id) {
      for (const [acc_id, entry] of clients.entries()) {
        if (entry[ws.source] === ws) {
          id = acc_id;
          break;
        }
      }
    }

    if (!id) {
      console.log('⚠️ Không tìm thấy account_id của socket khi close.');
      return; // Không xử lý tiếp
    }
    const isCheckin = checkinStatus.get(id);

    console.log(`🚪 ${ws.source} --- Checkin: ${isCheckin} | ID: ${id}`);

    if (
      ws.source === 'background' &&
      isCheckin &&
      ws.isCheckout !== true
    ) {
      console.log(`🚪 ${ws.source} ➜ Ghi log sudden.`);
      handleSudden(id, ws);
      checkinStatus.delete(id);
    }
    removeClient(id, ws.source);
  });

  // ───────── ERROR EVENT ─────────
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// KHỞI ĐỘNG SERVER
// ────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8999;

// ────────────────────────────────────────────────────────────────────────────
// HEARTBEAT CHECK: Phát hiện client mất mạng (background only)
// ────────────────────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL = 30000; // mỗi 30s gửi 1 ping
const HEARTBEAT_TIMEOUTS_ALLOWED = 2;

setInterval(() => {
  const now = Date.now();

  for (const [account_id, clientSet] of clients.entries()) {
    const ws = clientSet.background;
    if (!ws) continue;

    const lastSeen = ws.lastSeen?.getTime?.() || 0;
    const isTimedOut = now - lastSeen > HEARTBEAT_INTERVAL * HEARTBEAT_TIMEOUTS_ALLOWED;

    if (isTimedOut) {
      console.warn(`⚠️ Không nhận được phản hồi từ ${account_id} ➜ Ghi log SUDDEN và ngắt kết nối.`);
        // Gửi message yêu cầu client check-in lại (nếu socket còn mở)
      handleSudden(account_id, ws);
      ws.terminate();
      removeClient(account_id, 'background');
      continue;
    }

    try {
      ws.ping(); // client sẽ tự động trả pong
    } catch (err) {
      console.error(`❌ Lỗi khi gửi ping tới ${account_id}:`, err);
      ws.terminate();
      removeClient(account_id, 'background');
    }
  }
}, HEARTBEAT_INTERVAL);


server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  createTables(pool); // Tạo bảng nếu chưa tồn tại
});
