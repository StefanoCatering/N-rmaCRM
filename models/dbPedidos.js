// Conexión a la base del proyecto Narma Pedidos (Supabase rgppcvqoephcjjcnqwnz),
// donde vive pedidos_crm_detalle. Es una SEGUNDA base, distinta de la del CRM
// (models/db.js): son dos proyectos Supabase separados.
//
// A diferencia de models/db.js, acá la falta de la variable de entorno NO tira
// abajo el proceso. El CRM tiene que poder guardar pedidos aunque la conexión a
// Pedidos no esté configurada o esté caída (requisito 9.c). Cuando no está
// configurada, el sync queda deshabilitado y cada intento se registra en
// sync_errores, así el silencio no pasa desapercibido.
require('dotenv').config();
const { Pool } = require('pg');

const { PEDIDOS_DATABASE_URL } = process.env;

let pool = null;

if (PEDIDOS_DATABASE_URL) {
  pool = new Pool({
    connectionString: PEDIDOS_DATABASE_URL,
    // Supabase requiere SSL; mismo modo que usa models/db.js.
    ssl: { rejectUnauthorized: false },
    // El sync corre dentro del request del CRM: más vale fallar rápido y
    // registrar el error que dejar al usuario esperando.
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 10000,
  });

  pool.on('error', (err) => {
    console.error('[dbPedidos] Error inesperado en el pool de Narma Pedidos:', err.message);
  });

  console.log('[dbPedidos] Sync hacia Narma Pedidos HABILITADO (PEDIDOS_DATABASE_URL configurada)');
} else {
  console.warn(
    '[dbPedidos] PEDIDOS_DATABASE_URL no está configurada: el sync hacia Narma Pedidos ' +
    'queda DESHABILITADO. Los pedidos se guardan normalmente en el CRM y cada intento ' +
    'de sync se registra en la tabla sync_errores para poder reenviarlo después.'
  );
}

module.exports = { pool, habilitado: () => pool !== null };
