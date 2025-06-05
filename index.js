const http = require('http');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const server = http.createServer(async (req, res) => {
  // Login Email + Password
  if (req.method === 'POST' && req.url === '/login') {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { email, password } = JSON.parse(body);
      const result = await pool.query(
        'SELECT * FROM account WHERE email = $2 AND password = $3',
        [email, password]
      );

      if (result.rows.length > 0) {
        const user = result.rows[0];
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, userId: user.id, username: user.username }));
      } else {
        res.writeHead(401, { 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, message: 'Invalid credentials' }));
      }
    } catch (err) {
      console.error("❌ LOGIN ERROR:", err);
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      res.end('Login failed');
    }
  });
}


  // Send log action//
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { userId, action, timestamp } = data;

        await pool.query(
          'INSERT INTO logs(userId, action, timestamp) VALUES ($1, $2, $3)',
          [userId, action, timestamp]
        );

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        console.error("❌ INSERT ERROR:", err);
        console.error("Body received:", body);
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
        res.end('Error while inserting log');
      }
    });
  } else {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running at port ${PORT}`);
});
