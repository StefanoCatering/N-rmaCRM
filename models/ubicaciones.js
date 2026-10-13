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
//
// Actualiza las filas existentes por posición y borra solo las sobrantes, en
// lugar de DELETE + INSERT. Es a propósito: desde la fase 6 pedidos.ubicacion_id
// referencia ubicaciones(id), y un DELETE de todas las filas en cada edición de
// cliente dejaba en NULL (por el ON DELETE SET NULL) la ubicación de todos los
// pedidos de ese cliente, aunque la dirección no hubiera cambiado.
async function replaceForCliente(clienteId, ubicaciones) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existentes = (await client.query(
      'SELECT id FROM ubicaciones WHERE cliente_id = $1 ORDER BY orden ASC, id ASC',
      [clienteId]
    )).rows;

    let orden = 1;
    for (const u of ubicaciones) {
      const campos = [u.direccion || null, u.zona || null, u.referencia || null];
      const existente = existentes[orden - 1];
      if (existente) {
        await client.query(
          `UPDATE ubicaciones SET orden = $1, direccion = $2, zona = $3, referencia = $4
           WHERE id = $5`,
          [orden, ...campos, existente.id]
        );
      } else {
        await client.query(
          `INSERT INTO ubicaciones (cliente_id, orden, direccion, zona, referencia)
           VALUES ($1, $2, $3, $4, $5)`,
          [clienteId, orden, ...campos]
        );
      }
      orden++;
    }

    // Las que quedaron de más (el cliente tenía 3 y ahora tiene 2) sí se borran.
    // Si alguna estaba referenciada por un pedido, el FK la pone en NULL.
    const sobrantes = existentes.slice(ubicaciones.length).map(e => e.id);
    if (sobrantes.length) {
      await client.query('DELETE FROM ubicaciones WHERE id = ANY($1::int[])', [sobrantes]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ¿La ubicación existe y pertenece a ese cliente? Se usa para validar
// pedidos.ubicacion_id y evitar que un pedido apunte a la dirección de otro.
async function belongsToCliente(ubicacionId, clienteId) {
  const r = await pool.query(
    'SELECT 1 FROM ubicaciones WHERE id = $1 AND cliente_id = $2',
    [ubicacionId, clienteId]
  );
  return r.rows.length > 0;
}

module.exports = { listByCliente, replaceForCliente, belongsToCliente };
