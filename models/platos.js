const pool = require('./db');

// Catálogo de platos. La tabla está pensada para recibir altas directo en el
// SQL Editor de Supabase: cualquier fila nueva aparece sola en el form de
// pedido, sin deploy. Por eso acá no hay lista hardcodeada de categorías.

// Platos activos, agrupados por categoría para armar los <optgroup> del select.
async function listActivosPorCategoria() {
  const r = await pool.query(`
    SELECT id, categoria, nombre
    FROM platos
    WHERE activo = 1
    ORDER BY categoria ASC, nombre ASC
  `);

  const porCategoria = new Map();
  for (const p of r.rows) {
    if (!porCategoria.has(p.categoria)) porCategoria.set(p.categoria, []);
    porCategoria.get(p.categoria).push({ id: p.id, nombre: p.nombre });
  }
  return [...porCategoria.entries()].map(([categoria, platos]) => ({ categoria, platos }));
}

// Subconjunto de ids que existen y están activos. Se usa para validar las
// líneas de un pedido en una sola consulta, en lugar de una por línea.
async function idsActivos(ids) {
  if (!ids.length) return new Set();
  const r = await pool.query(
    'SELECT id FROM platos WHERE activo = 1 AND id = ANY($1::int[])',
    [ids]
  );
  return new Set(r.rows.map(row => row.id));
}

// Map id → nombre para los ids dados, incluidos los inactivos: el sync tiene
// que poder nombrar un plato que se desactivó después de cargarse el pedido.
async function nombresPorId(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(
    'SELECT id, nombre FROM platos WHERE id = ANY($1::int[])',
    [ids]
  );
  return new Map(r.rows.map(row => [row.id, row.nombre]));
}

module.exports = { listActivosPorCategoria, idsActivos, nombresPorId };
