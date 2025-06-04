const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const query = "SELECT * FROM accounts WHERE username=$1 AND password=$2";
    const values = [email, password];
    const result = await pool.query(query, values);

    if (result.rows.length > 0) {
      const user = result.rows[0];
      res.json({ username: user.username, full_name: user.full_name });
    } else {
      res.status(401).json({ message: "Invalid credentials" });
    }
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
