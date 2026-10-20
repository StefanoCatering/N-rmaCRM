const pool = require('./db');
const detalle = require('./pedidoDetalle');

// Registra una entrada en pedidos_auditoria. Es el mismo patrón de auditoría
// obligatoria que ya usaban update() y cancelar(), extraído para poder reusarlo
// desde las operaciones sobre líneas y excepciones (fase 6).
// accion: 'edicion' | 'cancelacion' | 'creacion' | 'pago' (CHECK de la tabla).
// motivo va null en 'creacion' y 'pago' — nadie justifica por escrito haber
// cargado un pedido; en 'edicion' y 'cancelacion' sigue siendo obligatorio y
// lo exige tanto el CHECK de la tabla como routes/pedidos.js (fase 8).
async function auditar(pedidoId, accion, usuario, detalleJson, motivo, ejecutor = pool) {
  await ejecutor.query(
    `INSERT INTO pedidos_auditoria (pedido_id, accion, usuario, detalle, motivo)
     VALUES ($1, $2, $3, $4, $5)`,
    [pedidoId, accion, usuario, detalleJson === null ? null : JSON.stringify(detalleJson), motivo]
  );
}

async function listByCliente(clienteId) {
  const result = await pool.query(
    'SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY fecha_pedido DESC, id DESC',
    [clienteId]
  );
  return result.rows;
}

async function getById(id) {
  const result = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// Actualiza solo el estado de pago y el monto pagado de un pedido existente, y
// lo registra en pedidos_auditoria — las dos cosas en una transacción, para que
// no pueda quedar un cobro marcado sin constancia de quién lo marcó.
// pedidoActual: fila de pedidos antes del cambio (para el "antes" del detalle).
async function updatePago(id, pedidoActual, estado_pago, monto_pagado, usuario) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE pedidos SET estado_pago = $1, monto_pagado = $2 WHERE id = $3 RETURNING *`,
      [estado_pago, monto_pagado === undefined ? null : monto_pagado, id]
    );
    const actualizado = result.rows[0] || null;

    if (actualizado) {
      await auditar(id, 'pago', usuario, {
        antes:   { estado_pago: pedidoActual.estado_pago, monto_pagado: pedidoActual.monto_pagado },
        despues: { estado_pago: actualizado.estado_pago,  monto_pagado: actualizado.monto_pagado },
      }, null, client);
    }

    await client.query('COMMIT');
    return actualizado;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Actualiza campos editables de un pedido (monto, fecha_pedido, tipo_vianda) y registra
// en pedidos_auditoria el detalle de los campos que efectivamente cambiaron.
// pedidoActual: fila de pedidos antes del cambio (para armar el detalle anterior/nuevo).
// cambios: objeto solo con los campos provistos en el request.
async function update(id, pedidoActual, cambios, usuario, motivo) {
  const campos = Object.keys(cambios);
  const sets = campos.map((campo, i) => `${campo} = $${i + 1}`);
  const params = campos.map(campo => cambios[campo]);
  params.push(id);

  const result = await pool.query(
    `UPDATE pedidos SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  const actualizado = result.rows[0];

  const detalleAuditoria = {};
  for (const campo of campos) {
    detalleAuditoria[campo] = { anterior: pedidoActual[campo], nuevo: cambios[campo] };
  }
  await auditar(id, 'edicion', usuario, detalleAuditoria, motivo);

  return actualizado;
}

// Marca un pedido como cancelado y registra la auditoría.
// Cancela además todas sus líneas, para que el estado del CRM quede coherente:
// un pedido cancelado no puede tener líneas vivas, y el sync hacia Narma Pedidos
// marca cancelado = true en todas las filas resueltas de ese pedido.
async function cancelar(id, usuario, motivo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE pedidos SET cancelado = true WHERE id = $1 RETURNING *`,
      [id]
    );
    const actualizado = result.rows[0];

    await client.query(
      `UPDATE pedido_detalle SET cancelado = true WHERE pedido_id = $1 AND cancelado = false`,
      [id]
    );

    await auditar(id, 'cancelacion', usuario, null, motivo, client);

    await client.query('COMMIT');
    return actualizado;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Historial de auditoría (ediciones y cancelaciones) de un pedido, más reciente primero.
async function listAuditoria(pedidoId) {
  const result = await pool.query(
    `SELECT * FROM pedidos_auditoria WHERE pedido_id = $1 ORDER BY fecha DESC`,
    [pedidoId]
  );
  return result.rows;
}

// Las fechas de entrega de las líneas VIVAS de cada pedido, agregadas por
// pedido. Una línea puntual aporta su fecha_entrega a las dos puntas; una
// recurrente aporta fecha_desde al mínimo y fecha_hasta al máximo.
const SQL_FECHAS_LINEAS = `
  SELECT
    pedido_id,
    MIN(COALESCE(fecha_entrega, fecha_desde)) AS desde,
    MAX(COALESCE(fecha_entrega, fecha_hasta)) AS hasta
  FROM pedido_detalle
  WHERE cancelado = false
  GROUP BY pedido_id
`;

// La ventana de entrega de un pedido, en SQL: las líneas vivas si tiene, la
// cabecera si no. Es la misma regla que entregaEfectiva() más abajo — acá en
// SQL porque el filtro por fecha de entrega se resuelve en la base.
//
// Las cuatro constantes asumen los alias `p` (pedidos) y `dl` (el agregado de
// SQL_FECHAS_LINEAS): quien las reuse tiene que nombrar sus tablas igual.
// routes/export.js las importa para filtrar el Excel con exactamente esta
// regla, en lugar de volver a escribirla.
const SQL_ENTREGA_DESDE = 'COALESCE(dl.desde, p.fecha_entrega_desde)';
const SQL_ENTREGA_HASTA = 'COALESCE(dl.hasta, p.fecha_entrega_hasta)';
// Para el solapamiento: cuando de la ventana se conoce una sola punta (pasa en
// pedidos viejos cargados con fecha_entrega_desde y sin hasta) se la toma como
// un día suelto, en lugar de dejar el pedido afuera del filtro.
const SQL_ENTREGA_INICIO = `COALESCE(${SQL_ENTREGA_DESDE}, ${SQL_ENTREGA_HASTA})`;
const SQL_ENTREGA_FIN    = `COALESCE(${SQL_ENTREGA_HASTA}, ${SQL_ENTREGA_DESDE})`;

// Historial de pedidos con filtros (vista de pedidos para admin/operador).
// filtros: { cliente_id, fecha_desde, fecha_hasta, fecha_tipo, estado, estado_pago,
//            tipo_vianda, segmento, canal_origen } — todos opcionales.
// estado se aplica al estado del CLIENTE (no del pago).
// tipo_vianda acepta el sentinel 'sin_vianda' para filtrar pedidos sin vianda (tipo_vianda IS NULL).
// fecha_tipo decide sobre qué fecha pesan fecha_desde/fecha_hasta: 'entrega'
// (cuándo se entrega, que es lo que la ATC busca) o 'pedido' (cuándo se cargó).
// Default 'pedido', para no cambiarle el resultado a ningún llamador que no lo
// mande; la vista de pedidos manda 'entrega'.
async function listFiltered({
  cliente_id, fecha_desde, fecha_hasta, fecha_tipo, estado,
  estado_pago, tipo_vianda, segmento, canal_origen,
} = {}) {
  const where = [];
  const params = [];
  let idx = 1;

  // El JOIN con las fechas de las líneas se arma solo cuando se filtra por
  // entrega: en el resto de los casos sería un agregado de toda la tabla de
  // líneas que nadie mira.
  const porEntrega = fecha_tipo === 'entrega' && !!(fecha_desde || fecha_hasta);

  if (cliente_id)   { where.push(`p.cliente_id = $${idx++}`);    params.push(cliente_id); }
  if (porEntrega) {
    // Solapamiento de rangos: entrega_desde <= hasta AND entrega_hasta >= desde.
    // Con una sola de las dos fechas del filtro se aplica solo esa mitad.
    // Un pedido sin entrega conocida no solapa con nada y queda afuera: no hay
    // ninguna entrega suya que caiga en el rango pedido.
    if (fecha_hasta) { where.push(`${SQL_ENTREGA_INICIO} <= $${idx++}`); params.push(fecha_hasta); }
    if (fecha_desde) { where.push(`${SQL_ENTREGA_FIN} >= $${idx++}`);    params.push(fecha_desde); }
  } else {
    if (fecha_desde) { where.push(`p.fecha_pedido >= $${idx++}`); params.push(fecha_desde); }
    if (fecha_hasta) { where.push(`p.fecha_pedido <= $${idx++}`); params.push(fecha_hasta); }
  }
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
      p.id, p.fecha_pedido, p.monto, p.monto_pagado, p.descripcion, p.estado_pago, p.tipo_vianda, p.cancelado,
      p.origen, p.semana_lunes,
      -- Entrega de los pedidos sin líneas (los 765 anteriores a la fase 6):
      -- conCalculadosDeLineas las usa de fallback.
      p.fecha_entrega_desde, p.fecha_entrega_hasta,
      c.id AS cliente_id, c.nombre_completo, c.cedula, c.segmento, c.estado, c.canal_origen, c.empresa,
      c.tipo_envase
    FROM pedidos p
    JOIN clientes c ON c.id = p.cliente_id
    ${porEntrega ? `LEFT JOIN (${SQL_FECHAS_LINEAS}) dl ON dl.pedido_id = p.id` : ''}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.fecha_pedido DESC, p.id DESC
  `;
  const filas = (await pool.query(sql, params)).rows;
  return conCalculadosDeLineas(filas);
}

// Los dos campos del listado de pedidos que no están en la tabla pedidos y
// salen de sus líneas: el envase efectivo (fase 9) y la ventana de entrega
// (fase 11). Los dos se resuelven con la MISMA consulta agregada —una por
// página de resultados, no una por pedido—, que es lo que permite mostrar la
// columna "Entrega" sin un N+1.
async function conCalculadosDeLineas(filas) {
  if (!filas.length) return filas;

  const r = await pool.query(`
    SELECT
      pedido_id,
      bool_or(tipo_envase_override IS NULL) AS hay_sin_override,
      array_agg(DISTINCT tipo_envase_override)
        FILTER (WHERE tipo_envase_override IS NOT NULL) AS overrides,
      MIN(COALESCE(fecha_entrega, fecha_desde)) AS desde,
      MAX(COALESCE(fecha_entrega, fecha_hasta)) AS hasta
    FROM pedido_detalle
    WHERE pedido_id = ANY($1::int[]) AND cancelado = false
    GROUP BY pedido_id
  `, [filas.map(f => f.id)]);

  const porPedido = new Map(r.rows.map(row => [row.pedido_id, row]));

  return filas.map(fila => ({
    ...fila,
    tipo_envase_efectivo: envaseEfectivo(fila.tipo_envase, porPedido.get(fila.id)),
    ...entregaEfectiva(fila, porPedido.get(fila.id)),
  }));
}

// Envase que hay que mostrar en el listado de pedidos (fase 9). Es el del
// cliente, salvo que las líneas lo pisen con un override.
//
// Un pedido puede llevar los dos envases a la vez: alcanza con una línea con
// override Narma y otra sin override sobre un cliente Venezia. En ese caso el
// listado dice 'Mixto' y manda al detalle del pedido, que es donde se ve línea
// por línea. Un pedido sin líneas (los anteriores a la fase 6) se queda con el
// envase del cliente, que es el que aplicaría.
//
// lineas: { hay_sin_override, overrides } del pedido, o undefined si no tiene
// ninguna línea viva. Sin base de por medio, para poder verificar la regla sola.
function envaseEfectivo(envaseCliente, lineas) {
  const envases = new Set();
  if (lineas) {
    if (lineas.hay_sin_override) envases.add(envaseCliente);
    for (const e of lineas.overrides || []) envases.add(e);
  }
  if (!envases.size) return envaseCliente;
  if (envases.size === 1) return [...envases][0];
  return 'Mixto';
}

// Cuándo se entrega un pedido (fase 11). La entrega vive en las líneas desde
// la fase 6, pero 765 de los 775 pedidos son anteriores y la tienen solo en la
// cabecera, así que la regla es: si hay líneas vivas mandan ellas, si no manda
// la cabecera, y si no hay nada queda null.
//
// cabecera: la fila de pedidos (se leen fecha_entrega_desde / fecha_entrega_hasta).
// lineas: { desde, hasta } agregado de las líneas vivas, o undefined si no tiene
// ninguna. Sin base de por medio, igual que envaseEfectivo.
function entregaEfectiva(cabecera, lineas) {
  const desde = (lineas && lineas.desde) || cabecera.fecha_entrega_desde || null;
  const hasta = (lineas && lineas.hasta) || cabecera.fecha_entrega_hasta || null;
  return {
    entrega_desde: detalle.aISO(desde),
    entrega_hasta: detalle.aISO(hasta),
  };
}

// Las mismas dos puntas que calcula SQL_FECHAS_LINEAS, pero sobre líneas que ya
// están en memoria: lo usa getConDetalle, que acaba de leerlas, para no volver
// a la base por algo que ya tiene.
function fechasDeLineas(lineas = []) {
  let desde = null;
  let hasta = null;
  for (const l of lineas) {
    if (l.cancelado) continue;
    const d = detalle.aISO(l.fecha_entrega || l.fecha_desde);
    const h = detalle.aISO(l.fecha_entrega || l.fecha_hasta);
    if (d && (desde === null || d < desde)) desde = d;
    if (h && (hasta === null || h > hasta)) hasta = h;
  }
  return (desde || hasta) ? { desde, hasta } : undefined;
}

// Cantidad de pedidos de vianda (tipo_vianda IS NOT NULL) cuya fecha_pedido cae
// dentro del rango [fecha_desde, fecha_hasta].
// (ex countRecepcionadasEstaSemana — renombrada al dejar de estar atada a la semana corriente)
async function countRecepcionadas(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE tipo_vianda IS NOT NULL
      AND cancelado = false
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Cantidad de pedidos cuya ventana de entrega [fecha_entrega_desde, fecha_entrega_hasta]
// se solapa con el rango [fecha_desde, fecha_hasta]. Condición de solapamiento estándar:
// A.desde <= B.hasta AND A.hasta >= B.desde.
// (ex countEntregadasEstaSemana — renombrada al dejar de estar atada a la semana corriente)
async function countEntregadas(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE fecha_entrega_desde IS NOT NULL
      AND fecha_entrega_hasta IS NOT NULL
      AND cancelado = false
      AND fecha_entrega_desde <= $2
      AND fecha_entrega_hasta >= $1
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Cantidad de pedidos de cortesía (medio_pago = 'cortesia') cuya fecha_pedido
// cae dentro del rango [fecha_desde, fecha_hasta].
// (ex countCortesiaMes — renombrada al dejar de estar atada al mes corriente)
async function countCortesia(fecha_desde, fecha_hasta) {
  const r = await pool.query(`
    SELECT COUNT(*)::integer AS n FROM pedidos
    WHERE medio_pago = 'cortesia'
      AND cancelado = false
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
  `, [fecha_desde, fecha_hasta]);
  return r.rows[0].n;
}

// Cantidad de pedidos por semana (lunes ISO) y tipo_vianda, dentro del rango
// [fecha_desde, fecha_hasta]. Deja afuera modificacion_menu y pedidos sin
// vianda (tipo_vianda IS NULL). Devuelve una fila por semana con datos, con
// los 3 conteos por tipo (0 si esa semana no tuvo pedidos de ese tipo).
async function viandasPorTipoPorSemana(fecha_desde, fecha_hasta) {
  const rows = (await pool.query(`
    SELECT
      to_char(date_trunc('week', fecha_pedido), 'YYYY-MM-DD') AS semana,
      tipo_vianda,
      COUNT(*)::integer AS cantidad
    FROM pedidos
    WHERE tipo_vianda IN ('economico', 'saludable', 'low_carb')
      AND cancelado = false
      AND fecha_pedido >= $1 AND fecha_pedido <= $2
    GROUP BY date_trunc('week', fecha_pedido), tipo_vianda
  `, [fecha_desde, fecha_hasta])).rows;

  const porSemana = new Map();
  for (const r of rows) {
    if (!porSemana.has(r.semana)) {
      porSemana.set(r.semana, { semana: r.semana, economico: 0, saludable: 0, low_carb: 0 });
    }
    porSemana.get(r.semana)[r.tipo_vianda] = r.cantidad;
  }

  return [...porSemana.values()].sort((a, b) => a.semana.localeCompare(b.semana));
}

// Crea el pedido y, si vienen, sus líneas de detalle — todo en una transacción,
// para que no pueda quedar un pedido sin las líneas que la ATC cargó.
// tipo_vianda / descripcion siguen existiendo y no cambian: las líneas de
// pedido_detalle se suman a lo que ya había, no lo reemplazan (el dashboard
// histórico depende de tipo_vianda).
//
// recibido_por (id) y usuario (username) son la misma persona guardada dos
// veces a propósito: el id para poder hacer JOIN con usuarios y mostrar
// "Cargado por" en el detalle, y el username en pedidos_auditoria para que el
// historial siga siendo legible aunque después se renombre al usuario. La
// auditoría de la creación va DENTRO de la transacción: si no se puede
// registrar quién cargó el pedido, el pedido no se guarda (fase 8).
async function create({
  cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion,
  fecha_entrega_desde, fecha_entrega_hasta, detalle_modificacion, ubicacion_id, lineas = [],
  recibido_por = null, usuario,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO pedidos
         (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion,
          fecha_entrega_desde, fecha_entrega_hasta, detalle_modificacion, ubicacion_id, recibido_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        ubicacion_id || null,
        recibido_por || null,
      ]
    );
    const pedido = result.rows[0];

    if (lineas.length) await detalle.createMany(pedido.id, lineas, client);

    await auditar(pedido.id, 'creacion', usuario, {
      cliente_id,
      monto,
      cantidad_lineas: lineas.length,
    }, null, client);

    await client.query('COMMIT');
    return pedido;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pedido + cliente + ubicación elegida + líneas con sus excepciones.
// Es lo que consume la vista de edición del pedido y también el sync.
async function getConDetalle(id) {
  const r = await pool.query(`
    SELECT
      p.*,
      c.nombre_completo AS cliente_nombre,
      c.segmento        AS cliente_segmento,
      c.tipo_envase     AS cliente_tipo_envase,
      u.direccion       AS ubicacion_direccion,
      u.zona            AS ubicacion_zona,
      -- Quién cargó el pedido. LEFT JOIN porque recibido_por es NULL en los
      -- pedidos anteriores a la fase 8 y en los que arma sola la grilla.
      usr.username      AS recibido_por_username
    FROM pedidos p
    JOIN clientes c    ON c.id = p.cliente_id
    LEFT JOIN ubicaciones u ON u.id = p.ubicacion_id
    LEFT JOIN usuarios usr  ON usr.id = p.recibido_por
    WHERE p.id = $1
  `, [id]);
  const pedido = r.rows[0];
  if (!pedido) return null;

  const lineas = await detalle.listByPedido(id);
  const excepcionesPorLinea = await detalle.excepcionesPorLinea(id);
  pedido.lineas = lineas.map(l => ({
    ...l,
    excepciones: excepcionesPorLinea.get(l.id) || [],
  }));

  // entrega_desde / entrega_hasta con la misma regla que el listado, para que
  // el encabezado del detalle no muestre una entrega distinta de la columna
  // "Entrega" del mismo pedido.
  Object.assign(pedido, entregaEfectiva(pedido, fechasDeLineas(pedido.lineas)));

  return pedido;
}

module.exports = {
  listByCliente, getById, getConDetalle, create, listFiltered, updatePago,
  countRecepcionadas, countEntregadas, countCortesia, viandasPorTipoPorSemana,
  update, cancelar, listAuditoria, auditar,
  // exportadas para poder verificar las reglas del listado (qué envase y qué
  // ventana de entrega muestra un pedido) sin pedidos de prueba en la base
  envaseEfectivo, entregaEfectiva, fechasDeLineas,
  // los pedazos de SQL de la ventana de entrega, para que el export de Excel
  // filtre con la MISMA regla que el listado y no con una copia
  SQL_FECHAS_LINEAS, SQL_ENTREGA_INICIO, SQL_ENTREGA_FIN,
};
