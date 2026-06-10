const pool = require('./db');

async function listByCliente(clienteId) {
  const result = await pool.query(
    'SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY fecha_pedido DESC, id DESC',
    [clienteId]
  );
  return result.rows;
}

// Historial de pedidos con filtros (vista de pedidos para admin/operador).
// filtros: { cliente_id, fecha_desde, fecha_hasta, estado } — todos opcionales.
// estado se aplica al estado del CLIENTE (no del pago).
async function listFiltered({ cliente_id, fecha_desde, fecha_hasta, estado } = {}) {
  const where = [];
  const params = [];
  let idx = 1;

  if (cliente_id)  { where.push(`p.cliente_id = $${idx++}`);  params.push(cliente_id); }
  if (fecha_desde) { where.push(`p.fecha_pedido >= $${idx++}`); params.push(fecha_desde); }
  if (fecha_hasta) { where.push(`p.fecha_pedido <= $${idx++}`); params.push(fecha_hasta); }
  if (estado)      { where.push(`c.estado = $${idx++}`);       params.push(estado); }

  const sql = `
    SELECT
      p.id, p.fecha_pedido, p.monto, p.descripcion,
      c.id AS cliente_id, c.nombre_completo, c.cedula, c.segmento, c.estado
    FROM pedidos p
    JOIN clientes c ON c.id = p.cliente_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.fecha_pedido DESC, p.id DESC
  `;
  return (await pool.query(sql, params)).rows;
}

async function create({ cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion }) {
  const result = await pool.query(
    `INSERT INTO pedidos
       (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      cliente_id,
      fecha_pedido,
      monto,
      monto_pagado === undefined || monto_pagado === null ? null : monto_pagado,
      estado_pago || 'pendiente',
      medio_pago || null,
      tipo_vianda || null,
      descripcion || null,
    ]
  );
  return result.rows[0];
}

module.exports = { listByCliente, create, listFiltered };
