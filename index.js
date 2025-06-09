// ────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE MAPS
// ────────────────────────────────────────────────────────────────────────────
const clients = new Map();  // account_id → ws
const inactivityCounters = new Map();
const checkinStatus = new Map();  // account_id → boolean (đang check-in?)
const hasPinged = new Map();
const expectingPong = new Map();
const lastPingSentAt = new Map();

// ────────────────────────────────────────────────────────────────────────────
// PING / PONG CONFIG
// ────────────────────────────────────────────────────────────────────────────
const PING_INTERVAL = 20_000;  // 20s interval to send ping
const PONG_TIMEOUT = 15_000;   // Timeout for waiting pong response (15s)

function shouldPing(account_id) {
  return checkinStatus.get(account_id) === true;
}

async function handleSudden(account_id, ws = null) {
  try {
    // Kiểm tra nếu là socket đã mở hoặc mất kết nối (có thể mạng bị mất, không nhận được pong)
    if (ws && ws.readyState !== ws.OPEN) {
      // Nếu socket đã đóng, ta mới ghi log sudden
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
      
      // Báo cho extension về kết nối mất ổn định
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'sudden',
          status: 'checkin-required',
          message: 'Kết nối mất ổn định – vui lòng CHECK-IN lại để tiếp tục làm việc!'
        }));
      }
    }
  } catch (err) {
    console.error('❌ Error in handleSudden:', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DATABASE POOL
// ────────────────────────────────────────────────────────────────────────────
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
  ws.isAlive = true;
  ws.lastSeen = new Date();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const { type, account_id } = msg;
      if (!type) return ws.send(JSON.stringify({ success: false, error: "Missing message type" }));

      // Map socket ↔ account_id
      if (account_id) {
        clients.set(account_id, ws);
        ws.account_id = account_id;
        inactivityCounters.set(account_id, 0);
      }

      switch (type) {
        case 'ping': {
          console.log("Ping received, sending pong...");

          // Gửi pong ngay lập tức khi nhận ping
          const account_id = await getLocalStorage("account_id");
          const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
          safeSend(JSON.stringify({
            type: "pong",
            account_id,
            created_at: timestamp
          }));
          break;
        }

        case 'log-work':
          // Handle log-work logic...
          break;

        // Handle other cases...

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

    // Kiểm tra và chỉ gọi handleSudden khi trạng thái checkinStatus là true
    if (ws.account_id && checkinStatus.get(ws.account_id)) {
      handleSudden(ws.account_id, ws);   // Ghi log sudden nếu client bị mất kết nối
    }

    // Dọn dẹp map
    if (ws.account_id) {
      clients.delete(ws.account_id);
      inactivityCounters.delete(ws.account_id);
      checkinStatus.delete(ws.account_id);
      hasPinged.delete(ws.account_id);
      expectingPong.delete(ws.account_id);
      lastPingSentAt.delete(ws.account_id);
    }
  });
});

// ───────── GLOBAL PING LOOP ─────────
setInterval(() => {
  for (const [account_id, ws] of clients.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!shouldPing(account_id)) continue;

    // Gửi ping mà không kiểm tra checkTabActive
    if (checkinStatus.get(account_id)) {
      ws.send(JSON.stringify({ type: 'ping' }));
      expectingPong.set(account_id, true);
      lastPingSentAt.set(account_id, Date.now());
    }
  }
}, PING_INTERVAL);

// Kiểm tra và gửi log sudden nếu không nhận được pong trong thời gian timeout
setInterval(() => {
  for (const [account_id, ws] of clients.entries()) {
    if (ws.readyState !== ws.OPEN) continue;

    // Kiểm tra nếu đang chờ pong và không nhận được phản hồi trong thời gian timeout
    if (expectingPong.get(account_id)) {
      const lastPing = lastPingSentAt.get(account_id) || 0;
      if (Date.now() - lastPing > PONG_TIMEOUT) {
        console.log(`[PING] Timeout for ${account_id}, logging sudden...`);
        handleSudden(account_id, ws);  // Ghi log sudden nếu không nhận được pong hợp lệ
      }
      continue; // Nếu vẫn đang chờ pong, tiếp tục gửi ping
    }
  }
}, PONG_TIMEOUT);

// ────────────────────────────────────────────────────────────────────────────
// SELF-PING (giữ Railway không ngủ)
// ────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  fetch('https://chromextension-production.up.railway.app')
    .then(() => console.log('🔄 Self-ping success at', new Date().toISOString()))
    .catch(err => console.error('❌ Self-ping error:', err.message));
}, 5_000);  // 5s self-ping để giữ Railway không ngủ

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
