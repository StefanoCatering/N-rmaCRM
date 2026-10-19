const pool = require('./db');

// Catálogo de platos. La tabla está pensada para recibir altas directo en el
// SQL Editor de Supabase: cualquier fila nueva aparece sola en el form de
// pedido, sin deploy. Por eso acá no hay lista hardcodeada de categorías.
//
// Única excepción: la categoría 'General' (fase 7). Son ítems que no se piden
// por persona (sopa, ensalada mixta, jugo, vinagreta), así que no tienen
// sentido como plato base ni como celda de la grilla de comedor. Viven en la
// misma tabla porque van al mismo pedido semanal y los nombra el mismo sync.
//
// Dónde entra y dónde no (fase 9):
//   grilla, plato base y celdas → NO. Son el plato de UNA persona.
//   pedido general de la grilla → SÍ, y además cualquier otro plato activo:
//     las encargadas piden sándwiches, wraps y ensaladas por cantidad.
//   pedidos normales             → SÍ, para cualquier cliente. Matrix pide
//     sopa y jugo como pedido normal, y nada impide que otro lo haga.
//
// O sea: la exclusión de 'General' es de la grilla por persona, no de los
// pedidos. De ahí que haya dos validaciones (idsActivos / idsActivosTodos) y
// dos catálogos (listActivosPorCategoria / listTodosActivosPorCategoria).
const CATEGORIA_GENERAL = 'General';

// ── Etiqueta de un plato ─────────────────────────────────────────
// ÚNICA forma de nombrar un plato en todo el sistema: en la grilla, en los
// totales, en los selectores, en la hoja del día y —lo más importante— en
// plato_nombre de pedidos_crm_detalle, que es lo único que ve cocina.
//
// platos.nombre solo no alcanza: el catálogo real tiene 'César' en dos
// categorías (Ensaladas y Wraps), y 'Papa' / 'Batata' / 'Sin guarnición'
// sueltos no dicen que son guarniciones de Pollo Grille.
//
// 'Básicos' y 'General' van sin prefijo porque sus nombres ya son únicos y
// autoexplicativos ('Estándar', 'Low carb', 'Jugo'): prefijarlos solo haría
// más larga la etiqueta sin aclarar nada.
const CATEGORIAS_SIN_PREFIJO = new Set(['Básicos', CATEGORIA_GENERAL]);

function etiquetaPlato(categoria, nombre) {
  return CATEGORIAS_SIN_PREFIJO.has(categoria) ? nombre : `${categoria} · ${nombre}`;
}

// Se manda la etiqueta ya armada: la regla vive solo acá, y las vistas la
// muestran tal cual. Así lo que ATC elige en el selector se lee igual que lo
// que después aparece en la celda, en los totales y en la comanda de cocina.
function agruparPorCategoria(filas) {
  const porCategoria = new Map();
  for (const p of filas) {
    if (!porCategoria.has(p.categoria)) porCategoria.set(p.categoria, []);
    porCategoria.get(p.categoria).push({
      id: p.id, nombre: p.nombre, etiqueta: etiquetaPlato(p.categoria, p.nombre),
    });
  }
  return [...porCategoria.entries()].map(([categoria, platos]) => ({ categoria, platos }));
}

// Platos activos, agrupados por categoría para armar los <optgroup> del select.
// Excluye 'General' (ver arriba): este es el catálogo "por persona", el que usa
// la grilla de comedor. Es lo que devuelve GET /api/platos sin parámetros.
async function listActivosPorCategoria() {
  const r = await pool.query(`
    SELECT id, categoria, nombre
    FROM platos
    WHERE activo = 1 AND categoria <> $1
    ORDER BY categoria ASC, nombre ASC
  `, [CATEGORIA_GENERAL]);
  return agruparPorCategoria(r.rows);
}

// Catálogo completo: todos los platos activos, de cualquier categoría,
// agrupados igual que el de arriba. A diferencia de listActivosPorCategoria(),
// este NO excluye 'General'.
//
// Lo usan el PEDIDO GENERAL de la grilla —que mezcla los ítems que no van por
// persona (sopa, jugo) con platos comunes que la encargada pide por cantidad—
// y los PEDIDOS NORMALES, vía GET /api/platos?incluir_general=1 (fase 9).
async function listTodosActivosPorCategoria() {
  const r = await pool.query(`
    SELECT id, categoria, nombre
    FROM platos
    WHERE activo = 1
    ORDER BY categoria ASC, nombre ASC
  `);
  return agruparPorCategoria(r.rows);
}

// Subconjunto de ids que existen y están activos, excluyendo 'General' por el
// mismo motivo que listActivosPorCategoria(): es la validación de lo que come
// UNA persona — el plato base y las celdas de la grilla de comedor.
async function idsActivos(ids) {
  if (!ids.length) return new Set();
  const r = await pool.query(
    'SELECT id FROM platos WHERE activo = 1 AND categoria <> $1 AND id = ANY($2::int[])',
    [CATEGORIA_GENERAL, ids]
  );
  return new Set(r.rows.map(row => row.id));
}

// Ídem, pero sin excluir ninguna categoría: valida todo lo que no es "el plato
// de una persona" — el PEDIDO GENERAL de la grilla y las líneas y excepciones
// de los pedidos normales (fase 9). Una sola consulta para todas las líneas de
// un pedido, en lugar de una por línea.
async function idsActivosTodos(ids) {
  if (!ids.length) return new Set();
  const r = await pool.query(
    'SELECT id FROM platos WHERE activo = 1 AND id = ANY($1::int[])',
    [ids]
  );
  return new Set(r.rows.map(row => row.id));
}

// Map id → ETIQUETA para los ids dados, incluidos los inactivos y los de la
// categoría 'General': el sync tiene que poder nombrar un plato que se
// desactivó después de cargarse el pedido, y las líneas del pedido semanal de
// la grilla incluyen los ítems generales.
//
// Devuelve la etiqueta y no el nombre pelado porque esto es lo que termina en
// pedidos_crm_detalle.plato_nombre, que es lo único que ve cocina: con el
// nombre solo, 'César' no distingue la ensalada del wrap.
async function nombresPorId(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(
    'SELECT id, categoria, nombre FROM platos WHERE id = ANY($1::int[])',
    [ids]
  );
  return new Map(r.rows.map(row => [row.id, etiquetaPlato(row.categoria, row.nombre)]));
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
  return new Map(r.rows.map(row => [row.id, {
    nombre: row.nombre,
    categoria: row.categoria,
    etiqueta: etiquetaPlato(row.categoria, row.nombre),
  }]));
}

// id del plato con ese nombre exacto, o null. La hoja del día lo usa para
// saber cuál es el "Estándar" sin hardcodear un id de la base.
async function idPorNombre(nombre) {
  const r = await pool.query('SELECT id FROM platos WHERE nombre = $1 ORDER BY id ASC LIMIT 1', [nombre]);
  return r.rows.length ? r.rows[0].id : null;
}

module.exports = {
  CATEGORIA_GENERAL, etiquetaPlato,
  listActivosPorCategoria, listTodosActivosPorCategoria,
  idsActivos, idsActivosTodos,
  nombresPorId, fichasPorId, idPorNombre,
};
