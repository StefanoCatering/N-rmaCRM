require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 8765,
  SESSION_SECRET: process.env.SESSION_SECRET || 'narma-crm-dev-secret',
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Días sin pedir a partir de los cuales un cliente entra en estado de alerta
  ALERT_DAYS: 15,

  // Conexión a PostgreSQL (Supabase) — ver .env / .env.example
  DB_HOST: process.env.DB_HOST,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_PORT: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
};
