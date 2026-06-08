const db = require('./db');

function listByCliente(clienteId) {
  return db
    .prepare('SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY fecha_pedido DESC, id DESC')
    .all(clienteId);
}

function create({ cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion }) {
  const stmt = db.prepare(
    `INSERT INTO pedidos
      (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    cliente_id,
    fecha_pedido,
    monto,
    monto_pagado === undefined || monto_pagado === null ? null : monto_pagado,
    estado_pago || 'pendiente',
    medio_pago || null,
    tipo_vianda || null,
    descripcion || null
  );
  return db.prepare('SELECT * FROM pedidos WHERE id = ?').get(Number(info.lastInsertRowid));
}

module.exports = { listByCliente, create };
