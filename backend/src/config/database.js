const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "painel_pedidos",
  max: 10, idleTimeoutMillis: 30000
});
pool.on("error", e => console.error("Pool:", e.message));
const query = async (text, params) => { try { return await pool.query(text, params); } catch(e) { throw e; } };
const testConnection = async () => {
  try { await query("SELECT NOW()"); console.log("Conectado ao PostgreSQL"); return true; }
  catch(e) { console.error("Falha:", e.message); return false; }
};
module.exports = { pool, query, testConnection };