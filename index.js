require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// CORS config (fix CORS cho Chrome Extension)
const extensionOrigin = 'chrome-extension://odhkdfokogfliiiolhpkhbglpappmjlk';

app.use(cors({
  origin: function (origin, callback) {
    // Cho phép nếu không có origin (ex: curl, Postman) hoặc đúng extension ID
    if (!origin || origin === extensionOrigin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  optionsSuccessStatus: 200
}));

// Xử lý tất cả OPTIONS requests (preflight)
app.options('*', cors());

app.use(express.json());

app.post('/log', async (req, res) => {
  const { user, action } = req.body;

  if (!user || !['login', 'logout'].includes(action)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    await pool.query(
      'INSERT INTO Log (username, action, log_time) VALUES ($1, $2, NOW())',
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
