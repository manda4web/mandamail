import bcrypt from "bcrypt";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hash = await bcrypt.hash("Admin@2024", 12);
const { rows } = await pool.query(
  "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, role",
  ["admin@manda4.com.br", hash, "admin"]
);
console.log(rows.length ? JSON.stringify(rows[0]) : "User already exists");
await pool.end();
