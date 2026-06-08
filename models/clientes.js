const pool = require('./db');
const { ALERT_DAYS } = require('../config');

// Subquery que agrega los campos calculados de pedidos por cliente.
// dias_sin_pedir: días completos entre hoy y el último pedido (EXTRACT sobre intervalo).
const PEDIDOS_AGG = `
  SELECT
    cliente_id,
    COUNT(*)::integer                                   AS cantidad_pedidos,
    MAX(fecha_pedido)                                   AS ultimo_pedido,
    AVG(monto)::float                                   AS ticket_promedio,
    SUM(monto)::float                                   AS ticket_total
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
    where.push(`(c.nombre_completo ILIKE $${idx} OR c.cedula ILIKE $${idx + 1})`);
    idx += 2;
    params.push(`%${q}%`, `%${q}%`);
  }

  const sql = SELECT_BASE
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY c.nombre_completo ASC';

  return (await pool.query(sql, params)).rows;
}

async function getById(id) {
  const result = await pool.query(`${SELECT_BASE} WHERE c.id = $1`, [id]);
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

async function create(data) {
  const result = await pool.query(`
    INSERT INTO clientes
      (nombre_completo, cedula, email, telefono, segmento, empresa, canal_origen, codigo_embajador, estado, fecha_ingreso)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [
    data.nombre_completo,
    data.cedula,
    data.email || null,
    data.telefono || null,
    data.segmento,
    data.segmento === 'empresa' ? (data.empresa || null) : null,
    data.canal_origen,
    data.canal_origen === 'embajador' ? (data.codigo_embajador || null) : null,
    data.estado || 'activo',
    data.fecha_ingreso,
  ]);
  return getById(result.rows[0].id);
}

async function update(id, data) {
  await pool.query(`
    UPDATE clientes SET
      nombre_completo  = $1,
      cedula           = $2,
      email            = $3,
      telefono         = $4,
      segmento         = $5,
      empresa          = $6,
      canal_origen     = $7,
      codigo_embajador = $8,
      fecha_ingreso    = $9,
      updated_at       = NOW()
    WHERE id = $10
  `, [
    data.nombre_completo,
    data.cedula,
    data.email || null,
    data.telefono || null,
    data.segmento,
    data.segmento === 'empresa' ? (data.empresa || null) : null,
    data.canal_origen,
    data.canal_origen === 'embajador' ? (data.codigo_embajador || null) : null,
    data.fecha_ingreso,
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

async function updateEstado(id, estado) {
  await pool.query(`
    UPDATE clientes SET estado = $1, updated_at = NOW()
    WHERE id = $2
  `, [estado, id]);
  return getById(id);
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

async function countAltasMes() {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM clientes
    WHERE to_char(fecha_ingreso, 'YYYY-MM') = to_char(NOW(), 'YYYY-MM')
  `);
  return r.rows[0].n;
}

// Aproximación: una "baja" del mes es un cliente en estado 'baja' cuya última
// actualización (updated_at) cae en el mes actual.
async function countBajasMes() {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM clientes
    WHERE estado = 'baja'
      AND to_char(updated_at, 'YYYY-MM') = to_char(NOW(), 'YYYY-MM')
  `);
  return r.rows[0].n;
}

async function ticketPromedioGeneral() {
  const r = await pool.query('SELECT AVG(monto)::float AS prom FROM pedidos');
  return r.rows[0].prom || 0;
}

async function ticketPromedioPorSegmento() {
  const rows = (await pool.query(`
    SELECT c.segmento AS segmento, AVG(pe.monto)::float AS prom
    FROM clientes c
    JOIN pedidos pe ON pe.cliente_id = c.id
    GROUP BY c.segmento
  `)).rows;
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
    // 'YYYY-MM-31' funciona como fecha "fin de mes aproximado" para comparación:
    // Postgres la interpreta como DATE y maneja desbordamiento de días correctamente
    // (p.ej. 2026-02-31 → 2026-03-03), pero como solo usamos "≤ fin_de_mes" para
    // capturar todo el mes, la comparación es correcta en todos los casos.
    const finDeMes = `${yearMonth}-31`;
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
  marcarSeguimiento,
  listEmpresas,
  listColaboradores,
  countActivos,
  countAlertas,
  listAlertas,
  countAltasMes,
  countBajasMes,
  ticketPromedioGeneral,
  ticketPromedioPorSegmento,
  evolucionActivosPorMes,
};
