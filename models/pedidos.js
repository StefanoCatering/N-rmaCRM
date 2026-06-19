const pool = require('./db');

async function listByCliente(clienteId) {
  const result = await pool.query(
    'SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY fecha_pedido DESC, id DESC',
    [clienteId]
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
      p.id, p.fecha_pedido, p.monto, p.descripcion, p.estado_pago, p.tipo_vianda,
      c.id AS cliente_id, c.nombre_completo, c.cedula, c.segmento, c.estado, c.canal_origen
    FROM pedidos p
    JOIN clientes c ON c.id = p.cliente_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.fecha_pedido DESC, p.id DESC
  `;
  return (await pool.query(sql, params)).rows;
}

// Cantidad de pedidos de vianda (tipo_vianda IS NOT NULL) cuya fecha_pedido cae
// dentro de la semana corriente (lunes a domingo). date_trunc('week', ...) en
// Postgres trunca al lunes de esa semana (ISO 8601).
// (ex countEstaSemana — renombrada para distinguirla de countEntregadasEstaSemana)
async function countRecepcionadasEstaSemana() {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE tipo_vianda IS NOT NULL
      AND fecha_pedido >= date_trunc('week', CURRENT_DATE)::date
      AND fecha_pedido <  (date_trunc('week', CURRENT_DATE) + INTERVAL '7 days')::date
  `);
  return r.rows[0].n;
}

// Cantidad de pedidos cuya ventana de entrega [fecha_entrega_desde, fecha_entrega_hasta]
// se solapa con la semana corriente (lunes a domingo). Condición de solapamiento estándar:
// A.desde <= B.hasta AND A.hasta >= B.desde, donde B es la semana corriente.
async function countEntregadasEstaSemana() {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE fecha_entrega_desde IS NOT NULL
      AND fecha_entrega_hasta IS NOT NULL
      AND fecha_entrega_desde <= (date_trunc('week', CURRENT_DATE) + INTERVAL '6 days')::date
      AND fecha_entrega_hasta >= date_trunc('week', CURRENT_DATE)::date
  `);
  return r.rows[0].n;
}

// Cantidad de pedidos de cortesía (medio_pago = 'cortesia') cuya fecha_pedido
// cae en el mes corriente. Mismo patrón que countAltasMes en models/clientes.js.
async function countCortesiaMes() {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE medio_pago = 'cortesia'
      AND to_char(fecha_pedido, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')
  `);
  return r.rows[0].n;
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
  listByCliente, create, listFiltered,
  countRecepcionadasEstaSemana, countEntregadasEstaSemana, countCortesiaMes,
};
