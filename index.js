// server.js – re‑organised logic
// 1. "noactive" dòng client chủ động gửi log-distraction (không ping/pong)
// 2. "sudden" server tự ping/pong để phát hiện mất kết nối

const http = require("http");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");
const fetch = require("node-fetch");
require("dotenv").config();
const createTables = require("./createTables");

/*****************************
 * In‑memory state trackers  *
 *****************************/
const clients = new Map(); // account_id -> ws
const inactivityCounters = new Map(); // account_id -> consecutive missing‑pong count
const checkinStatus = new Map(); // account_id -> boolean|'break-done'
const expectingPong = new Map(); // account_id -> boolean (waiting?)
const flagBreak = new Map(); // account_id -> boolean (on break?)
// 🚫 REMOVED: hasPinged Map – logic "noactive" do client xử lý

/*****************************
 * PostgreSQL pool           *
 *****************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("✅ Database connected successfully."))
  .catch((err) => {
    console.error("❌ Failed to connect to the database:", err);
    process.exit(1);
  });

/*****************************
 * HTTP & WebSocket servers  *
 *****************************/
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Server is alive");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ New client connected.");
  ws.isAlive = true;
  ws.lastSeen = new Date();

  /***********************
   * Incoming messages   *
   ***********************/
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      const { type, account_id } = msg;
      if (!type)
        return ws.send(
          JSON.stringify({ success: false, error: "Missing message type" })
        );

      // bind socket to account
      if (account_id) {
        clients.set(account_id, ws);
        ws.account_id = account_id;
      }

      switch (type) {
        /* ---------------- LOGIN ---------------- */
        case "login": {
          const { username, password } = msg;
          const result = await pool.query(
            "SELECT account_id AS id, full_name AS name FROM accounts WHERE LOWER(username) = $1 AND password = $2",
            [(username || "").toLowerCase().trim(), (password || "").trim()]
          );
          if (result.rows.length) {
            ws.send(JSON.stringify({ success: true, ...result.rows[0] }));
          } else {
            ws.send(
              JSON.stringify({
                success: false,
                error: "Username hoặc mật khẩu không đúng",
              })
            );
          }
          break;
        }

        /* -------------- WORK SESSION -------------- */
        case "log-work": {
          const { status, created_at } = msg;
          await pool.query(
            "INSERT INTO work_sessions (account_id, status, created_at) VALUES ($1, $2, $3)",
            [account_id, status || "unknown", created_at || new Date()]
          );
          if (status === "checkin") {
            checkinStatus.set(account_id, true);
            ws.isAlive = true; // ensure ping loop knows socket OK
          }
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        /* -------------- BREAK SESSION -------------- */
        case "log-break": {
          const { status, created_at } = msg;
          console.log(
            `Received break status: ${status}, for account_id: ${account_id}`
          );

          if (status === "break") {
            flagBreak.set(account_id, true); // stop ping during break
            ws.isAlive = false;
            expectingPong.set(account_id, false);
          } else if (status === "break-done") {
            flagBreak.set(account_id, false);
            ws.isAlive = true;
            expectingPong.set(account_id, false);
            inactivityCounters.set(account_id, 0);
            checkinStatus.set(account_id, true);
          }

          await pool.query(
            "INSERT INTO break_sessions (account_id, status, created_at) VALUES ($1, $2, $3)",
            [account_id, status || "unknown", created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        /* -------------- INCIDENT SESSION -------------- */
        case "log-incident": {
          const { status, reason, created_at } = msg;
          await pool.query(
            "INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)",
            [
              account_id,
              status || "unknown",
              reason || "",
              created_at || new Date(),
            ]
          );
          ws.send(JSON.stringify({ success: true, type: status }));
          break;
        }

        /* -------------- LOGIN/LOGOUT -------------- */
        case "log-loginout": {
          const { status, created_at } = msg;
          await pool.query(
            "INSERT INTO login_logout_sessions (account_id, status, created_at) VALUES ($1, $2, $3)",
            [account_id, status, created_at || new Date()]
          );
          if (status === "checkout") checkinStatus.set(account_id, false);
          ws.send(
            JSON.stringify({ success: true, type: "log-loginout", status })
          );
          break;
        }

        /* -------------- SCREENSHOT -------------- */
        case "log-screenshot": {
          const { hash, created_at } = msg;
          await pool.query(
            "INSERT INTO photo_sessions (account_id, hash, created_at) VALUES ($1, $2, $3)",
            [account_id, hash, created_at || new Date()]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        /* -------------- DISTRACTION (noactive) -------------- */
        // "noactive" logic được xử lý phía client: client tự gửi ACTIVE / NO ACTIVE ON TAB
        case "log-distraction": {
          const { status, note, created_at } = msg;
          await pool.query(
            "INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)",
            [
              account_id,
              status || "unknown",
              note || "",
              created_at || new Date(),
            ]
          );
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        /* -------------- PONG -------------- */
        case "pong": {
          if (expectingPong.get(account_id)) {
            expectingPong.set(account_id, false);
            inactivityCounters.set(account_id, 0); // reset sudden counter
          }
          ws.isAlive = true;
          ws.lastSeen = new Date();
          break;
        }

        default:
          ws.send(
            JSON.stringify({ success: false, error: "Unknown message type" })
          );
      }
    } catch (err) {
      console.error("❌ Error processing message:", err);
      ws.send(JSON.stringify({ success: false, error: err.message }));
    }
  });

  /***********************
   * Socket closed       *
   ***********************/
  ws.on("close", () => {
    console.log("🚪 Client disconnected.");
    if (ws.account_id) {
      clients.delete(ws.account_id);
      inactivityCounters.delete(ws.account_id);
      checkinStatus.delete(ws.account_id);
      expectingPong.delete(ws.account_id);
      flagBreak.delete(ws.account_id);
    }
  });
});

/*****************************
 * Helper functions          *
 *****************************/
function shouldPing(account_id) {
  // ping only when user is checked‑in & not on break
  const status = checkinStatus.get(account_id);
  return status === true || status === "break-done";
}

function logDistraction(account_id, status, note = 0) {
  const timestamp = new Date();
  pool
    .query(
      "INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)",
      [account_id, status, note, timestamp]
    )
    .catch((err) => console.error("❌ Failed to log distraction:", err));
}

/*****************************
 * Sudden‑only ping loop     *
 *****************************/
setInterval(() => {
  const now = new Date();

  for (const [account_id, ws] of clients.entries()) {
    if (!shouldPing(account_id)) continue; // chưa check‑in hoặc đang break
    if (ws.readyState !== ws.OPEN) continue; // socket không mở
    if (flagBreak.get(account_id)) continue; // đang break

    // Đã gửi ping 10s trước nhưng chưa nhận pong → tăng counter
    if (expectingPong.get(account_id)) {
      const count = (inactivityCounters.get(account_id) || 0) + 1;
      inactivityCounters.set(account_id, count);

      if (count >= 30) {
        // ≈ 5 phút không có pong → SUDDEN
        console.warn(
          `⚠️ No pong from ${account_id} for 5 minutes. Logging SUDDEN.`
        );
        pool.query(
          "INSERT INTO incident_sessions (account_id, status, reason, created_at) VALUES ($1, $2, $3, $4)",
          [account_id, "SUDDEN", "Client inactive > 5min", now]
        );

        try {
          ws.send(
            JSON.stringify({
              type: "force-checkin",
              message: "SUDDEN - Please check in again to work",
            })
          );
        } catch (e) {
          console.error(
            "❌ Failed to send force-checkin to client:",
            e.message
          );
        }

        ws.terminate();
        clients.delete(account_id);
        inactivityCounters.delete(account_id);
        checkinStatus.delete(account_id);
        expectingPong.delete(account_id);
        flagBreak.delete(account_id);
        continue; // move to next client
      }
    }

    // Gửi ping (chỉ phục vụ phát hiện SUDDEN)
    ws.isAlive = false;
    expectingPong.set(account_id, true);
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      console.error("❌ Failed to send ping to", account_id);
    }
  }
}, 10000);

/*****************************
 * Keep‑alive to Railway     *
 *****************************/
setInterval(() => {
  fetch("https://chromextension-production.up.railway.app")
    .then(() =>
      console.log("🔄 Self‑ping success at", new Date().toISOString())
    )
    .catch((err) => console.error("❌ Self‑ping error:", err.message));
}, 1000);

/*****************************
 * Bootstrap + shutdown      *
 *****************************/
createTables()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () =>
      console.log(`✅ WebSocket server running on ws://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ Failed to create tables:", err);
    process.exit(1);
  });

process.on("SIGTERM", () => {
  console.log("Application is shutting down...");
  pool.end(() => {
    console.log("Database connection closed");
    process.exit(0);
  });
});
