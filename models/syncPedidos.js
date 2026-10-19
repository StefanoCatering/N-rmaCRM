// Sincronización CRM → Narma Pedidos (requisito 9).
//
// Cada vez que se crea, edita o cancela un pedido, una línea o una excepción,
// el CRM resuelve qué fechas concretas quedan afectadas y las espeja en la
// tabla pedidos_crm_detalle de la base de Pedidos.
//
// Tres reglas que gobiernan todo este módulo:
//
// 1. El sync NUNCA hace fallar el guardado en el CRM (requisito 9.c). Toda la
//    función está envuelta en try/catch y el error se registra en la tabla
//    local sync_errores con el payload completo, para poder reenviarlo.
//
// 2. Nunca se borra nada del lado de Pedidos (requisito 9.d): las filas que
//    dejan de corresponder se marcan cancelado = true con un UPDATE.
//
// 3. Se sincroniza el pedido COMPLETO en cada cambio, no solo lo que se tocó.
//    Es más tráfico, pero es auto-reparador: si un sync anterior falló o quedó
//    a medias, el siguiente deja Pedidos consistente igual.
//
// ── Contrato con la tabla destino ────────────────────────────────
// pedidos_crm_detalle NO la migra este repo: vive en el proyecto narma-pedidos
// (ref rgppcvqoephcjjcnqwnz) y su DDL lo gestiona ese repo (creada en su PR #35).
// Desde acá solo se la escribe. Si cambia allá, hay que acompañar el cambio acá.
//
// Forma que este módulo asume (verificada contra producción el 2026-10-13):
//   id                    serial PK
//   crm_pedido_id         integer  NOT NULL
//   crm_pedido_detalle_id integer  NOT NULL
//   crm_excepcion_id      integer  NULL
//   cliente_nombre        text     NOT NULL
//   segmento              text     NOT NULL
//   tipo_envase           text     NOT NULL  CHECK ('Narma','Venezia')
//   plato_nombre          text     NOT NULL
//   cantidad              integer  NOT NULL  CHECK (cantidad > 0)
//   fecha_entrega         date     NOT NULL
//   ubicacion_direccion   text     NULL
//   comentario            text     NULL
//   cancelado             boolean  NOT NULL DEFAULT false
//   actualizado_en        timestamptz NOT NULL DEFAULT now()
//   UNIQUE (crm_pedido_detalle_id, fecha_entrega)  ← clave del upsert
//
// Las 5 columnas NOT NULL de arriba quedan siempre cubiertas desde el CRM:
// nombre_completo y segmento son NOT NULL en clientes; tipo_envase es NOT NULL
// DEFAULT 'Venezia' y su CHECK usa los mismos dos valores; cantidad sale de
// pedido_detalle.cantidad (CHECK > 0) o de una excepción (CHECK > 0), y
// resolverEntregas() solo toma la de la excepción cuando no es NULL; y
// plato_nombre se resuelve por FK a platos, así que la búsqueda no falla.
// Si alguna vez llegara un NULL, Postgres rechaza la fila y el intento cae en
// sync_errores para que lo mire una persona — es el modo de falla correcto:
// mejor eso que mandar a producción una fila a medias.

const pool = require('./db');
const { pool: pedidosPool, habilitado } = require('./dbPedidos');
const detalle = require('./pedidoDetalle');
const entregas = require('./entregas');
const platos = require('./platos');

// Filas por statement en el upsert multi-fila. 12 columnas × 500 = 6000
// parámetros, muy por debajo del límite de 65535 de Postgres.
const FILAS_POR_LOTE = 500;

// ── Lectura del lado CRM ─────────────────────────────────────────
// Query propia (en lugar de reusar pedidos.getConDetalle) por dos razones:
// trae exactamente los campos denormalizados que necesita Pedidos, y evita un
// require circular entre models/pedidos.js y este módulo.
async function leerPedido(pedidoId) {
  const r = await pool.query(`
    SELECT
      p.id                AS pedido_id,
      p.cancelado         AS pedido_cancelado,
      c.nombre_completo   AS cliente_nombre,
      c.segmento          AS segmento,
      c.tipo_envase       AS cliente_tipo_envase,
      u.direccion         AS ubicacion_direccion
    FROM pedidos p
    JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN ubicaciones u ON u.id = p.ubicacion_id
    WHERE p.id = $1
  `, [pedidoId]);
  return r.rows[0] || null;
}

// ── Resolución ───────────────────────────────────────────────────
// Convierte el pedido del CRM en las filas que van a pedidos_crm_detalle.
// Devuelve { filas, lineasCanceladas }:
//   filas             → entregas vigentes, para upsertear con cancelado = false
//   lineasCanceladas  → ids de líneas cuyas filas hay que marcar canceladas
//
// La resolución en sí (expansión de recurrentes con sus excepciones, envase
// efectivo, etiqueta del plato) vive en models/entregas.js, compartida con el
// Resumen del día: lo que muestra el resumen tiene que ser exactamente lo que
// se le manda a cocina desde acá.
async function resolverFilas(pedidoId) {
  const pedido = await leerPedido(pedidoId);
  if (!pedido) return null;

  const lineas = await detalle.listByPedido(pedidoId);

  // Si el pedido está cancelado, TODAS sus líneas se cancelan del lado de
  // Pedidos, sin importar el estado individual de cada línea. (El resumen no
  // necesita este caso: descarta los pedidos cancelados en la consulta.)
  if (pedido.pedido_cancelado) {
    return { pedido, filas: [], lineasCanceladas: lineas.map(l => l.id) };
  }

  const excepcionesPorLinea = await detalle.excepcionesPorLinea(pedidoId);

  // Nombres de plato de todos los platos involucrados, incluidos los que
  // entran por una excepción. Una sola consulta para todo el pedido.
  const nombres = await platos.nombresPorId(entregas.idsDePlatos(lineas, excepcionesPorLinea));

  const { filas, lineasCanceladas } = entregas.expandir({
    lineas,
    // La clave es pedido_id tal como lo devuelve la base, para que coincida
    // con linea.pedido_id sin depender del tipo que llegó por parámetro.
    pedidosPorId: new Map([[pedido.pedido_id, pedido]]),
    excepcionesPorLinea,
    nombres,
  });

  return { pedido, filas, lineasCanceladas };
}

// ── Escritura del lado Pedidos ───────────────────────────────────

const COLUMNAS = [
  'crm_pedido_id', 'crm_pedido_detalle_id', 'crm_excepcion_id', 'cliente_nombre',
  'segmento', 'tipo_envase', 'plato_nombre', 'cantidad', 'fecha_entrega',
  'ubicacion_direccion', 'comentario',
];

// Upsert multi-fila (requisito 9.f): una línea recurrente de 3 meses entra en
// UN statement, no en 60 INSERT sueltos.
async function upsertLote(cliente, filas) {
  const tuplas = [];
  const params = [];
  filas.forEach((fila, i) => {
    const base = i * COLUMNAS.length;
    tuplas.push(`(${COLUMNAS.map((_, j) => `$${base + j + 1}`).join(',')}, false, NOW())`);
    params.push(...COLUMNAS.map(c => fila[c]));
  });

  await cliente.query(`
    INSERT INTO pedidos_crm_detalle (${COLUMNAS.join(', ')}, cancelado, actualizado_en)
    VALUES ${tuplas.join(', ')}
    ON CONFLICT (crm_pedido_detalle_id, fecha_entrega) DO UPDATE SET
      crm_pedido_id       = EXCLUDED.crm_pedido_id,
      crm_excepcion_id    = EXCLUDED.crm_excepcion_id,
      cliente_nombre      = EXCLUDED.cliente_nombre,
      segmento            = EXCLUDED.segmento,
      tipo_envase         = EXCLUDED.tipo_envase,
      plato_nombre        = EXCLUDED.plato_nombre,
      cantidad            = EXCLUDED.cantidad,
      ubicacion_direccion = EXCLUDED.ubicacion_direccion,
      comentario          = EXCLUDED.comentario,
      cancelado           = false,
      actualizado_en      = NOW()
  `, params);
}

// ── Bitácora de errores ──────────────────────────────────────────
// Una fila por intento fallido, a nivel pedido: el sync siempre es del pedido
// completo, así que pedido_detalle_id y fecha quedan en NULL y el payload
// guarda todo lo que había que escribir. Es lo que hace reenviable el intento.
// Escribe en la base del CRM, que es justamente la que sí está disponible.
async function registrarError(pedidoId, payload, err) {
  try {
    await pool.query(`
      INSERT INTO sync_errores (pedido_id, pedido_detalle_id, fecha, payload, error)
      VALUES ($1, NULL, NULL, $2, $3)
    `, [pedidoId, JSON.stringify(payload), String(err && err.message ? err.message : err).slice(0, 2000)]);
  } catch (errLog) {
    // Si ni el log local se puede escribir, no queda más que la consola.
    console.error('[sync] No se pudo registrar el error en sync_errores:', errLog.message);
  }
}

// ── Punto de entrada ─────────────────────────────────────────────
// Sincroniza un pedido completo. Nunca lanza: devuelve un resumen de lo que
// hizo, o { ok: false } si falló (y en ese caso ya quedó en sync_errores).
async function sincronizarPedido(pedidoId) {
  let resuelto = null;

  try {
    resuelto = await resolverFilas(pedidoId);
    if (!resuelto) return { ok: false, motivo: 'pedido_inexistente' };

    if (!habilitado()) {
      // Sin conexión configurada no se puede escribir, pero el intento queda
      // registrado para reenviarlo cuando se configure la variable.
      await registrarError(pedidoId, resuelto, new Error('PEDIDOS_DATABASE_URL no configurada'));
      return { ok: false, motivo: 'sync_deshabilitado' };
    }

    const { filas, lineasCanceladas } = resuelto;
    const cliente = await pedidosPool.connect();
    try {
      await cliente.query('BEGIN');

      // 1. Upsert de las entregas vigentes, en lotes.
      for (let i = 0; i < filas.length; i += FILAS_POR_LOTE) {
        await upsertLote(cliente, filas.slice(i, i + FILAS_POR_LOTE));
      }

      // 2. Cancelar las filas de las líneas canceladas (o de todo el pedido
      //    si el pedido está cancelado). UPDATE, nunca DELETE.
      if (lineasCanceladas.length) {
        await cliente.query(`
          UPDATE pedidos_crm_detalle
          SET cancelado = true, actualizado_en = NOW()
          WHERE crm_pedido_detalle_id = ANY($1::int[]) AND cancelado = false
        `, [lineasCanceladas]);
      }

      // 3. Cancelar las filas que ya no corresponden a ninguna entrega vigente:
      //    pasa cuando se acorta el rango de una línea recurrente o cuando se
      //    agrega una excepción con omitir = true sobre una fecha ya
      //    sincronizada. Sin este paso quedarían vivas en producción filas de
      //    días que el CRM ya no pide.
      const fechasPorLinea = new Map();
      for (const f of filas) {
        if (!fechasPorLinea.has(f.crm_pedido_detalle_id)) fechasPorLinea.set(f.crm_pedido_detalle_id, []);
        fechasPorLinea.get(f.crm_pedido_detalle_id).push(f.fecha_entrega);
      }
      for (const [lineaId, fechas] of fechasPorLinea) {
        await cliente.query(`
          UPDATE pedidos_crm_detalle
          SET cancelado = true, actualizado_en = NOW()
          WHERE crm_pedido_detalle_id = $1
            AND fecha_entrega <> ALL($2::date[])
            AND cancelado = false
        `, [lineaId, fechas]);
      }

      await cliente.query('COMMIT');
      return {
        ok: true,
        entregas: filas.length,
        lineas_canceladas: lineasCanceladas.length,
      };
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }
  } catch (err) {
    console.error(`[sync] Falló la sincronización del pedido ${pedidoId}:`, err.message);
    await registrarError(pedidoId, resuelto, err);
    return { ok: false, motivo: 'error', error: err.message };
  }
}

// Envoltorio para usar desde las rutas: sincroniza y nunca propaga el error,
// así una caída de Pedidos no cambia la respuesta que recibe la ATC.
// Se hace con await (y no fire-and-forget) a propósito: en Vercel la función
// serverless puede congelarse en cuanto se responde el request, y un sync
// lanzado sin esperar se perdería sin dejar rastro.
async function sincronizarSinFallar(pedidoId) {
  try {
    return await sincronizarPedido(pedidoId);
  } catch (err) {
    console.error('[sync] Error no manejado al sincronizar:', err.message);
    return { ok: false, motivo: 'error', error: err.message };
  }
}

// Intentos fallidos pendientes, para la vista de diagnóstico / reenvío.
async function listarErrores(limite = 100) {
  const r = await pool.query(
    'SELECT * FROM sync_errores ORDER BY creado_en DESC LIMIT $1',
    [limite]
  );
  return r.rows;
}

module.exports = {
  sincronizarPedido, sincronizarSinFallar, resolverFilas, listarErrores,
  // exportado para poder verificar el armado del statement multi-fila
  upsertLote, COLUMNAS,
};
