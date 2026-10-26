const pool = require('./db');
const { ALERT_DAYS } = require('../config');

// Subquery que agrega los campos calculados de pedidos por cliente.
// dias_sin_pedir: días completos entre hoy y el último pedido (EXTRACT sobre intervalo).
//
// El FILTER de los tickets deja afuera los pedidos de la grilla de comedor
// (fase 7): nacen con monto = 0 porque la facturación del comedor no pasa por
// el CRM, así que sumarlos hundiría el ticket promedio de la cuenta empresa.
// La cuenta de pedidos y la fecha del último sí los incluyen: son pedidos
// reales y la cuenta empresa no está "sin pedir" solo porque no se le factura
// desde acá.
const PEDIDOS_AGG = `
  SELECT
    cliente_id,
    COUNT(*)::integer                                   AS cantidad_pedidos,
    MAX(fecha_pedido)                                   AS ultimo_pedido,
    AVG(monto) FILTER (WHERE origen IS DISTINCT FROM 'grilla')::float AS ticket_promedio,
    SUM(monto) FILTER (WHERE origen IS DISTINCT FROM 'grilla')::float AS ticket_total
  FROM pedidos
  GROUP BY cliente_id
`;

const SELECT_BASE = `
  SELECT
    c.*,
    COALESCE(p.cantidad_pedidos, 0)                     AS cantidad_pedidos,
    p.ultimo_pedido                                     AS ultimo_pedido,
    CASE WHEN p.ultimo_pedido IS NULL THEN NULL
         ELSE EXTRACT(DAY FROM NOW() - p.ultimo_pedido::timestamp)::integer
    END                                                 AS dias_sin_pedir,
    p.ticket_promedio                                   AS ticket_promedio,
    p.ticket_total                                      AS ticket_total
  FROM clientes c
  LEFT JOIN (${PEDIDOS_AGG}) p ON p.cliente_id = c.id
`;

async function list({ estado, segmento, canal_origen, empresa, q } = {}) {
  const where = [];
  const params = [];
  let idx = 1;

  if (estado)      { where.push(`c.estado = $${idx++}`);      params.push(estado); }
  if (segmento)    { where.push(`c.segmento = $${idx++}`);    params.push(segmento); }
  if (canal_origen){ where.push(`c.canal_origen = $${idx++}`);params.push(canal_origen); }
  if (empresa)     { where.push(`c.empresa = $${idx++}`);     params.push(empresa); }
  if (q) {
    // ILIKE en lugar de LIKE para búsqueda case-insensitive (Postgres LIKE es case-sensitive)
    where.push(`(c.nombre_completo ILIKE $${idx} OR c.cedula ILIKE $${idx + 1} OR c.telefono ILIKE $${idx + 2} OR c.telefono2 ILIKE $${idx + 3} OR c.telefono3 ILIKE $${idx + 4})`);
    idx += 5;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sql = SELECT_BASE
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY c.nombre_completo ASC';

  return (await pool.query(sql, params)).rows;
}

// ejecutor: por defecto el pool. El alta de cliente con plan de comedor
// (fase 12) le pasa el client de su transacción, para poder leer el cliente
// que acaba de insertar y que todavía no está commiteado.
async function getById(id, ejecutor = pool) {
  const result = await ejecutor.query(`${SELECT_BASE} WHERE c.id = $1`, [id]);
  return result.rows[0] || null;
}

async function existsCedula(cedula, excludeId = null) {
  if (excludeId) {
    const r = await pool.query('SELECT 1 FROM clientes WHERE cedula = $1 AND id != $2', [cedula, excludeId]);
    return r.rows.length > 0;
  }
  const r = await pool.query('SELECT 1 FROM clientes WHERE cedula = $1', [cedula]);
  return r.rows.length > 0;
}

// ejecutor: ver getById. Sin él se comporta igual que siempre.
async function create(data, ejecutor = pool) {
  const result = await ejecutor.query(`
    INSERT INTO clientes
      (nombre_completo, cedula, email, telefono, telefono2, telefono3, segmento, empresa, canal_origen, codigo_embajador, estado, fecha_ingreso, observaciones, tipo_envase)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id
  `, [
    data.nombre_completo,
    data.cedula,
    data.email || null,
    data.telefono || null,
    data.telefono2 || null,
    data.telefono3 || null,
    data.segmento,
    data.segmento === 'empresa' ? (data.empresa || null) : null,
    data.canal_origen,
    data.canal_origen === 'embajador' ? (data.codigo_embajador || null) : null,
    data.estado || 'activo',
    data.fecha_ingreso,
    data.observaciones || null,
    data.tipo_envase || 'Venezia',
  ]);
  return getById(result.rows[0].id, ejecutor);
}

async function update(id, data) {
  await pool.query(`
    UPDATE clientes SET
      nombre_completo  = $1,
      cedula           = $2,
      email            = $3,
      telefono         = $4,
      telefono2        = $5,
      telefono3        = $6,
      segmento         = $7,
      empresa          = $8,
      canal_origen     = $9,
      codigo_embajador = $10,
      fecha_ingreso    = $11,
      observaciones    = $12,
      tipo_envase      = $13,
      updated_at       = NOW()
    WHERE id = $14
  `, [
    data.nombre_completo,
    data.cedula,
    data.email || null,
    data.telefono || null,
    data.telefono2 || null,
    data.telefono3 || null,
    data.segmento,
    data.segmento === 'empresa' ? (data.empresa || null) : null,
    data.canal_origen,
    data.canal_origen === 'embajador' ? (data.codigo_embajador || null) : null,
    data.fecha_ingreso,
    data.observaciones || null,
    data.tipo_envase || 'Venezia',
    id,
  ]);
  return getById(id);
}

// Lista de nombres de empresa distintos (para el filtro del listado de clientes).
async function listEmpresas() {
  const result = await pool.query(`
    SELECT DISTINCT empresa FROM clientes
    WHERE empresa IS NOT NULL AND empresa != ''
    ORDER BY empresa ASC
  `);
  return result.rows.map(r => r.empresa);
}

// Otros clientes (colaboradores) que pertenecen a la misma empresa.
async function listColaboradores(empresa, excludeId) {
  const result = await pool.query(`
    SELECT id, nombre_completo, cedula, estado
    FROM clientes
    WHERE empresa = $1 AND id != $2
    ORDER BY nombre_completo ASC
  `, [empresa, excludeId]);
  return result.rows;
}

// Cambia el estado del cliente y registra el movimiento en clientes_auditoria
// — las dos cosas en UNA transacción, para que no pueda quedar un cliente
// desactivado sin constancia de quién lo desactivó y por qué (mismo criterio
// que updatePago con pedidos_auditoria, fase 8).
//
// estadoAntes se recibe en lugar de releerlo acá: lo trae el endpoint, que ya
// cargó el cliente para validar el cambio.
async function updateEstado(id, { estado, estado_antes, motivo, usuario }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE clientes SET estado = $1, updated_at = NOW()
      WHERE id = $2
    `, [estado, id]);

    await client.query(`
      INSERT INTO clientes_auditoria
        (cliente_id, accion, usuario, estado_antes, estado_despues, motivo)
      VALUES ($1, 'cambio_estado', $2, $3, $4, $5)
    `, [id, usuario, estado_antes, estado, motivo]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getById(id);
}

// Historial de cambios de estado de un cliente, más reciente primero.
async function listAuditoria(clienteId) {
  const r = await pool.query(
    'SELECT * FROM clientes_auditoria WHERE cliente_id = $1 ORDER BY fecha DESC, id DESC',
    [clienteId]
  );
  return r.rows;
}

// Lo que quedaría colgado si se desactiva a este cliente. NO cancela ni da de
// baja nada: desactivar es una decisión administrativa y qué hacer con las
// entregas que ya están cargadas lo decide ATC caso por caso. La respuesta del
// endpoint lo devuelve como aviso para que esa decisión sea informada.
//
// hoy es la fecha de Asunción (detalle.hoyISO), la misma que usa la grilla:
// con new Date() a secas, a partir de las 21:00 el servidor en UTC ya estaría
// en el día siguiente y un pedido de hoy no aparecería en el aviso.
async function pendientesAlDesactivar(id, hoy) {
  // Una línea viva cuya entrega cae de hoy en adelante: puntual por su
  // fecha_entrega, recurrente por el final de su rango (una recurrente que
  // termina hoy todavía entrega hoy).
  //
  // Mira las LÍNEAS, no la cabecera: los pedidos sin líneas son los 765
  // anteriores a la fase 6 y su ventana de entrega ya pasó hace meses.
  const r = await pool.query(`
    SELECT DISTINCT p.id
    FROM pedidos p
    JOIN pedido_detalle d ON d.pedido_id = p.id AND d.cancelado = false
    WHERE p.cliente_id = $1
      AND p.cancelado = false
      AND (
        (d.modo = 'puntual'    AND d.fecha_entrega >= $2) OR
        (d.modo = 'recurrente' AND d.fecha_hasta   >= $2)
      )
    ORDER BY p.id ASC
  `, [id, hoy]);

  // Plan de comedor vigente (fase 7). fecha_baja es EXCLUSIVA —el primer día
  // que ya NO come—, así que un plan con fecha_baja = hoy ya no está vigente.
  const plan = await pool.query(`
    SELECT 1 FROM grilla_planes
    WHERE cliente_id = $1 AND (fecha_baja IS NULL OR fecha_baja > $2)
  `, [id, hoy]);

  return {
    pedidos: r.rows.map(row => row.id),
    plan_grilla: plan.rows.length > 0,
  };
}

// Marca el seguimiento de un cliente en alerta (persiste en la base con la fecha actual).
async function marcarSeguimiento(id) {
  await pool.query(`
    UPDATE clientes SET seguimiento_marcado = 1, seguimiento_fecha = CURRENT_DATE
    WHERE id = $1
  `, [id]);
  return getById(id);
}

// ── KPIs del dashboard ──────────────────────────────────────────

async function countActivos() {
  const r = await pool.query(`SELECT COUNT(*)::integer AS n FROM clientes WHERE estado = 'activo'`);
  return r.rows[0].n;
}

async function countAlertas() {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n
    FROM (${SELECT_BASE}) AS sq
    WHERE cantidad_pedidos > 0 AND dias_sin_pedir > $1
  `, [ALERT_DAYS]);
  return r.rows[0].n;
}

async function listAlertas() {
  const r = await pool.query(`
    SELECT * FROM (${SELECT_BASE}) AS sq
    WHERE cantidad_pedidos > 0 AND dias_sin_pedir > $1
    ORDER BY dias_sin_pedir DESC
  `, [ALERT_DAYS]);
  return r.rows;
}

// Cantidad de clientes con fecha_ingreso dentro del rango [fecha_desde, fecha_hasta].
async function countAltas(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM clientes
    WHERE fecha_ingreso >= $1 AND fecha_ingreso <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Aproximación: una "baja" del rango es un cliente en estado 'baja' cuya última
// actualización (updated_at) cae dentro del rango [fecha_desde, fecha_hasta].
async function countBajas(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM clientes
    WHERE estado = 'baja'
      AND updated_at::date >= $1 AND updated_at::date <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

async function ticketPromedioGeneral(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT AVG(monto)::float AS prom FROM pedidos
    WHERE cancelado = false
      AND origen IS DISTINCT FROM 'grilla'
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].prom || 0;
}

async function ticketPromedioPorSegmento(fecha_desde, fecha_hasta) {
  const rows = (await pool.query(`
    SELECT c.segmento AS segmento, AVG(pe.monto)::float AS prom
    FROM clientes c
    JOIN pedidos pe ON pe.cliente_id = c.id
    WHERE pe.cancelado = false
      AND pe.origen IS DISTINCT FROM 'grilla'
      AND pe.fecha_pedido >= $1 AND pe.fecha_pedido <= $2
    GROUP BY c.segmento
  `, [fecha_desde, fecha_hasta])).rows;
  const out = { particular: 0, empresa: 0 };
  for (const r of rows) out[r.segmento] = r.prom || 0;
  return out;
}

// Evolución de clientes activos por mes (últimos N meses, incluido el actual).
async function evolucionActivosPorMes(meses = 6) {
  const out = [];
  const now = new Date();
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // Último día real del mes: new Date(año, mes+1, 0) da el día 0 del mes siguiente
    // = último día del mes actual. Evita fechas inválidas como '2026-02-31' que
    // Postgres rechaza con error (a diferencia de SQLite que las hacía overflow).
    const finDeMes = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT COUNT(*)::integer AS n FROM clientes
      WHERE fecha_ingreso <= $1::date
        AND (estado != 'baja' OR updated_at::date > $2::date)
    `, [finDeMes, finDeMes]);
    out.push({ mes: yearMonth, activos: r.rows[0].n });
  }
  return out;
}

module.exports = {
  list,
  getById,
  existsCedula,
  create,
  update,
  updateEstado,
  listAuditoria,
  pendientesAlDesactivar,
  marcarSeguimiento,
  listEmpresas,
  listColaboradores,
  countActivos,
  countAlertas,
  listAlertas,
  countAltas,
  countBajas,
  ticketPromedioGeneral,
  ticketPromedioPorSegmento,
  evolucionActivosPorMes,
};
