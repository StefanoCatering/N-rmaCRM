const pool = require('./db');

async function listByCliente(clienteId) {
  const result = await pool.query(
    'SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY fecha_pedido DESC, id DESC',
    [clienteId]
  );
  return result.rows;
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

module.exports = { listByCliente, create };
