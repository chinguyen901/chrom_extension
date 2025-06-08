/*****************************
 * In‑memory state trackers  *
 *****************************/
const clients = new Map(); // account_id -> ws
const inactivityCounters = new Map(); // account_id -> consecutive missing‑pong count
const checkinStatus = new Map(); // account_id -> boolean|'break-done'
const expectingPong = new Map(); // account_id -> boolean (waiting?)
const flagBreak = new Map(); // account_id -> boolean (on break?)
const inactivityNote = new Map(); // account_id -> number of noactive count

/*****************************
 * Incoming messages   *
 *****************************/
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

        /* -------------- DISTRACTION (noactive) -------------- */
        case "log-distraction": {
          const { status, note, created_at } = msg;
          
          // Lưu trạng thái 'active' / 'noactive' vào bảng distraction_sessions
          const timestamp = new Date();
          if (status === "NO ACTIVE") {
            // Tăng số lần "noactive" nếu là "NO ACTIVE"
            if (!inactivityNote.has(account_id)) {
              inactivityNote.set(account_id, 0);
            }
            inactivityNote.set(account_id, inactivityNote.get(account_id) + 1);
          } else {
            inactivityNote.set(account_id, 0); // Reset count if active
          }
          
          // Ghi vào bảng distraction_sessions
          await pool.query(
            "INSERT INTO distraction_sessions (account_id, status, note, created_at) VALUES ($1, $2, $3, $4)",
            [
              account_id,
              status || "unknown",
              inactivityNote.get(account_id) || 0,
              created_at || timestamp,
            ]
          );

          // Phản hồi lại client
          ws.send(JSON.stringify({ success: true }));
          break;
        }

        /* ---------------- PONG ---------------- */
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
      inactivityNote.delete(ws.account_id);
    }
  });
});

/*****************************
 * Helper functions          *
 *****************************/
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

