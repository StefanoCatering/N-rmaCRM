const pool = require('./db');

async function listByCliente(clienteId) {
  const result = await pool.query(
    'SELECT id, orden, direccion, zona, referencia FROM ubicaciones WHERE cliente_id = $1 ORDER BY orden ASC',
    [clienteId]
  );
  return result.rows;
}

// Reemplaza todas las ubicaciones de un cliente por la lista dada (hasta 3).
// ubicaciones: [{ direccion, zona, referencia }, ...] — orden = posición en el array (1-based).
async function replaceForCliente(clienteId, ubicaciones) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ubicaciones WHERE cliente_id = $1', [clienteId]);
    let orden = 1;
    for (const u of ubicaciones) {
      await client.query(
        `INSERT INTO ubicaciones (cliente_id, orden, direccion, zona, referencia)
         VALUES ($1, $2, $3, $4, $5)`,
        [clienteId, orden, u.direccion || null, u.zona || null, u.referencia || null]
      );
      orden++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listByCliente, replaceForCliente };
