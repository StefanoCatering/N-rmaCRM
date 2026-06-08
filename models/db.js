const { Pool } = require('pg');
const config = require('../config');

// Pool de conexiones a PostgreSQL (Supabase). Las credenciales se leen desde
// variables de entorno (ver config.js / .env / .env.example) — nunca se
// hardcodean acá para poder rotarlas sin tocar código.
const pool = new Pool({
  host: config.DB_HOST,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  port: config.DB_PORT,
  // Supabase requiere SSL; en este modo no se valida la cadena de certificados
  // (igual que recomienda la documentación de Supabase para conexiones desde apps).
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL:', err);
});

module.exports = pool;
