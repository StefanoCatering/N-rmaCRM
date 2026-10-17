const pool = require('./db');

// Catálogo de platos. La tabla está pensada para recibir altas directo en el
// SQL Editor de Supabase: cualquier fila nueva aparece sola en el form de
// pedido, sin deploy. Por eso acá no hay lista hardcodeada de categorías.
//
// Única excepción: la categoría 'General' (fase 7). Son los ítems que van en
// el PEDIDO GENERAL de la grilla de comedor (sopa, ensalada mixta, jugo,
// vinagreta): no se piden por persona, así que no tienen sentido como línea de
// un pedido de particular ni como plato base / celda de la grilla. Viven en la
// misma tabla porque van al mismo pedido semanal y los nombra el mismo sync.
const CATEGORIA_GENERAL = 'General';

// Platos activos, agrupados por categoría para armar los <optgroup> del select.
// Excluye 'General' (ver arriba): este es el catálogo "por persona".
async function listActivosPorCategoria() {
  const r = await pool.query(`
    SELECT id, categoria, nombre
    FROM platos
    WHERE activo = 1 AND categoria <> $1
    ORDER BY categoria ASC, nombre ASC
  `, [CATEGORIA_GENERAL]);

  const porCategoria = new Map();
  for (const p of r.rows) {
    if (!porCategoria.has(p.categoria)) porCategoria.set(p.categoria, []);
    porCategoria.get(p.categoria).push({ id: p.id, nombre: p.nombre });
  }
  return [...porCategoria.entries()].map(([categoria, platos]) => ({ categoria, platos }));
}

// Ítems activos del pedido general (categoría 'General'), lista plana: es un
// select simple, no necesita agruparse.
async function listGenerales() {
  const r = await pool.query(`
    SELECT id, nombre FROM platos
    WHERE activo = 1 AND categoria = $1
    ORDER BY nombre ASC
  `, [CATEGORIA_GENERAL]);
  return r.rows;
}

// Subconjunto de ids que existen y están activos. Se usa para validar las
// líneas de un pedido en una sola consulta, en lugar de una por línea.
// Excluye 'General' por el mismo motivo que listActivosPorCategoria().
async function idsActivos(ids) {
  if (!ids.length) return new Set();
  const r = await pool.query(
    'SELECT id FROM platos WHERE activo = 1 AND categoria <> $1 AND id = ANY($2::int[])',
    [CATEGORIA_GENERAL, ids]
  );
  return new Set(r.rows.map(row => row.id));
}

// Ídem, pero solo entre los ítems del pedido general.
async function idsGeneralesActivos(ids) {
  if (!ids.length) return new Set();
  const r = await pool.query(
    'SELECT id FROM platos WHERE activo = 1 AND categoria = $1 AND id = ANY($2::int[])',
    [CATEGORIA_GENERAL, ids]
  );
  return new Set(r.rows.map(row => row.id));
}

// Map id → nombre para los ids dados, incluidos los inactivos y los de la
// categoría 'General': el sync tiene que poder nombrar un plato que se
// desactivó después de cargarse el pedido, y las líneas del pedido semanal de
// la grilla incluyen los ítems generales.
async function nombresPorId(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(
    'SELECT id, nombre FROM platos WHERE id = ANY($1::int[])',
    [ids]
  );
  return new Map(r.rows.map(row => [row.id, row.nombre]));
}

// Catálogo completo (id → {nombre, categoria}) de los platos dados, sin filtrar
// por activo. Lo usa la grilla para mostrar el plato de una celda vieja aunque
// después se haya desactivado.
async function fichasPorId(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(
    'SELECT id, nombre, categoria FROM platos WHERE id = ANY($1::int[])',
    [ids]
  );
  return new Map(r.rows.map(row => [row.id, { nombre: row.nombre, categoria: row.categoria }]));
}

// id del plato con ese nombre exacto, o null. La hoja del día lo usa para
// saber cuál es el "Estándar" sin hardcodear un id de la base.
async function idPorNombre(nombre) {
  const r = await pool.query('SELECT id FROM platos WHERE nombre = $1 ORDER BY id ASC LIMIT 1', [nombre]);
  return r.rows.length ? r.rows[0].id : null;
}

module.exports = {
  CATEGORIA_GENERAL,
  listActivosPorCategoria, listGenerales,
  idsActivos, idsGeneralesActivos,
  nombresPorId, fichasPorId, idPorNombre,
};
