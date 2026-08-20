import 'dotenv/config';
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import pg from "pg";

// Usage:
//   ADMIN_EMAIL=x ADMIN_PASSWORD=y node scripts/create-admin.js
//   node scripts/create-admin.js [email] [password]
// When no password is provided, a random one is generated and printed once.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const email = process.env.ADMIN_EMAIL || process.argv[2] || "admin@manda4.com.br";
const providedPassword = process.env.ADMIN_PASSWORD || process.argv[3];
const password = providedPassword || crypto.randomBytes(12).toString("hex");

const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
  "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, role",
  [email, hash, "admin"]
);

if (rows.length) {
  console.log(JSON.stringify(rows[0]));
  console.log(providedPassword
    ? `Senha definida via argumento/env para ${email}`
    : `Senha gerada para ${email}: ${password} (guarde agora — não é exibida de novo)`);
} else {
  console.log("User already exists");
}
await pool.end();
