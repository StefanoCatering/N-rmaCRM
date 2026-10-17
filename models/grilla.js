// Grilla semanal de comedor corporativo (fase 7).
//
// Reemplaza el Excel semanal de UENO / Kaitel / Itti. La idea central, de la
// que sale todo lo demás:
//
//   Por defecto TODO colaborador con plan activo come su plato base todos los
//   días hábiles. ATC solo marca las DIFERENCIAS (una celda por colaborador y
//   fecha: otro plato, o una ausencia). Sin celda = plato base.
//
// Lo que llega a cocina NO es la grilla: es UN pedido semanal por empresa, con
// una línea PUNTUAL por (plato, fecha) y la cantidad total. Nadie en cocina ve
// nombres. Ese pedido se espeja hacia Narma Pedidos con el sync de la fase 6
// (models/syncPedidos.js), que ya sincroniza el pedido completo y es
// auto-reparador, así que acá alcanza con UNA llamada por envío.

const pool = require('./db');
const detalle = require('./pedidoDetalle');
const platos = require('./platos');
const syncPedidos = require('./syncPedidos');

const AUSENCIAS = ['home_office', 'vacaciones', 'reposo', 'licencia', 'otro'];

// El plato que se considera "lo normal" al armar la hoja del día: solo se
// nombra a quien come algo distinto. Se resuelve por nombre contra el catálogo
// (no por id) para no clavar un id de producción en el código.
const PLATO_ESTANDAR = 'Estándar';

// Paraguay es UTC-3 y Vercel corre en UTC: con new Date() a secas, a partir de
// las 21:00 de Asunción el servidor ya estaría en el día siguiente y dejaría
// el día en curso en solo lectura antes de tiempo. Todas las reglas de "hoy"
// (días pasados = solo lectura, aviso del jueves) salen de acá.
const ZONA_HORARIA = 'America/Asuncion';
const FORMATO_ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit',
});

function hoyISO() {
  return FORMATO_ISO.format(new Date());
}

// ── Fechas ───────────────────────────────────────────────────────
// Mismo criterio que models/pedidoDetalle.js: todo es string 'YYYY-MM-DD' y la
// aritmética va en UTC (sumarDias / diaSemana vienen de ahí).

function esHabil(iso) {
  const d = detalle.diaSemana(iso);
  return d >= 1 && d <= 5;
}

function esLunes(iso) {
  return detalle.diaSemana(iso) === 1;
}

// Lunes de la semana de una fecha. Domingo cuenta como fin de la semana que
// termina, no como principio de la que viene.
function lunesDe(iso) {
  const d = detalle.diaSemana(iso);
  return detalle.sumarDias(iso, d === 0 ? -6 : 1 - d);
}

// Los 5 días hábiles de una semana, de lunes a viernes.
function diasDeSemana(lunes) {
  return [0, 1, 2, 3, 4].map(i => detalle.sumarDias(lunes, i));
}

// Clave de los totales y de los mapas por celda. Un string y no un array
// porque un Map con clave array compara por referencia, no por valor.
const clavePlatoFecha = (platoId, fecha) => `${platoId}|${fecha}`;
const claveCelda = (clienteId, fecha) => `${clienteId}|${fecha}`;
const claveSemana = (empresa, lunes) => `${empresa}|${lunes}`;

// ── Auditoría ────────────────────────────────────────────────────
// Toda escritura de la grilla se registra sola, sin pedirle motivo al usuario:
// la grilla se toca decenas de veces por semana y un modal de motivo por celda
// la volvería inusable (a diferencia de pedidos_auditoria, donde el motivo sí
// es obligatorio porque son ediciones excepcionales).

async function auditar(usuarioId, tabla, clave, antes, despues, ejecutor = pool) {
  await ejecutor.query(`
    INSERT INTO grilla_auditoria (usuario_id, tabla, clave, antes, despues)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    usuarioId || null, tabla, clave,
    antes === null || antes === undefined ? null : JSON.stringify(antes),
    despues === null || despues === undefined ? null : JSON.stringify(despues),
  ]);
}

// ── Empresas con grilla ──────────────────────────────────────────

async function listEmpresas({ soloActivas = true } = {}) {
  const r = await pool.query(`
    SELECT
      g.empresa, g.cliente_pedido_id, g.ubicacion_id, g.activa,
      c.nombre_completo AS cliente_nombre,
      c.tipo_envase     AS cliente_tipo_envase,
      u.direccion       AS ubicacion_direccion,
      u.zona            AS ubicacion_zona
    FROM grilla_empresas g
    JOIN clientes c ON c.id = g.cliente_pedido_id
    LEFT JOIN ubicaciones u ON u.id = g.ubicacion_id
    ${soloActivas ? 'WHERE g.activa = true' : ''}
    ORDER BY g.empresa ASC
  `);
  return r.rows;
}

async function getEmpresa(empresa) {
  const r = await pool.query(`
    SELECT
      g.empresa, g.cliente_pedido_id, g.ubicacion_id, g.activa,
      c.nombre_completo AS cliente_nombre,
      c.tipo_envase     AS cliente_tipo_envase,
      -- Sin ubicación configurada es válido (el pedido va sin dirección); con
      -- ubicación, tiene que ser del cliente cuenta-empresa. Lo chequea
      -- enviarSemana antes de tocar el pedido.
      (g.ubicacion_id IS NULL OR u.cliente_id = g.cliente_pedido_id) AS ubicacion_valida
    FROM grilla_empresas g
    JOIN clientes c ON c.id = g.cliente_pedido_id
    LEFT JOIN ubicaciones u ON u.id = g.ubicacion_id
    WHERE g.empresa = $1
  `, [empresa]);
  return r.rows[0] || null;
}

// ── Lectura de una semana ────────────────────────────────────────
// Trae de una sola vez todo lo que necesitan el cálculo de totales, la vista
// de grilla y la hoja del día: planes, celdas, días sin servicio y pedido
// general. Cuatro consultas fijas, sin N+1 por colaborador ni por día.

async function cargarSemana(empresa, lunes) {
  const dias = diasDeSemana(lunes);
  const primero = dias[0];
  const ultimo = dias[dias.length - 1];

  const [planesR, celdasR, sinServicioR, generalR] = await Promise.all([
    // Colaboradores con plan activo en ALGÚN día de la semana. El solapamiento
    // es el estándar: alta <= último día y (sin baja o baja > primer día).
    // fecha_baja es exclusiva: el primer día que la persona ya NO come.
    pool.query(`
      SELECT
        p.cliente_id, p.plato_base_id, p.observacion, p.fecha_alta, p.fecha_baja,
        c.nombre_completo, c.cedula, c.estado,
        pl.nombre AS plato_base_nombre, pl.categoria AS plato_base_categoria
      FROM grilla_planes p
      JOIN clientes c ON c.id = p.cliente_id
      JOIN platos pl  ON pl.id = p.plato_base_id
      WHERE c.empresa = $1
        AND p.fecha_alta <= $3
        AND (p.fecha_baja IS NULL OR p.fecha_baja > $2)
      ORDER BY c.nombre_completo ASC
    `, [empresa, primero, ultimo]),

    pool.query(`
      SELECT ce.id, ce.cliente_id, ce.fecha, ce.plato_id, ce.ausencia, ce.comentario,
             ce.updated_at, pl.nombre AS plato_nombre
      FROM grilla_celdas ce
      JOIN clientes c ON c.id = ce.cliente_id
      LEFT JOIN platos pl ON pl.id = ce.plato_id
      WHERE c.empresa = $1 AND ce.fecha >= $2 AND ce.fecha <= $3
    `, [empresa, primero, ultimo]),

    pool.query(`
      SELECT fecha, motivo FROM grilla_sin_servicio
      WHERE empresa = $1 AND fecha >= $2 AND fecha <= $3
    `, [empresa, primero, ultimo]),

    pool.query(`
      SELECT g.fecha, g.plato_id, g.cantidad, pl.nombre AS plato_nombre
      FROM grilla_general g
      JOIN platos pl ON pl.id = g.plato_id
      WHERE g.empresa = $1 AND g.fecha >= $2 AND g.fecha <= $3
      ORDER BY pl.nombre ASC
    `, [empresa, primero, ultimo]),
  ]);

  const colaboradores = planesR.rows.map(p => ({
    ...p,
    fecha_alta: detalle.aISO(p.fecha_alta),
    fecha_baja: detalle.aISO(p.fecha_baja),
  }));

  const celdas = new Map();
  for (const c of celdasR.rows) {
    const fecha = detalle.aISO(c.fecha);
    celdas.set(claveCelda(c.cliente_id, fecha), { ...c, fecha });
  }

  const sinServicio = new Map();
  for (const s of sinServicioR.rows) sinServicio.set(detalle.aISO(s.fecha), s.motivo || '');

  const general = generalR.rows.map(g => ({ ...g, fecha: detalle.aISO(g.fecha) }));

  return { empresa, lunes, dias, colaboradores, celdas, sinServicio, general };
}

// ¿El colaborador come ese día? fecha_baja es EXCLUSIVA.
function planActivoEn(colaborador, fecha) {
  if (colaborador.fecha_alta > fecha) return false;
  if (colaborador.fecha_baja && fecha >= colaborador.fecha_baja) return false;
  return true;
}

// Qué come efectivamente un colaborador ese día.
// → { tipo: 'ausencia', ausencia } | { tipo: 'plato', plato_id, base: bool } | null
// null = ese día no está en el plan (alta posterior o baja ya cumplida).
function platoEfectivo(datos, colaborador, fecha) {
  if (!planActivoEn(colaborador, fecha)) return null;
  const celda = datos.celdas.get(claveCelda(colaborador.cliente_id, fecha));
  if (celda && celda.ausencia) {
    return { tipo: 'ausencia', ausencia: celda.ausencia, comentario: celda.comentario, celda };
  }
  if (celda && celda.plato_id) {
    return { tipo: 'plato', plato_id: celda.plato_id, base: false, comentario: celda.comentario, celda };
  }
  return { tipo: 'plato', plato_id: colaborador.plato_base_id, base: true, comentario: null, celda: null };
}

// ── Totales ──────────────────────────────────────────────────────
// Lo único que llega a cocina. Map clave `platoId|fecha` → { plato_id, fecha,
// cantidad }. Se devuelve un Map (y no un array) porque enviarSemana lo
// consulta por clave al conciliar las líneas del pedido.

function totalesDesdeDatos(datos) {
  const totales = new Map();

  const sumar = (platoId, fecha, n) => {
    if (n <= 0) return;
    const k = clavePlatoFecha(platoId, fecha);
    const actual = totales.get(k);
    if (actual) actual.cantidad += n;
    else totales.set(k, { plato_id: platoId, fecha, cantidad: n });
  };

  for (const fecha of datos.dias) {
    // Día sin servicio: no se produce NADA para esa empresa, ni por persona ni
    // del pedido general. Gana sobre cualquier celda cargada para ese día.
    if (datos.sinServicio.has(fecha)) continue;

    for (const colaborador of datos.colaboradores) {
      const efectivo = platoEfectivo(datos, colaborador, fecha);
      if (!efectivo || efectivo.tipo !== 'plato') continue;
      sumar(efectivo.plato_id, fecha, 1);
    }

    for (const g of datos.general) {
      if (g.fecha === fecha) sumar(g.plato_id, fecha, g.cantidad);
    }
  }

  return totales;
}

async function calcularTotales(empresa, lunes) {
  return totalesDesdeDatos(await cargarSemana(empresa, lunes));
}

// ── Pedido semanal ───────────────────────────────────────────────

async function getPedidoSemana(empresa, lunes) {
  const r = await pool.query(`
    SELECT p.*
    FROM pedidos p
    JOIN grilla_empresas g ON g.cliente_pedido_id = p.cliente_id
    WHERE g.empresa = $1 AND p.origen = 'grilla' AND p.semana_lunes = $2
  `, [empresa, lunes]);
  return r.rows[0] || null;
}

// Semanas de una empresa que YA tienen pedido (es decir: ya se enviaron a
// cocina). Es lo que decide si una escritura dispara un reenvío automático.
async function semanasEnviadas(empresa, { desde = null } = {}) {
  const params = [empresa];
  let filtroDesde = '';
  if (desde) { params.push(desde); filtroDesde = `AND p.semana_lunes >= $2`; }

  const r = await pool.query(`
    SELECT p.semana_lunes
    FROM pedidos p
    JOIN grilla_empresas g ON g.cliente_pedido_id = p.cliente_id
    WHERE g.empresa = $1 AND p.origen = 'grilla' ${filtroDesde}
    ORDER BY p.semana_lunes ASC
  `, params);
  return r.rows.map(row => detalle.aISO(row.semana_lunes));
}

// Último envío registrado de una semana, con el resultado del sync de ese
// momento. Sale de grilla_auditoria: el sync solo deja rastro propio cuando
// FALLA (sync_errores), así que el registro del envío es lo único que permite
// decir "la semana se envió y el espejado salió bien".
async function ultimoEnvio(empresa, lunes) {
  const r = await pool.query(`
    SELECT a.id, a.usuario_id, a.despues, a.creado_en, u.username
    FROM grilla_auditoria a
    LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.tabla = 'grilla_envio' AND a.clave = $1
    ORDER BY a.creado_en DESC, a.id DESC
    LIMIT 1
  `, [claveSemana(empresa, lunes)]);
  if (!r.rows.length) return null;
  const fila = r.rows[0];
  return {
    fecha: fila.creado_en,
    usuario: fila.username || null,
    ...(fila.despues || {}),
  };
}

// Lo que ve ATC en el listado de pedidos. La fecha va en dd/mm/yyyy, que es
// como se muestran todas las fechas en el CRM.
const descripcionPedido = (empresa, lunes) =>
  `Grilla de comedor · ${empresa} · semana del ${lunes.slice(8, 10)}/${lunes.slice(5, 7)}/${lunes.slice(0, 4)}`;

// Deja las líneas del pedido semanal iguales a los totales calculados.
// Dentro de la transacción que le pasen: la conciliación es todo-o-nada.
//
// Una línea por (plato, fecha), siempre puntual. Las que sobran se CANCELAN
// (nunca se borran), igual que hace el resto del CRM, y una que vuelve a tener
// cantidad se REUSA (cancelado = false) en vez de crear una nueva: así el
// espejo en Narma Pedidos, que está indexado por (crm_pedido_detalle_id,
// fecha_entrega), no acumula filas canceladas fantasma.
async function conciliarLineas(client, pedidoId, totales) {
  // Los días ya pasados son intocables: cocina YA los produjo. Un cambio de
  // plato base, un alta con fecha vieja o una baja retroactiva recalculan toda
  // la semana, y sin esta guarda reescribirían líneas (y filas en Narma
  // Pedidos) de días que ya se entregaron. Las líneas de fechas anteriores a
  // hoy no se crean, no se actualizan y no se cancelan: quedan como están.
  const hoy = hoyISO();

  const existentesR = await client.query(
    `SELECT id, plato_id, cantidad, fecha_entrega, cancelado
     FROM pedido_detalle WHERE pedido_id = $1 ORDER BY id ASC`,
    [pedidoId]
  );

  const porClave = new Map();
  const duplicadas = [];
  for (const l of existentesR.rows) {
    const fecha = detalle.aISO(l.fecha_entrega);
    if (fecha < hoy) continue; // día pasado: fuera de la conciliación
    const k = clavePlatoFecha(l.plato_id, fecha);
    if (porClave.has(k)) duplicadas.push(l); // no debería pasar; se cancelan
    else porClave.set(k, l);
  }

  const resumen = { creadas: 0, actualizadas: 0, canceladas: 0, entregas: 0, omitidas_por_pasadas: 0 };
  const nuevas = [];

  for (const [k, total] of totales) {
    if (total.fecha < hoy) { resumen.omitidas_por_pasadas++; continue; }
    resumen.entregas++;

    const linea = porClave.get(k);
    if (!linea) {
      nuevas.push({
        plato_id: total.plato_id,
        cantidad: total.cantidad,
        comentario: null,
        modo: 'puntual',
        fecha_entrega: total.fecha,
        tipo_envase_override: null,
      });
      continue;
    }
    if (linea.cancelado || linea.cantidad !== total.cantidad) {
      await client.query(
        'UPDATE pedido_detalle SET cantidad = $1, cancelado = false WHERE id = $2',
        [total.cantidad, linea.id]
      );
      resumen.actualizadas++;
    }
  }

  // Solo pueden caer acá líneas de hoy en adelante: porClave y duplicadas ya
  // dejaron afuera las de días pasados.
  const sobrantes = [
    ...[...porClave.entries()].filter(([k, l]) => !totales.has(k) && !l.cancelado).map(([, l]) => l),
    ...duplicadas.filter(l => !l.cancelado),
  ].map(l => l.id);

  if (sobrantes.length) {
    await client.query(
      'UPDATE pedido_detalle SET cancelado = true WHERE id = ANY($1::int[])',
      [sobrantes]
    );
    resumen.canceladas = sobrantes.length;
  }

  if (nuevas.length) {
    await detalle.createMany(pedidoId, nuevas, client);
    resumen.creadas = nuevas.length;
  }

  return resumen;
}

// ¿La semana ya terminó? (su viernes es anterior a hoy). Una semana terminada
// no se envía ni se reenvía: no queda ningún día que cocina pueda producir.
function semanaTerminada(lunes) {
  return detalle.sumarDias(lunes, 4) < hoyISO();
}

// Envía (o reenvía) una semana a cocina.
//
// Serializado por (empresa, semana) con un advisory lock: el cálculo de
// totales se hace ANTES de la transacción, así que dos escrituras seguidas
// podían disparar dos envíos donde el que leyó datos viejos commiteaba último
// y quedaba como versión final, tanto en el CRM como en Narma Pedidos. El lock
// se toma en una conexión propia y cubre TODO: lectura, cálculo, conciliación
// y sync. Es por semana y empresa, así que no serializa envíos de semanas
// distintas ni de otras empresas.
//
// Todo el lado CRM va en UNA transacción; recién después se llama UNA vez al
// sync, que es del pedido completo. Si el sync falla, lo guardado en el CRM
// queda igual y la respuesta lo informa (mismo criterio que la fase 6).
async function enviarSemana(empresa, lunes, usuario) {
  const candado = await pool.connect();
  try {
    await candado.query('SELECT pg_advisory_lock(hashtext($1))', [claveSemana(empresa, lunes)]);
    return await enviarSemanaBloqueada(empresa, lunes, usuario);
  } finally {
    await candado.query('SELECT pg_advisory_unlock(hashtext($1))', [claveSemana(empresa, lunes)])
      .catch(err => console.error('[grilla] No se pudo liberar el lock de envío:', err.message));
    candado.release();
  }
}

async function enviarSemanaBloqueada(empresa, lunes, usuario) {
  const emp = await getEmpresa(empresa);
  if (!emp) return { ok: false, motivo: 'empresa_sin_grilla' };

  // La ubicación configurada tiene que ser una del cliente cuenta-empresa: es
  // la dirección que se denormaliza en pedidos_crm_detalle y por la que sale
  // el reparto. No se puede exigir con un CHECK (necesitaría leer otra tabla),
  // así que se valida acá, que es el único punto por donde pasa al pedido.
  if (!emp.ubicacion_valida) return { ok: false, motivo: 'ubicacion_ajena' };

  const datos = await cargarSemana(empresa, lunes);
  const totales = totalesDesdeDatos(datos);

  const client = await pool.connect();
  let pedido;
  let resumen;
  try {
    await client.query('BEGIN');

    const existente = await client.query(
      `SELECT * FROM pedidos
       WHERE cliente_id = $1 AND semana_lunes = $2 AND origen = 'grilla'
       FOR UPDATE`,
      [emp.cliente_pedido_id, lunes]
    );
    pedido = existente.rows[0];

    if (!pedido) {
      // monto = 0 y estado_pago 'pendiente': la facturación del comedor no es
      // parte de esta fase. pedidos.monto es INTEGER NOT NULL sin CHECK, así
      // que acepta 0.
      pedido = (await client.query(`
        INSERT INTO pedidos
          (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, descripcion,
           ubicacion_id, origen, semana_lunes)
        VALUES ($1, $2, 0, NULL, 'pendiente', $3, $4, 'grilla', $2)
        RETURNING *
      `, [emp.cliente_pedido_id, lunes, descripcionPedido(empresa, lunes), emp.ubicacion_id])).rows[0];
    } else {
      // grilla_empresas manda sobre el pedido: si cambió la ubicación de
      // entrega, el reenvío la corrige. cancelado = false porque este pedido
      // lo gobierna la grilla — los endpoints de /api/pedidos no lo pueden
      // cancelar, así que si quedó cancelado fue a mano en la base.
      pedido = (await client.query(
        `UPDATE pedidos SET ubicacion_id = $1, cancelado = false WHERE id = $2 RETURNING *`,
        [emp.ubicacion_id, pedido.id]
      )).rows[0];
    }

    resumen = await conciliarLineas(client, pedido.id, totales);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // El sync nunca lanza: devuelve { ok: false, ... } y deja el intento en
  // sync_errores para poder reenviarlo desde "Reintentar".
  const sync = await syncPedidos.sincronizarSinFallar(pedido.id);

  await auditar(
    usuario && usuario.id, 'grilla_envio', claveSemana(empresa, lunes), null,
    { pedido_id: pedido.id, resumen, sync }
  );

  return { ok: true, pedido, resumen, sync };
}

// Reenvía automáticamente las semanas afectadas por una escritura, pero SOLO
// las que ya se habían enviado: si la semana todavía no fue a cocina, el
// cambio simplemente queda guardado.
//
// Nunca lanza: el dato de la grilla ya está commiteado cuando se llama acá, y
// un reenvío fallido no debe deshacerlo ni voltear el request.
async function reenviarSiCorresponde(empresa, lunesAfectados, usuario) {
  const envios = [];
  const yaEnviadas = new Set(await semanasEnviadas(empresa));

  for (const lunes of new Set(lunesAfectados)) {
    if (!yaEnviadas.has(lunes)) continue;
    // Una semana ya terminada no tiene nada que reenviar: conciliarLineas no
    // tocaría ninguna línea y el sync solo generaría ruido en producción.
    if (semanaTerminada(lunes)) continue;
    try {
      const r = await enviarSemana(empresa, lunes, usuario);
      envios.push({ lunes, ...r });
    } catch (err) {
      console.error(`[grilla] Falló el reenvío automático de ${empresa} ${lunes}:`, err.message);
      envios.push({ lunes, ok: false, motivo: 'error', error: err.message });
    }
  }
  return envios;
}

// ── Hoja del día ─────────────────────────────────────────────────
// Lo que se imprime para armar y etiquetar en el banco: cuánto de cada plato,
// y a quién corresponde lo que NO es el plato estándar.

async function hojaDia(empresa, fecha) {
  const datos = await cargarSemana(empresa, lunesDe(fecha));
  const sinServicio = datos.sinServicio.has(fecha);

  const idsPlato = new Set();
  for (const c of datos.colaboradores) idsPlato.add(c.plato_base_id);
  for (const celda of datos.celdas.values()) if (celda.plato_id) idsPlato.add(celda.plato_id);
  for (const g of datos.general) idsPlato.add(g.plato_id);
  const fichas = await platos.fichasPorId([...idsPlato]);
  const nombrePlato = id => (fichas.get(id) || {}).etiqueta || `Plato #${id}`;

  // Totales del día: los mismos que se mandan a cocina, filtrados por fecha.
  const totales = [...totalesDesdeDatos(datos).values()]
    .filter(t => t.fecha === fecha)
    .map(t => ({ ...t, plato_nombre: nombrePlato(t.plato_id) }))
    .sort((a, b) => a.plato_nombre.localeCompare(b.plato_nombre, 'es'));

  // Lista nominal: solo quien se aparta de lo normal. Quien come el plato
  // estándar no se nombra — para eso está el total.
  const porPlato = new Map();
  const ausencias = [];
  // Las observaciones fijas ("no consume cerdo") no cambian lo que se cocina,
  // pero sí cómo se arma la vianda, así que van aunque la persona coma Estándar.
  const observaciones = [];

  for (const colaborador of datos.colaboradores) {
    const efectivo = sinServicio ? null : platoEfectivo(datos, colaborador, fecha);
    if (!efectivo) continue;

    const persona = {
      cliente_id: colaborador.cliente_id,
      nombre_completo: colaborador.nombre_completo,
      observacion: colaborador.observacion || null,
    };

    if (efectivo.tipo === 'ausencia') {
      ausencias.push({ ...persona, ausencia: efectivo.ausencia, comentario: efectivo.comentario });
      continue;
    }

    const nombre = nombrePlato(efectivo.plato_id);
    if (nombre !== PLATO_ESTANDAR) {
      if (!porPlato.has(nombre)) porPlato.set(nombre, { plato_id: efectivo.plato_id, plato_nombre: nombre, personas: [] });
      porPlato.get(nombre).personas.push({ ...persona, comentario: efectivo.comentario, base: efectivo.base });
    } else if (persona.observacion) {
      observaciones.push(persona);
    }
  }

  return {
    empresa,
    fecha,
    sin_servicio: sinServicio,
    motivo_sin_servicio: sinServicio ? datos.sinServicio.get(fecha) : null,
    totales,
    total_viandas: totales.reduce((n, t) => n + t.cantidad, 0),
    grupos: [...porPlato.values()].sort((a, b) => a.plato_nombre.localeCompare(b.plato_nombre, 'es')),
    ausencias: ausencias.sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es')),
    observaciones: observaciones.sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es')),
  };
}

// ── Clientes de la empresa que todavía no están en el plan ───────
// Para el alta de colaboradores desde la vista. Deja afuera a la cuenta
// empresa (no es una persona que coma) y a quien ya tiene plan vigente; sí
// incluye a quien tuvo plan y se dio de baja, para poder reincorporarlo.

async function candidatos(empresa, { q = null } = {}) {
  const params = [empresa, hoyISO()];
  let filtroQ = '';
  if (q) { params.push(`%${q}%`); filtroQ = `AND (c.nombre_completo ILIKE $3 OR c.cedula ILIKE $3)`; }

  const r = await pool.query(`
    SELECT c.id, c.nombre_completo, c.cedula, c.estado, p.fecha_baja
    FROM clientes c
    LEFT JOIN grilla_planes p ON p.cliente_id = c.id
    LEFT JOIN grilla_empresas g ON g.cliente_pedido_id = c.id
    WHERE c.empresa = $1
      AND g.empresa IS NULL
      AND (p.cliente_id IS NULL OR (p.fecha_baja IS NOT NULL AND p.fecha_baja <= $2))
      ${filtroQ}
    ORDER BY c.nombre_completo ASC
    LIMIT 200
  `, params);
  return r.rows.map(row => ({ ...row, fecha_baja: detalle.aISO(row.fecha_baja) }));
}

// Valida en UNA consulta un alta de varios colaboradores: devuelve, por cada
// id pedido, si existe, si es de la empresa, si es la cuenta-empresa y si ya
// tiene un plan vigente. Antes era un getById() por id, y getById() agrega
// todos los pedidos del cliente: con 200 altas de golpe eran 200 agregaciones.
async function revisarAlta(empresa, ids) {
  const r = await pool.query(`
    SELECT
      c.id, c.nombre_completo, c.empresa,
      (g.empresa IS NOT NULL)                                             AS es_cuenta_empresa,
      (p.cliente_id IS NOT NULL AND (p.fecha_baja IS NULL OR p.fecha_baja > $2)) AS plan_vigente
    FROM clientes c
    LEFT JOIN grilla_planes p   ON p.cliente_id = c.id
    LEFT JOIN grilla_empresas g ON g.cliente_pedido_id = c.id AND g.empresa = $3
    WHERE c.id = ANY($1::int[])
  `, [ids, hoyISO(), empresa]);
  return new Map(r.rows.map(row => [row.id, row]));
}

async function getPlan(clienteId) {
  const r = await pool.query(`
    SELECT p.*, c.empresa, c.nombre_completo,
           pl.nombre AS plato_base_nombre, pl.categoria AS plato_base_categoria
    FROM grilla_planes p
    JOIN clientes c ON c.id = p.cliente_id
    JOIN platos pl  ON pl.id = p.plato_base_id
    WHERE p.cliente_id = $1
  `, [clienteId]);
  if (!r.rows.length) return null;
  const plan = r.rows[0];
  plan.fecha_alta = detalle.aISO(plan.fecha_alta);
  plan.fecha_baja = detalle.aISO(plan.fecha_baja);
  return plan;
}

async function getCelda(clienteId, fecha) {
  const r = await pool.query(
    'SELECT * FROM grilla_celdas WHERE cliente_id = $1 AND fecha = $2',
    [clienteId, fecha]
  );
  if (!r.rows.length) return null;
  return { ...r.rows[0], fecha: detalle.aISO(r.rows[0].fecha) };
}

// ── Escrituras de la grilla ──────────────────────────────────────
// Cada una hace su cambio y su registro de auditoría en UNA transacción: un
// cambio sin rastro (o un rastro sin cambio) sería peor que no auditar nada.

async function enTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Alta o cambio de la diferencia de un colaborador en un día.
// Es un upsert por el UNIQUE (cliente_id, fecha): volver a marcar la misma
// celda la pisa, no duplica.
async function upsertCelda({ cliente_id, fecha, plato_id, ausencia, comentario }, usuario) {
  return enTransaccion(async (client) => {
    const antes = (await client.query(
      'SELECT * FROM grilla_celdas WHERE cliente_id = $1 AND fecha = $2',
      [cliente_id, fecha]
    )).rows[0] || null;

    const celda = (await client.query(`
      INSERT INTO grilla_celdas (cliente_id, fecha, plato_id, ausencia, comentario, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)
      ON CONFLICT (cliente_id, fecha) DO UPDATE SET
        plato_id   = EXCLUDED.plato_id,
        ausencia   = EXCLUDED.ausencia,
        comentario = EXCLUDED.comentario,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING *
    `, [cliente_id, fecha, plato_id || null, ausencia || null, comentario || null, (usuario && usuario.id) || null])).rows[0];

    await auditar(usuario && usuario.id, 'grilla_celdas', claveCelda(cliente_id, fecha), antes, celda, client);
    return celda;
  });
}

// Quita la diferencia: ese día el colaborador vuelve a su plato base.
async function borrarCelda(clienteId, fecha, usuario) {
  return enTransaccion(async (client) => {
    const borrada = (await client.query(
      'DELETE FROM grilla_celdas WHERE cliente_id = $1 AND fecha = $2 RETURNING *',
      [clienteId, fecha]
    )).rows[0] || null;

    if (borrada) {
      await auditar(usuario && usuario.id, 'grilla_celdas', claveCelda(clienteId, fecha), borrada, null, client);
    }
    return borrada;
  });
}

// La misma diferencia para varias fechas de un colaborador (vacaciones, una
// licencia larga). Una sola fila de auditoría para toda la operación: veinte
// entradas idénticas no se leen mejor que una que dice el rango.
async function upsertCeldasRango({ cliente_id, fechas, plato_id, ausencia, comentario }, usuario) {
  if (!fechas.length) return [];
  return enTransaccion(async (client) => {
    const guardadas = [];
    for (const fecha of fechas) {
      guardadas.push((await client.query(`
        INSERT INTO grilla_celdas (cliente_id, fecha, plato_id, ausencia, comentario, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        ON CONFLICT (cliente_id, fecha) DO UPDATE SET
          plato_id   = EXCLUDED.plato_id,
          ausencia   = EXCLUDED.ausencia,
          comentario = EXCLUDED.comentario,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
        RETURNING *
      `, [cliente_id, fecha, plato_id || null, ausencia || null, comentario || null, (usuario && usuario.id) || null])).rows[0]);
    }

    await auditar(
      usuario && usuario.id, 'grilla_celdas',
      `cliente=${cliente_id}|rango=${fechas[0]}..${fechas[fechas.length - 1]}`,
      null,
      { fechas, plato_id: plato_id || null, ausencia: ausencia || null, comentario: comentario || null },
      client
    );
    return guardadas;
  });
}

// Día completo sin producción para una empresa (feriado).
async function setSinServicio(empresa, fecha, motivo, usuario) {
  return enTransaccion(async (client) => {
    const antes = (await client.query(
      'SELECT * FROM grilla_sin_servicio WHERE empresa = $1 AND fecha = $2',
      [empresa, fecha]
    )).rows[0] || null;

    const fila = (await client.query(`
      INSERT INTO grilla_sin_servicio (empresa, fecha, motivo)
      VALUES ($1, $2, $3)
      ON CONFLICT (empresa, fecha) DO UPDATE SET motivo = EXCLUDED.motivo
      RETURNING *
    `, [empresa, fecha, motivo || null])).rows[0];

    await auditar(usuario && usuario.id, 'grilla_sin_servicio', `${empresa}|${fecha}`, antes, fila, client);
    return fila;
  });
}

async function borrarSinServicio(empresa, fecha, usuario) {
  return enTransaccion(async (client) => {
    const borrada = (await client.query(
      'DELETE FROM grilla_sin_servicio WHERE empresa = $1 AND fecha = $2 RETURNING *',
      [empresa, fecha]
    )).rows[0] || null;

    if (borrada) {
      await auditar(usuario && usuario.id, 'grilla_sin_servicio', `${empresa}|${fecha}`, borrada, null, client);
    }
    return borrada;
  });
}

// Pedido general: cantidad de un ítem que no va por persona, para un día.
// cantidad = 0 se guarda igual (deja el ítem visible en la grilla); el cálculo
// de totales descarta las filas en 0, así que un 0 nunca llega a cocina.
async function setGeneral(empresa, fecha, platoId, cantidad, usuario) {
  return enTransaccion(async (client) => {
    const antes = (await client.query(
      'SELECT * FROM grilla_general WHERE empresa = $1 AND fecha = $2 AND plato_id = $3',
      [empresa, fecha, platoId]
    )).rows[0] || null;

    const fila = (await client.query(`
      INSERT INTO grilla_general (empresa, fecha, plato_id, cantidad)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (empresa, fecha, plato_id) DO UPDATE SET cantidad = EXCLUDED.cantidad
      RETURNING *
    `, [empresa, fecha, platoId, cantidad])).rows[0];

    await auditar(usuario && usuario.id, 'grilla_general', `${empresa}|${fecha}|plato=${platoId}`, antes, fila, client);
    return fila;
  });
}

// Alta de uno o varios colaboradores al plan.
// Es un upsert sobre la PK cliente_id: reincorporar a alguien que se había
// dado de baja reusa su fila (y le limpia la fecha_baja) en lugar de fallar.
// Que no haya un plan VIGENTE lo valida la ruta antes de llegar acá.
async function crearPlanes(clienteIds, { plato_base_id, observacion, fecha_alta }, usuario) {
  return enTransaccion(async (client) => {
    const creados = [];
    for (const clienteId of clienteIds) {
      const antes = (await client.query(
        'SELECT * FROM grilla_planes WHERE cliente_id = $1', [clienteId]
      )).rows[0] || null;

      const plan = (await client.query(`
        INSERT INTO grilla_planes (cliente_id, plato_base_id, observacion, fecha_alta, fecha_baja)
        VALUES ($1, $2, $3, $4, NULL)
        ON CONFLICT (cliente_id) DO UPDATE SET
          plato_base_id = EXCLUDED.plato_base_id,
          observacion   = EXCLUDED.observacion,
          fecha_alta    = EXCLUDED.fecha_alta,
          fecha_baja    = NULL,
          updated_at    = NOW()
        RETURNING *
      `, [clienteId, plato_base_id, observacion || null, fecha_alta])).rows[0];

      await auditar(usuario && usuario.id, 'grilla_planes', `cliente=${clienteId}`, antes, plan, client);
      creados.push(plan);
    }
    return creados;
  });
}

// Cambio de plato base, de observación, o baja con fecha.
// `cambios` viene de una whitelist en routes/grilla.js, nunca del body crudo.
async function actualizarPlan(clienteId, cambios, usuario) {
  const campos = Object.keys(cambios);
  if (!campos.length) return getPlan(clienteId);

  return enTransaccion(async (client) => {
    const antes = (await client.query(
      'SELECT * FROM grilla_planes WHERE cliente_id = $1', [clienteId]
    )).rows[0] || null;

    const sets = campos.map((campo, i) => `${campo} = $${i + 1}`);
    const params = campos.map(campo => cambios[campo]);
    params.push(clienteId);

    const plan = (await client.query(
      `UPDATE grilla_planes SET ${sets.join(', ')}, updated_at = NOW()
       WHERE cliente_id = $${params.length} RETURNING *`,
      params
    )).rows[0];

    await auditar(usuario && usuario.id, 'grilla_planes', `cliente=${clienteId}`, antes, plan, client);
    return plan;
  });
}

module.exports = {
  // constantes
  AUSENCIAS, PLATO_ESTANDAR, ZONA_HORARIA,
  // fechas
  hoyISO, esHabil, esLunes, lunesDe, diasDeSemana, semanaTerminada,
  clavePlatoFecha, claveCelda, claveSemana,
  // lectura
  listEmpresas, getEmpresa, cargarSemana, planActivoEn, platoEfectivo,
  getPedidoSemana, semanasEnviadas, ultimoEnvio, hojaDia, candidatos,
  getPlan, getCelda, revisarAlta,
  // cálculo
  calcularTotales, totalesDesdeDatos,
  // escritura
  auditar, enviarSemana, reenviarSiCorresponde, enTransaccion,
  upsertCelda, borrarCelda, upsertCeldasRango,
  setSinServicio, borrarSinServicio, setGeneral,
  crearPlanes, actualizarPlan,
};
