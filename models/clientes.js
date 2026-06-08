const db = require('./db');
const { ALERT_DAYS } = require('../config');

// Subquery que agrega los campos calculados de pedidos por cliente.
// dias_sin_pedir se calcula en días completos respecto a la fecha actual.
const PEDIDOS_AGG = `
  SELECT
    cliente_id,
    COUNT(*)                                          AS cantidad_pedidos,
    MAX(fecha_pedido)                                 AS ultimo_pedido,
    AVG(monto)                                        AS ticket_promedio,
    SUM(monto)                                        AS ticket_total
  FROM pedidos
  GROUP BY cliente_id
`;

const SELECT_BASE = `
  SELECT
    c.*,
    COALESCE(p.cantidad_pedidos, 0)                                       AS cantidad_pedidos,
    p.ultimo_pedido                                                       AS ultimo_pedido,
    CASE WHEN p.ultimo_pedido IS NULL THEN NULL
         ELSE CAST(julianday('now') - julianday(p.ultimo_pedido) AS INTEGER)
    END                                                                   AS dias_sin_pedir,
    p.ticket_promedio                                                     AS ticket_promedio,
    p.ticket_total                                                        AS ticket_total
  FROM clientes c
  LEFT JOIN (${PEDIDOS_AGG}) p ON p.cliente_id = c.id
`;

function list({ estado, segmento, canal_origen, empresa, q } = {}) {
  const where = [];
  const params = [];

  if (estado) { where.push('c.estado = ?'); params.push(estado); }
  if (segmento) { where.push('c.segmento = ?'); params.push(segmento); }
  if (canal_origen) { where.push('c.canal_origen = ?'); params.push(canal_origen); }
  if (empresa) { where.push('c.empresa = ?'); params.push(empresa); }
  if (q) {
    where.push('(c.nombre_completo LIKE ? OR c.cedula LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }

  const sql = SELECT_BASE
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY c.nombre_completo ASC';

  return db.prepare(sql).all(...params);
}

function getById(id) {
  return db.prepare(`${SELECT_BASE} WHERE c.id = ?`).get(id);
}

function existsCedula(cedula, excludeId = null) {
  if (excludeId) {
    return !!db.prepare('SELECT 1 FROM clientes WHERE cedula = ? AND id != ?').get(cedula, excludeId);
  }
  return !!db.prepare('SELECT 1 FROM clientes WHERE cedula = ?').get(cedula);
}

function create(data) {
  const stmt = db.prepare(`
    INSERT INTO clientes
      (nombre_completo, cedula, email, telefono, segmento, empresa, canal_origen, codigo_embajador, estado, fecha_ingreso)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.nombre_completo,
    data.cedula,
    data.email || null,
    data.telefono || null,
    data.segmento,
    data.segmento === 'empresa' ? (data.empresa || null) : null,
    data.canal_origen,
    data.canal_origen === 'embajador' ? (data.codigo_embajador || null) : null,
    data.estado || 'activo',
    data.fecha_ingreso
  );
  return getById(Number(info.lastInsertRowid));
}

function update(id, data) {
  const stmt = db.prepare(`
    UPDATE clientes SET
      nombre_completo = ?,
      cedula = ?,
      email = ?,
      telefono = ?,
      segmento = ?,
      empresa = ?,
      canal_origen = ?,
      codigo_embajador = ?,
      fecha_ingreso = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `);
  stmt.run(
    data.nombre_completo,
    data.cedula,
    data.email || null,
    data.telefono || null,
    data.segmento,
    data.segmento === 'empresa' ? (data.empresa || null) : null,
    data.canal_origen,
    data.canal_origen === 'embajador' ? (data.codigo_embajador || null) : null,
    data.fecha_ingreso,
    id
  );
  return getById(id);
}

// Lista de nombres de empresa distintos (para el filtro del listado de clientes).
function listEmpresas() {
  return db.prepare(`
    SELECT DISTINCT empresa FROM clientes
    WHERE empresa IS NOT NULL AND empresa != ''
    ORDER BY empresa ASC
  `).all().map(r => r.empresa);
}

// Otros clientes (colaboradores) que pertenecen a la misma empresa.
function listColaboradores(empresa, excludeId) {
  return db.prepare(`
    SELECT id, nombre_completo, cedula, estado
    FROM clientes
    WHERE empresa = ? AND id != ?
    ORDER BY nombre_completo ASC
  `).all(empresa, excludeId);
}

function updateEstado(id, estado) {
  db.prepare(`
    UPDATE clientes SET estado = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(estado, id);
  return getById(id);
}

// Marca el seguimiento de un cliente en alerta (lo deja persistido en la base
// con la fecha en que se marcó), para el botón "Marcar seguimiento" del dashboard.
function marcarSeguimiento(id) {
  db.prepare(`
    UPDATE clientes SET seguimiento_marcado = 1, seguimiento_fecha = strftime('%Y-%m-%d','now')
    WHERE id = ?
  `).run(id);
  return getById(id);
}

// ── KPIs del dashboard ──────────────────────────────────────────

function countActivos() {
  return db.prepare(`SELECT COUNT(*) AS n FROM clientes WHERE estado = 'activo'`).get().n;
}

function countAlertas() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM (${SELECT_BASE})
    WHERE cantidad_pedidos > 0 AND dias_sin_pedir > ?
  `).get(ALERT_DAYS).n;
}

function listAlertas() {
  return db.prepare(`
    SELECT * FROM (${SELECT_BASE})
    WHERE cantidad_pedidos > 0 AND dias_sin_pedir > ?
    ORDER BY dias_sin_pedir DESC
  `).all(ALERT_DAYS);
}

function countAltasMes() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM clientes
    WHERE strftime('%Y-%m', fecha_ingreso) = strftime('%Y-%m','now')
  `).get().n;
}

// Aproximación: una "baja" del mes es un cliente en estado 'baja' cuya última
// actualización (updated_at, que se refresca al cambiar estado) cae en el mes actual.
function countBajasMes() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM clientes
    WHERE estado = 'baja' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m','now')
  `).get().n;
}

function ticketPromedioGeneral() {
  const row = db.prepare('SELECT AVG(monto) AS prom FROM pedidos').get();
  return row.prom || 0;
}

function ticketPromedioPorSegmento() {
  const rows = db.prepare(`
    SELECT c.segmento AS segmento, AVG(pe.monto) AS prom
    FROM clientes c
    JOIN pedidos pe ON pe.cliente_id = c.id
    GROUP BY c.segmento
  `).all();
  const out = { particular: 0, empresa: 0 };
  for (const r of rows) out[r.segmento] = r.prom || 0;
  return out;
}

// Evolución de clientes activos por mes (últimos N meses, incluido el actual).
// Aproxima el estado "activo a fin de mes" usando fecha_ingreso y, para los que
// terminaron en 'baja', su updated_at como fecha aproximada de baja.
function evolucionActivosPorMes(meses = 6) {
  const out = [];
  const now = new Date();
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const finDeMes = `${yearMonth}-31`; // comparación lexicográfica de YYYY-MM-DD es segura para "<="
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM clientes
      WHERE fecha_ingreso <= ?
        AND (estado != 'baja' OR updated_at > ?)
    `).get(finDeMes, finDeMes);
    out.push({ mes: yearMonth, activos: row.n });
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
