// createTables.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const createTables = async () => {
  try {
    console.log('🛠️ Đang kiểm tra và tạo các bảng nếu cần...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id     SERIAL PRIMARY KEY,
        username       VARCHAR(50) NOT NULL UNIQUE,
        password       VARCHAR(100) NOT NULL,
        employee_code  VARCHAR(20) NOT NULL UNIQUE,
        full_name      VARCHAR(100) NOT NULL,
        type           VARCHAR(20) CHECK (type IN ('seo online', 'copy writer', 'linkbuilder', 'dev')) NOT NULL,
        random_from    INT DEFAULT 300,
        random_to      INT DEFAULT 600,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS photo_sessions (
        photo_id     SERIAL PRIMARY KEY,
        account_id   INT NOT NULL REFERENCES accounts(account_id),
        hash         VARCHAR(255) NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS work_sessions (
        session_id   SERIAL PRIMARY KEY,
        account_id   INT NOT NULL REFERENCES accounts(account_id),
        status       VARCHAR(20) CHECK (status IN ('checkin', 'checkout')) NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS break_sessions (
        break_id     SERIAL PRIMARY KEY,
        account_id   INT NOT NULL REFERENCES accounts(account_id),
        status       VARCHAR(20) CHECK (status IN ('break_start', 'break_end')) NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS distraction_sessions (
        distraction_id   SERIAL PRIMARY KEY,
        account_id       INT NOT NULL REFERENCES accounts(account_id),
        status           VARCHAR(20) NOT NULL,
        note             TEXT,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS incident_sessions (
        incident_id  SERIAL PRIMARY KEY,
        account_id   INT NOT NULL REFERENCES accounts(account_id),
        status       VARCHAR(255) NOT NULL,
        reason       TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS login_logout_session (
        log_id      SERIAL PRIMARY KEY,
        account_id  INT NOT NULL REFERENCES accounts(account_id),
        status      VARCHAR(20) CHECK (status IN ('login', 'logout')) NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Đã tạo bảng (nếu chưa tồn tại).');
  } catch (error) {
    console.error('❌ Lỗi khi tạo bảng:', error.message);
  }
};

module.exports = createTables;
