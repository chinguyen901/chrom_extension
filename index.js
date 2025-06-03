// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 8080; // Railway sẽ set PORT=8080, local dùng 3000 nếu muốn

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());

app.post('/log', async (req, res) => {
  const { user, action } = req.body;

  if (!user || !['login', 'logout'].includes(action)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    await pool.query(
      'INSERT INTO logs (username, action, log_time) VALUES ($1, $2, NOW())',
      [user, action]
    );
    res.status(200).json({ message: 'Log saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => {
  res.send('Client Logger Backend is running.');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
