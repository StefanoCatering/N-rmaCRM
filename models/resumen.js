// Resumen del día (fase 9). SOLO LECTURA.
//
// Para qué es: Administración revisa la noche anterior que todo lo cargado en
// el CRM cuadre contra el resumen de ATC y los mensajes de las encargadas, y
// cocina produce de madrugada. Este módulo arma esa hoja de control:
//
//   a) el total del día por plato y envase,
//   b) el mismo total contra lo que cocina REALMENTE recibió
//      (pedidos_crm_detalle, en la base de Narma Pedidos),
//   c) el desglose por fuente (grilla de comedor, cada empresa, particulares),
//      desplegable hasta el detalle por cliente.
//
// La regla que gobierna todo: el total tiene que dar EXACTAMENTE lo mismo que
// le manda el sync a cocina. Por eso la resolución de entregas no se escribe
// acá — sale de models/entregas.js, el mismo módulo que usa
// models/syncPedidos.js. Lo único propio de este archivo es la lectura en lote
// por fecha y la agregación.
//
// Nada de este módulo escribe: ni en el CRM ni en la base de Pedidos.

const pool = require('./db');
const { pool: pedidosPool, habilitado } = require('./dbPedidos');
const detalle = require('./pedidoDetalle');
const entregas = require('./entregas');
const platos = require('./platos');

// Los dos envases que existen (CHECK de clientes.tipo_envase y de
// pedido_detalle.tipo_envase_override). Las dos columnas se muestran SIEMPRE,
// aunque una esté en 0: que una quede en cero es información, no un motivo
// para esconderla.
const ENVASES = ['Narma', 'Venezia'];

const FUENTE_PARTICULARES = 'Particulares';
const PREFIJO_GRILLA = 'Grilla · ';

// Fecha que abre el resumen por defecto: MAÑANA en hora de Asunción. Es el día
// que Administración revisa cada noche. hoyISO() sale de pedidoDetalle, el
// mismo reloj que usa la grilla.
function fechaPorDefecto() {
  return detalle.sumarDias(detalle.hoyISO(), 1);
}

// ── Lectura en lote ──────────────────────────────────────────────
// Todas las líneas que PUEDEN entregar en la fecha pedida, con la cabecera de
// su pedido. Tres consultas fijas para todo el día (líneas, excepciones,
// nombres de plato): nunca una por pedido ni una por línea.
//
// Una línea entra si es puntual de ese día, o recurrente con la fecha dentro
// de su rango. Si ese día de la recurrente de verdad produce algo —puede caer
// sábado, o tener una excepción con omitir— lo decide después
// resolverEntregas(), que es la misma función que usa el sync.
//
// Se descartan acá los pedidos cancelados y las líneas canceladas: no se
// producen, así que no son parte del total del día.
const SQL_LINEAS = `
  SELECT
    d.*,
    p.origen           AS origen,
    p.semana_lunes     AS semana_lunes,
    c.id               AS cliente_id,
    c.nombre_completo  AS cliente_nombre,
    c.segmento         AS segmento,
    c.empresa          AS empresa,
    c.tipo_envase      AS cliente_tipo_envase,
    u.direccion        AS ubicacion_direccion
  FROM pedido_detalle d
  JOIN pedidos p  ON p.id = d.pedido_id
  JOIN clientes c ON c.id = p.cliente_id
  LEFT JOIN ubicaciones u ON u.id = p.ubicacion_id
  WHERE p.cancelado = false
    AND d.cancelado = false
    AND (
      (d.modo = 'puntual'    AND d.fecha_entrega = $1)
      OR
      (d.modo = 'recurrente' AND d.fecha_desde <= $1 AND d.fecha_hasta >= $1)
    )
  ORDER BY d.pedido_id ASC, d.id ASC
`;

// Solo las excepciones de ESA fecha. resolverEntregas() las busca por fecha, y
// una excepción de otro día no puede cambiar lo que se entrega en esta — así
// que no hace falta traer las del resto del rango.
const SQL_EXCEPCIONES = `
  SELECT *
  FROM pedido_detalle_excepciones
  WHERE fecha = $1 AND pedido_detalle_id = ANY($2::int[])
`;

// ── Fuente de una entrega ────────────────────────────────────────
// Con qué bloque del desglose se corresponde una línea:
//
//   origen = 'grilla'   → "Grilla · <empresa>". Es el pedido semanal que arma
//                         sola la grilla de comedor; su cliente es la cuenta
//                         empresa (UENO BANK — Comedor), de ahí la empresa.
//   segmento = 'empresa'→ la empresa del cliente. Así cada heladera, AYMAC y
//                         Matrix se ven por separado, y los colaboradores de
//                         Kaitel o Itti quedan juntos por empresa.
//   resto               → "Particulares" (segmentos particular y embajador:
//                         los dos son personas que piden para sí).
//
// El fallback al nombre del cliente es defensivo: hoy ningún cliente de
// segmento 'empresa' tiene la empresa vacía, y si alguno quedara así es mejor
// verlo con nombre y apellido que agrupado en un bloque sin título.
function fuenteDe(fila) {
  if (fila.origen === 'grilla') return PREFIJO_GRILLA + (fila.empresa || fila.cliente_nombre);
  if (fila.segmento === 'empresa') return fila.empresa || fila.cliente_nombre;
  return FUENTE_PARTICULARES;
}

// Orden de los bloques: primero la grilla de comedor (es el volumen grande),
// después las empresas en orden alfabético, y Particulares al final.
function ordenFuentes(a, b) {
  const rango = (f) => (f.startsWith(PREFIJO_GRILLA) ? 0 : f === FUENTE_PARTICULARES ? 2 : 1);
  const ra = rango(a.fuente);
  const rb = rango(b.fuente);
  if (ra !== rb) return ra - rb;
  return a.fuente.localeCompare(b.fuente, 'es');
}

// ── Entregas del día ─────────────────────────────────────────────
// Las entregas de la fecha, resueltas igual que las resuelve el sync. Cada
// entrega sale con la fila que va a pedidos_crm_detalle (plato_nombre con la
// etiqueta, tipo_envase ya resuelto) más el contexto que necesita el desglose
// (fuente, cliente, origen).
async function entregasDelDia(fecha) {
  const lineas = (await pool.query(SQL_LINEAS, [fecha])).rows;
  if (!lineas.length) return [];

  const excepcionesR = await pool.query(SQL_EXCEPCIONES, [fecha, lineas.map(l => l.id)]);
  const excepcionesPorLinea = new Map();
  for (const e of excepcionesR.rows) {
    if (!excepcionesPorLinea.has(e.pedido_detalle_id)) excepcionesPorLinea.set(e.pedido_detalle_id, []);
    excepcionesPorLinea.get(e.pedido_detalle_id).push(e);
  }

  const nombres = await platos.nombresPorId(entregas.idsDePlatos(lineas, excepcionesPorLinea));

  // Una cabecera por pedido. Las líneas del mismo pedido comparten cliente,
  // segmento, envase y dirección, así que alcanza con la primera que aparezca.
  const pedidosPorId = new Map();
  const contextoPorPedido = new Map();
  for (const l of lineas) {
    if (pedidosPorId.has(l.pedido_id)) continue;
    pedidosPorId.set(l.pedido_id, {
      pedido_id: l.pedido_id,
      cliente_nombre: l.cliente_nombre,
      segmento: l.segmento,
      cliente_tipo_envase: l.cliente_tipo_envase,
      ubicacion_direccion: l.ubicacion_direccion,
    });
    contextoPorPedido.set(l.pedido_id, {
      pedido_id: l.pedido_id,
      cliente_id: l.cliente_id,
      origen: l.origen,
      empresa: l.empresa,
      semana_lunes: detalle.aISO(l.semana_lunes),
      fuente: fuenteDe(l),
    });
  }

  // soloFecha: expande el rango completo de la línea (la misma llamada que
  // hace el sync) y se queda con el día pedido.
  const { filas } = entregas.expandir({
    lineas, pedidosPorId, excepcionesPorLinea, nombres, soloFecha: fecha,
  });

  return filas.map(fila => ({ ...fila, ...contextoPorPedido.get(fila.crm_pedido_id) }));
}

// ── Lo que cocina recibió de verdad ──────────────────────────────
// pedidos_crm_detalle vive en la base de Narma Pedidos (models/dbPedidos.js).
// Un solo SELECT agrupado, sin transacción ni estado de sesión: el pooler de
// Supabase está en modo transacción.
//
// Si la conexión no está configurada o está caída, NO se cae el resumen: se
// devuelve disponible = false con el motivo y la pantalla muestra todo lo
// demás igual, avisando que el control contra cocina no se pudo hacer.
async function totalesDeCocina(fecha) {
  if (!habilitado()) {
    return {
      disponible: false,
      motivo: 'PEDIDOS_DATABASE_URL no está configurada: no se puede leer lo que recibió cocina.',
      filas: [],
    };
  }

  try {
    const r = await pedidosPool.query(`
      SELECT plato_nombre, tipo_envase, SUM(cantidad)::int AS cantidad
      FROM pedidos_crm_detalle
      WHERE fecha_entrega = $1 AND cancelado = false
      GROUP BY plato_nombre, tipo_envase
    `, [fecha]);
    return { disponible: true, motivo: null, filas: r.rows };
  } catch (err) {
    console.error('[resumen] No se pudo leer pedidos_crm_detalle:', err.message);
    return {
      disponible: false,
      motivo: `No se pudo leer la base de cocina: ${err.message}`,
      filas: [],
    };
  }
}

// ── Agregación ───────────────────────────────────────────────────

const celdaVacia = () => ({ Narma: 0, Venezia: 0, total: 0 });

function sumarEn(celda, envase, cantidad) {
  if (ENVASES.includes(envase)) celda[envase] += cantidad;
  celda.total += cantidad;
}

// Total del día: una fila por plato con las dos columnas de envase, más la
// fila de total. Cada fila lleva al lado lo que cocina recibió para ese plato
// y esa diferencia, que es el control que mira Administración.
function armarTotal(filas, cocina) {
  const porPlato = new Map();
  const tomar = (plato) => {
    if (!porPlato.has(plato)) porPlato.set(plato, { plato, crm: celdaVacia(), cocina: celdaVacia() });
    return porPlato.get(plato);
  };

  for (const f of filas) sumarEn(tomar(f.plato_nombre || '(plato sin nombre)').crm, f.tipo_envase, f.cantidad);
  // Los platos que están solo del lado de cocina también entran: una fila que
  // quedó viva allá y que el CRM ya no pide es exactamente el tipo de
  // descuadre que hay que ver.
  for (const f of cocina.filas) sumarEn(tomar(f.plato_nombre || '(plato sin nombre)').cocina, f.tipo_envase, f.cantidad);

  const platos = [...porPlato.values()].map(p => {
    const diferencia = {
      Narma: p.cocina.Narma - p.crm.Narma,
      Venezia: p.cocina.Venezia - p.crm.Venezia,
      total: p.cocina.total - p.crm.total,
    };
    return {
      plato: p.plato,
      crm: p.crm,
      cocina: p.cocina,
      diferencia,
      coincide: diferencia.Narma === 0 && diferencia.Venezia === 0 && diferencia.total === 0,
    };
  }).sort((a, b) => a.plato.localeCompare(b.plato, 'es'));

  const acumular = (clave) => platos.reduce((acc, p) => {
    acc.Narma += p[clave].Narma;
    acc.Venezia += p[clave].Venezia;
    acc.total += p[clave].total;
    return acc;
  }, celdaVacia());

  return {
    platos,
    totales: { crm: acumular('crm'), cocina: acumular('cocina') },
    coincide: cocina.disponible && platos.every(p => p.coincide),
  };
}

// Desglose por fuente: un bloque por fuente con su total por plato, y el
// detalle por cliente para desplegar (así cada heladera se ve por separado).
function armarFuentes(filas) {
  const porFuente = new Map();

  for (const f of filas) {
    if (!porFuente.has(f.fuente)) {
      porFuente.set(f.fuente, {
        fuente: f.fuente,
        origen: f.origen,
        empresa: f.empresa,
        semana_lunes: f.semana_lunes,
        total: 0,
        platos: new Map(),
        detalle: [],
      });
    }
    const bloque = porFuente.get(f.fuente);
    const plato = f.plato_nombre || '(plato sin nombre)';

    bloque.total += f.cantidad;
    if (!bloque.platos.has(plato)) bloque.platos.set(plato, 0);
    bloque.platos.set(plato, bloque.platos.get(plato) + f.cantidad);
    bloque.detalle.push({
      cliente_id: f.cliente_id,
      cliente: f.cliente_nombre,
      plato,
      envase: f.tipo_envase,
      cantidad: f.cantidad,
      comentario: f.comentario,
    });
  }

  return [...porFuente.values()].map(b => ({
    fuente: b.fuente,
    origen: b.origen,
    empresa: b.empresa,
    semana_lunes: b.semana_lunes,
    total: b.total,
    platos: [...b.platos.entries()]
      .map(([plato, cantidad]) => ({ plato, cantidad }))
      .sort((a, b2) => a.plato.localeCompare(b2.plato, 'es')),
    detalle: b.detalle.sort((a, b2) =>
      a.cliente.localeCompare(b2.cliente, 'es') || a.plato.localeCompare(b2.plato, 'es')),
  })).sort(ordenFuentes);
}

// ── Punto de entrada ─────────────────────────────────────────────
async function armar(fecha) {
  const filas = await entregasDelDia(fecha);
  const cocina = await totalesDeCocina(fecha);

  return {
    fecha,
    envases: ENVASES,
    total: armarTotal(filas, cocina),
    cocina: { disponible: cocina.disponible, motivo: cocina.motivo },
    fuentes: armarFuentes(filas),
    entregas: filas.length,
  };
}

module.exports = {
  armar, fechaPorDefecto, entregasDelDia, fuenteDe, ENVASES,
  // exportados para poder verificar la comparación contra cocina sin tener que
  // escribir en ninguna de las dos bases
  armarTotal, armarFuentes,
};
