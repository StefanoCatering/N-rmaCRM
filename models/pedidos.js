const pool = require('./db');
const detalle = require('./pedidoDetalle');

// Registra una entrada en pedidos_auditoria. Es el mismo patrón de auditoría
// obligatoria que ya usaban update() y cancelar(), extraído para poder reusarlo
// desde las operaciones sobre líneas y excepciones (fase 6).
// accion: 'edicion' | 'cancelacion' (CHECK de la tabla).
async function auditar(pedidoId, accion, usuario, detalleJson, motivo, ejecutor = pool) {
  await ejecutor.query(
    `INSERT INTO pedidos_auditoria (pedido_id, accion, usuario, detalle, motivo)
     VALUES ($1, $2, $3, $4, $5)`,
    [pedidoId, accion, usuario, detalleJson === null ? null : JSON.stringify(detalleJson), motivo]
  );
}

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

  const detalleAuditoria = {};
  for (const campo of campos) {
    detalleAuditoria[campo] = { anterior: pedidoActual[campo], nuevo: cambios[campo] };
  }
  await auditar(id, 'edicion', usuario, detalleAuditoria, motivo);

  return actualizado;
}

// Marca un pedido como cancelado y registra la auditoría.
// Cancela además todas sus líneas, para que el estado del CRM quede coherente:
// un pedido cancelado no puede tener líneas vivas, y el sync hacia Narma Pedidos
// marca cancelado = true en todas las filas resueltas de ese pedido.
async function cancelar(id, usuario, motivo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE pedidos SET cancelado = true WHERE id = $1 RETURNING *`,
      [id]
    );
    const actualizado = result.rows[0];

    await client.query(
      `UPDATE pedido_detalle SET cancelado = true WHERE pedido_id = $1 AND cancelado = false`,
      [id]
    );

    await auditar(id, 'cancelacion', usuario, null, motivo, client);

    await client.query('COMMIT');
    return actualizado;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
      p.origen, p.semana_lunes,
      c.id AS cliente_id, c.nombre_completo, c.cedula, c.segmento, c.estado, c.canal_origen, c.empresa
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
      AND cancelado = false
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
      AND cancelado = false
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
      AND cancelado = false
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
      AND cancelado = false
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

// Crea el pedido y, si vienen, sus líneas de detalle — todo en una transacción,
// para que no pueda quedar un pedido sin las líneas que la ATC cargó.
// tipo_vianda / descripcion siguen existiendo y no cambian: las líneas de
// pedido_detalle se suman a lo que ya había, no lo reemplazan (el dashboard
// histórico depende de tipo_vianda).
async function create({
  cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion,
  fecha_entrega_desde, fecha_entrega_hasta, detalle_modificacion, ubicacion_id, lineas = [],
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO pedidos
         (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion,
          fecha_entrega_desde, fecha_entrega_hasta, detalle_modificacion, ubicacion_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        ubicacion_id || null,
      ]
    );
    const pedido = result.rows[0];

    if (lineas.length) await detalle.createMany(pedido.id, lineas, client);

    await client.query('COMMIT');
    return pedido;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pedido + cliente + ubicación elegida + líneas con sus excepciones.
// Es lo que consume la vista de edición del pedido y también el sync.
async function getConDetalle(id) {
  const r = await pool.query(`
    SELECT
      p.*,
      c.nombre_completo AS cliente_nombre,
      c.segmento        AS cliente_segmento,
      c.tipo_envase     AS cliente_tipo_envase,
      u.direccion       AS ubicacion_direccion,
      u.zona            AS ubicacion_zona
    FROM pedidos p
    JOIN clientes c    ON c.id = p.cliente_id
    LEFT JOIN ubicaciones u ON u.id = p.ubicacion_id
    WHERE p.id = $1
  `, [id]);
  const pedido = r.rows[0];
  if (!pedido) return null;

  const lineas = await detalle.listByPedido(id);
  const excepcionesPorLinea = await detalle.excepcionesPorLinea(id);
  pedido.lineas = lineas.map(l => ({
    ...l,
    excepciones: excepcionesPorLinea.get(l.id) || [],
  }));

  return pedido;
}

module.exports = {
  listByCliente, getById, getConDetalle, create, listFiltered, updatePago,
  countRecepcionadas, countEntregadas, countCortesia, viandasPorTipoPorSemana,
  update, cancelar, listAuditoria, auditar,
};
