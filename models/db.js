// Las credenciales de la base de datos se leen EXCLUSIVAMENTE de variables de
// entorno. No existe ningún valor por defecto para las credenciales — si alguna
// variable falta, el proceso arranca con un error claro en lugar de conectar
// silenciosamente a otro host (comportamiento por defecto del driver pg).
require('dotenv').config();
const { Pool } = require('pg');

const {
  DB_HOST,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_PORT = '5432',
} = process.env;

// Validación de arranque: falla inmediato con mensaje claro si falta alguna variable.
const faltantes = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter(
  (k) => !process.env[k]
);
if (faltantes.length) {
  throw new Error(
    `Faltan variables de entorno requeridas para la base de datos: ${faltantes.join(', ')}\n` +
    'Revisá el dashboard de Vercel (Settings → Environment Variables) o tu archivo .env local.'
  );
}

// Log de diagnóstico: muestra el host al que se conecta (sin credenciales).
// Visible en los logs de Vercel → Functions → Runtime Logs.
console.log(`[db] Conectando a PostgreSQL → host=${DB_HOST} port=${DB_PORT} db=${DB_NAME} user=${DB_USER}`);

const pool = new Pool({
  host: DB_HOST,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  port: Number(DB_PORT),
  // Supabase requiere SSL. rejectUnauthorized:false es el modo recomendado
  // por Supabase para conexiones desde aplicaciones web/serverless.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] Error inesperado en el pool de PostgreSQL:', err.message);
});

module.exports = pool;
