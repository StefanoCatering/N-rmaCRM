const pool = require('./db');

async function listByCliente(clienteId) {
  const result = await pool.query(
    'SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY fecha_pedido DESC, id DESC',
    [clienteId]
  );
  return result.rows;
}

async function getById(id) {
  const result = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// Actualiza solo el estado de pago y el monto pagado de un pedido existente.
async function updatePago(id, estado_pago, monto_pagado) {
  const result = await pool.query(
    `UPDATE pedidos SET estado_pago = $1, monto_pagado = $2 WHERE id = $3 RETURNING *`,
    [estado_pago, monto_pagado === undefined ? null : monto_pagado, id]
  );
  return result.rows[0] || null;
}

// Actualiza campos editables de un pedido (monto, fecha_pedido, tipo_vianda) y registra
// en pedidos_auditoria el detalle de los campos que efectivamente cambiaron.
// pedidoActual: fila de pedidos antes del cambio (para armar el detalle anterior/nuevo).
// cambios: objeto solo con los campos provistos en el request.
async function update(id, pedidoActual, cambios, usuario, motivo) {
  const campos = Object.keys(cambios);
  const sets = campos.map((campo, i) => `${campo} = $${i + 1}`);
  const params = campos.map(campo => cambios[campo]);
  params.push(id);

  const result = await pool.query(
    `UPDATE pedidos SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  const actualizado = result.rows[0];

  const detalle = {};
  for (const campo of campos) {
    detalle[campo] = { anterior: pedidoActual[campo], nuevo: cambios[campo] };
  }
  await pool.query(
    `INSERT INTO pedidos_auditoria (pedido_id, accion, usuario, detalle, motivo)
     VALUES ($1, 'edicion', $2, $3, $4)`,
    [id, usuario, JSON.stringify(detalle), motivo]
  );

  return actualizado;
}

// Marca un pedido como cancelado y registra la auditoría (sin detalle de campos).
async function cancelar(id, usuario, motivo) {
  const result = await pool.query(
    `UPDATE pedidos SET cancelado = true WHERE id = $1 RETURNING *`,
    [id]
  );
  const actualizado = result.rows[0];

  await pool.query(
    `INSERT INTO pedidos_auditoria (pedido_id, accion, usuario, detalle, motivo)
     VALUES ($1, 'cancelacion', $2, NULL, $3)`,
    [id, usuario, motivo]
  );

  return actualizado;
}

// Historial de auditoría (ediciones y cancelaciones) de un pedido, más reciente primero.
async function listAuditoria(pedidoId) {
  const result = await pool.query(
    `SELECT * FROM pedidos_auditoria WHERE pedido_id = $1 ORDER BY fecha DESC`,
    [pedidoId]
  );
  return result.rows;
}

// Historial de pedidos con filtros (vista de pedidos para admin/operador).
// filtros: { cliente_id, fecha_desde, fecha_hasta, estado, estado_pago, tipo_vianda,
//            segmento, canal_origen } — todos opcionales.
// estado se aplica al estado del CLIENTE (no del pago).
// tipo_vianda acepta el sentinel 'sin_vianda' para filtrar pedidos sin vianda (tipo_vianda IS NULL).
async function listFiltered({
  cliente_id, fecha_desde, fecha_hasta, estado,
  estado_pago, tipo_vianda, segmento, canal_origen,
} = {}) {
  const where = [];
  const params = [];
  let idx = 1;

  if (cliente_id)   { where.push(`p.cliente_id = $${idx++}`);    params.push(cliente_id); }
  if (fecha_desde)  { where.push(`p.fecha_pedido >= $${idx++}`); params.push(fecha_desde); }
  if (fecha_hasta)  { where.push(`p.fecha_pedido <= $${idx++}`); params.push(fecha_hasta); }
  if (estado)       { where.push(`c.estado = $${idx++}`);        params.push(estado); }
  if (estado_pago)  { where.push(`p.estado_pago = $${idx++}`);   params.push(estado_pago); }
  if (segmento)     { where.push(`c.segmento = $${idx++}`);      params.push(segmento); }
  if (canal_origen) { where.push(`c.canal_origen = $${idx++}`);  params.push(canal_origen); }
  if (tipo_vianda === 'sin_vianda') {
    where.push('p.tipo_vianda IS NULL');
  } else if (tipo_vianda) {
    where.push(`p.tipo_vianda = $${idx++}`);
    params.push(tipo_vianda);
  }

  const sql = `
    SELECT
      p.id, p.fecha_pedido, p.monto, p.monto_pagado, p.descripcion, p.estado_pago, p.tipo_vianda, p.cancelado,
      c.id AS cliente_id, c.nombre_completo, c.cedula, c.segmento, c.estado, c.canal_origen
    FROM pedidos p
    JOIN clientes c ON c.id = p.cliente_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.fecha_pedido DESC, p.id DESC
  `;
  return (await pool.query(sql, params)).rows;
}

// Cantidad de pedidos de vianda (tipo_vianda IS NOT NULL) cuya fecha_pedido cae
// dentro del rango [fecha_desde, fecha_hasta].
// (ex countRecepcionadasEstaSemana — renombrada al dejar de estar atada a la semana corriente)
async function countRecepcionadas(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE tipo_vianda IS NOT NULL
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Cantidad de pedidos cuya ventana de entrega [fecha_entrega_desde, fecha_entrega_hasta]
// se solapa con el rango [fecha_desde, fecha_hasta]. Condición de solapamiento estándar:
// A.desde <= B.hasta AND A.hasta >= B.desde.
// (ex countEntregadasEstaSemana — renombrada al dejar de estar atada a la semana corriente)
async function countEntregadas(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE fecha_entrega_desde IS NOT NULL
      AND fecha_entrega_hasta IS NOT NULL
      AND fecha_entrega_desde <= $2
      AND fecha_entrega_hasta >= $1
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Cantidad de pedidos de cortesía (medio_pago = 'cortesia') cuya fecha_pedido
// cae dentro del rango [fecha_desde, fecha_hasta].
// (ex countCortesiaMes — renombrada al dejar de estar atada al mes corriente)
async function countCortesia(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE medio_pago = 'cortesia'
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Cantidad de pedidos por semana (lunes ISO) y tipo_vianda, dentro del rango
// [fecha_desde, fecha_hasta]. Deja afuera modificacion_menu y pedidos sin
// vianda (tipo_vianda IS NULL). Devuelve una fila por semana con datos, con
// los 3 conteos por tipo (0 si esa semana no tuvo pedidos de ese tipo).
async function viandasPorTipoPorSemana(fecha_desde, fecha_hasta) {
  const rows = (await pool.query(`
    SELECT
      to_char(date_trunc('week', fecha_pedido), 'YYYY-MM-DD') AS semana,
      tipo_vianda,
      COUNT(*)::integer AS cantidad
    FROM pedidos
    WHERE tipo_vianda IN ('economico', 'saludable', 'low_carb')
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
    GROUP BY date_trunc('week', fecha_pedido), tipo_vianda
  `, [fecha_desde, fecha_hasta])).rows;

  const porSemana = new Map();
  for (const r of rows) {
    if (!porSemana.has(r.semana)) {
      porSemana.set(r.semana, { semana: r.semana, economico: 0, saludable: 0, low_carb: 0 });
    }
    porSemana.get(r.semana)[r.tipo_vianda] = r.cantidad;
  }

  return [...porSemana.values()].sort((a, b) => a.semana.localeCompare(b.semana));
}

async function create({
  cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion,
  fecha_entrega_desde, fecha_entrega_hasta, detalle_modificacion,
}) {
  const result = await pool.query(
    `INSERT INTO pedidos
       (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion,
        fecha_entrega_desde, fecha_entrega_hasta, detalle_modificacion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      fecha_entrega_desde || null,
      fecha_entrega_hasta || null,
      detalle_modificacion || null,
    ]
  );
  return result.rows[0];
}

module.exports = {
  listByCliente, getById, create, listFiltered, updatePago,
  countRecepcionadas, countEntregadas, countCortesia, viandasPorTipoPorSemana,
  update, cancelar, listAuditoria,
};
