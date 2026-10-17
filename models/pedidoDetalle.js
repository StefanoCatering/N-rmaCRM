const pool = require('./db');
const platos = require('./platos');

// Líneas de pedido (pedido_detalle) y sus excepciones por fecha
// (pedido_detalle_excepciones), más la resolución de fechas concretas que
// consume el sync hacia Narma Pedidos.

// Días de la semana que se producen para una línea recurrente: lunes a viernes.
// Una línea "todos los días de marzo" NO genera entregas de sábado y domingo.
// Si algún día hay que entregar fin de semana, se carga como línea puntual.
const DIAS_HABILES = [1, 2, 3, 4, 5]; // 0 = domingo … 6 = sábado

// Techo de expansión de una línea recurrente, como red de seguridad: un rango
// mal tipeado (2026 → 2036) no debe generar miles de filas de producción.
// routes/pedidos.js rechaza los rangos más largos que esto con un error claro.
const MAX_DIAS_RANGO = 366;

// ── Fechas ───────────────────────────────────────────────────────
// Todo se maneja como string 'YYYY-MM-DD'. El driver pg devuelve las columnas
// DATE como Date de JS en medianoche LOCAL, así que para volver a string se
// usan los componentes locales: toISOString() correría el día según el offset
// de la máquina (en UTC-3 un DATE '2026-03-10' saldría '2026-03-09').
function aISO(valor) {
  if (!valor) return null;
  if (typeof valor === 'string') return valor.slice(0, 10);
  const y = valor.getFullYear();
  const m = String(valor.getMonth() + 1).padStart(2, '0');
  const d = String(valor.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// La aritmética de días se hace en UTC (sumar 86.400.000 ms es exacto porque
// UTC no tiene horario de verano) y recién al final se formatea.
function isoDesdeUTC(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function msUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

const UN_DIA_MS = 24 * 60 * 60 * 1000;

// Desplaza una fecha ISO n días (n puede ser negativo). La grilla semanal
// (fase 7) la usa para recorrer de lunes a viernes.
function sumarDias(iso, n) {
  return isoDesdeUTC(msUTC(iso) + n * UN_DIA_MS);
}

// Día de la semana de una fecha ISO, 0 = domingo … 6 = sábado.
function diaSemana(iso) {
  return new Date(msUTC(iso)).getUTCDay();
}

// Cantidad de días calendario que abarca un rango, bordes incluidos.
function diasEnRango(desdeISO, hastaISO) {
  return Math.floor((msUTC(hastaISO) - msUTC(desdeISO)) / UN_DIA_MS) + 1;
}

// Expande [desde, hasta] día por día y deja solo los días hábiles.
function expandirHabiles(desdeISO, hastaISO) {
  const fin = msUTC(hastaISO);
  const fechas = [];
  for (let ms = msUTC(desdeISO); ms <= fin; ms += UN_DIA_MS) {
    if (DIAS_HABILES.includes(new Date(ms).getUTCDay())) fechas.push(isoDesdeUTC(ms));
    if (fechas.length > MAX_DIAS_RANGO) break;
  }
  return fechas;
}

// ── Resolución de entregas (requisito 9.a) ───────────────────────
// Devuelve una entrega por fecha concreta para UNA línea:
//   - modo puntual    → exactamente 1 fecha (fecha_entrega), sin excepciones.
//   - modo recurrente → fecha_desde → fecha_hasta día por día (solo hábiles),
//     pisando con la excepción vigente de ese día y salteando las que tienen
//     omitir = true.
// En una excepción, NULL significa "sin cambio": se hereda el valor de la línea.
function resolverEntregas(linea, excepciones = []) {
  if (linea.modo === 'puntual') {
    const fecha = aISO(linea.fecha_entrega);
    if (!fecha) return [];
    // Las excepciones solo aplican a líneas recurrentes: una línea puntual ya
    // ES una sola fecha, pisarla no tendría sentido.
    return [{
      fecha_entrega: fecha,
      plato_id: linea.plato_id,
      cantidad: linea.cantidad,
      comentario: linea.comentario,
      excepcion_id: null,
    }];
  }

  const desde = aISO(linea.fecha_desde);
  const hasta = aISO(linea.fecha_hasta);
  if (!desde || !hasta) return [];

  const porFecha = new Map();
  for (const e of excepciones) porFecha.set(aISO(e.fecha), e);

  const entregas = [];
  for (const fecha of expandirHabiles(desde, hasta)) {
    const exc = porFecha.get(fecha);
    if (exc && exc.omitir) continue; // ese día no se produce nada de esta línea
    entregas.push({
      fecha_entrega: fecha,
      plato_id:   exc && exc.plato_id   != null ? exc.plato_id   : linea.plato_id,
      cantidad:   exc && exc.cantidad   != null ? exc.cantidad   : linea.cantidad,
      comentario: exc && exc.comentario != null ? exc.comentario : linea.comentario,
      excepcion_id: exc ? exc.id : null,
    });
  }
  return entregas;
}

// ── Lectura ──────────────────────────────────────────────────────

const SELECT_LINEA = `
  SELECT d.*, pl.nombre AS plato_nombre, pl.categoria AS plato_categoria
  FROM pedido_detalle d
  JOIN platos pl ON pl.id = d.plato_id
`;

// plato_etiqueta: el nombre con el que se muestra el plato en TODO el sistema
// (ver platos.etiquetaPlato). Se agrega acá, del lado del servidor, para que
// las vistas no tengan que repetir la regla y no puedan quedar desalineadas
// con lo que se le manda a cocina.
const conEtiqueta = (fila) => (fila
  ? { ...fila, plato_etiqueta: platos.etiquetaPlato(fila.plato_categoria, fila.plato_nombre) }
  : fila);

async function listByPedido(pedidoId) {
  const r = await pool.query(`${SELECT_LINEA} WHERE d.pedido_id = $1 ORDER BY d.id ASC`, [pedidoId]);
  return r.rows.map(conEtiqueta);
}

async function getById(id) {
  const r = await pool.query(`${SELECT_LINEA} WHERE d.id = $1`, [id]);
  return conEtiqueta(r.rows[0] || null);
}

async function listExcepciones(pedidoDetalleId) {
  const r = await pool.query(`
    SELECT e.*, pl.nombre AS plato_nombre, pl.categoria AS plato_categoria
    FROM pedido_detalle_excepciones e
    LEFT JOIN platos pl ON pl.id = e.plato_id
    WHERE e.pedido_detalle_id = $1
    ORDER BY e.fecha ASC
  `, [pedidoDetalleId]);
  // El plato de una excepción es opcional (NULL = sin cambio), de ahí el
  // LEFT JOIN y el chequeo antes de etiquetar.
  return r.rows.map(e => (e.plato_id
    ? { ...e, plato_etiqueta: platos.etiquetaPlato(e.plato_categoria, e.plato_nombre) }
    : e));
}

// Todas las excepciones de todas las líneas de un pedido, en una sola consulta.
// Devuelve un Map pedido_detalle_id → excepciones[], para no hacer N+1 al
// resolver las entregas de un pedido completo.
async function excepcionesPorLinea(pedidoId) {
  const r = await pool.query(`
    SELECT e.*
    FROM pedido_detalle_excepciones e
    JOIN pedido_detalle d ON d.id = e.pedido_detalle_id
    WHERE d.pedido_id = $1
    ORDER BY e.fecha ASC
  `, [pedidoId]);

  const porLinea = new Map();
  for (const e of r.rows) {
    if (!porLinea.has(e.pedido_detalle_id)) porLinea.set(e.pedido_detalle_id, []);
    porLinea.get(e.pedido_detalle_id).push(e);
  }
  return porLinea;
}

// ── Escritura ────────────────────────────────────────────────────
// Todas aceptan un `ejecutor` opcional (un client de pg dentro de una
// transacción); por defecto usan el pool.

// Inserta N líneas en UN solo statement multi-fila.
async function createMany(pedidoId, lineas, ejecutor = pool) {
  if (!lineas.length) return [];

  const COLS = 9;
  const tuplas = [];
  const params = [];
  lineas.forEach((l, i) => {
    const base = i * COLS;
    tuplas.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`);
    params.push(
      pedidoId,
      l.plato_id,
      l.cantidad,
      l.comentario || null,
      l.modo,
      l.fecha_entrega || null,
      l.fecha_desde || null,
      l.fecha_hasta || null,
      l.tipo_envase_override || null
    );
  });

  const r = await ejecutor.query(`
    INSERT INTO pedido_detalle
      (pedido_id, plato_id, cantidad, comentario, modo, fecha_entrega, fecha_desde, fecha_hasta, tipo_envase_override)
    VALUES ${tuplas.join(', ')}
    RETURNING *
  `, params);
  return r.rows;
}

// Actualiza los campos provistos de una línea. `cambios` viene siempre de una
// whitelist en routes/pedidos.js (CAMPOS_LINEA_EDITABLES), nunca del body crudo.
async function update(id, cambios, ejecutor = pool) {
  const campos = Object.keys(cambios);
  if (!campos.length) return getById(id);

  const sets = campos.map((campo, i) => `${campo} = $${i + 1}`);
  const params = campos.map(campo => cambios[campo]);
  params.push(id);

  const r = await ejecutor.query(
    `UPDATE pedido_detalle SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function cancelar(id, ejecutor = pool) {
  const r = await ejecutor.query(
    'UPDATE pedido_detalle SET cancelado = true WHERE id = $1 RETURNING *',
    [id]
  );
  return r.rows[0] || null;
}

// Alta o actualización de la excepción de una línea para una fecha.
// El UNIQUE (pedido_detalle_id, fecha) hace que la segunda carga de la misma
// fecha actualice en lugar de duplicar.
async function upsertExcepcion(pedidoDetalleId, { fecha, plato_id, cantidad, comentario, omitir }, ejecutor = pool) {
  const r = await ejecutor.query(`
    INSERT INTO pedido_detalle_excepciones
      (pedido_detalle_id, fecha, plato_id, cantidad, comentario, omitir)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (pedido_detalle_id, fecha) DO UPDATE SET
      plato_id   = EXCLUDED.plato_id,
      cantidad   = EXCLUDED.cantidad,
      comentario = EXCLUDED.comentario,
      omitir     = EXCLUDED.omitir
    RETURNING *
  `, [
    pedidoDetalleId,
    fecha,
    plato_id == null ? null : plato_id,
    cantidad == null ? null : cantidad,
    comentario || null,
    omitir === true,
  ]);
  return r.rows[0];
}

async function getExcepcionById(id) {
  const r = await pool.query('SELECT * FROM pedido_detalle_excepciones WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function deleteExcepcion(id, ejecutor = pool) {
  const r = await ejecutor.query(
    'DELETE FROM pedido_detalle_excepciones WHERE id = $1 RETURNING *',
    [id]
  );
  return r.rows[0] || null;
}

module.exports = {
  // resolución de fechas
  resolverEntregas, expandirHabiles, diasEnRango, aISO, sumarDias, diaSemana,
  MAX_DIAS_RANGO, DIAS_HABILES,
  // lectura
  listByPedido, getById, listExcepciones, excepcionesPorLinea, getExcepcionById,
  // escritura
  createMany, update, cancelar, upsertExcepcion, deleteExcepcion,
};
