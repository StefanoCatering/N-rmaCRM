const express = require('express');
const clientes = require('../models/clientes');
const pedidos = require('../models/pedidos');
const detalle = require('../models/pedidoDetalle');
const platos = require('../models/platos');
const ubicaciones = require('../models/ubicaciones');
const syncPedidos = require('../models/syncPedidos');

const router = express.Router();

const MEDIOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'pos', 'cortesia'];
const ESTADOS_PAGO = ['pagado', 'pendiente', 'parcial'];
const TIPOS_VIANDA = ['economico', 'saludable', 'low_carb', 'modificacion_menu'];
const ESTADOS_CLIENTE = ['activo', 'pausado', 'inactivo', 'baja'];
const SEGMENTOS = ['particular', 'empresa', 'embajador'];
const CANALES = ['whatsapp', 'redes', 'embajador', 'boca_a_boca', 'b2b', 'otro'];
const TIPOS_VIANDA_FILTRO = [...TIPOS_VIANDA, 'sin_vianda']; // filtro de listado acepta también "sin vianda"

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODOS = ['puntual', 'recurrente'];
const TIPOS_ENVASE = ['Narma', 'Venezia'];
const MAX_LINEAS = 50; // techo por request, para que un body raro no cargue cientos de líneas

function requireEscritura(req, res, next) {
  if (req.user.rol === 'visor') return res.status(403).json({ error: 'Acceso de solo lectura' });
  next();
}

// ── Pedidos de la grilla de comedor (fase 7) ──────────────────────
// Un pedido con origen = 'grilla' es el pedido semanal que arma sola la grilla
// de comedor: sus líneas son el total calculado por (plato, fecha) y se
// reescriben enteras en cada envío. Editarlo desde acá no serviría de nada —
// el siguiente envío lo pisaría — así que se rechaza de entrada, en vez de
// dejar que alguien haga un cambio que va a desaparecer sin aviso.
const MSG_PEDIDO_GRILLA = 'Este pedido se gestiona desde la grilla semanal';

function esDeGrilla(pedido) {
  return pedido && pedido.origen === 'grilla';
}

// Queda para lo que sigue siendo exclusivo del admin: hoy, la bitácora de
// syncs fallidos. Editar y cancelar pedidos ya no pasa por acá — lo hace
// cualquiera que no sea visor, con motivo obligatorio y auditoría.
function requireAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  next();
}

// ── Líneas de pedido (pedido_detalle) ─────────────────────────────

// Valida un array de líneas crudas del body. Devuelve las líneas normalizadas
// y la lista de errores, con el número de línea para que la ATC sepa cuál falló.
// platosActivos: Set de ids válidos, resuelto en una sola consulta por request.
function validarLineas(rawLineas, platosActivos) {
  const errores = [];
  const lineas = [];

  rawLineas.forEach((raw, i) => {
    const n = i + 1;
    const l = {};

    const plato_id = Number(raw.plato_id);
    if (!Number.isInteger(plato_id) || !platosActivos.has(plato_id)) {
      errores.push(`Línea ${n}: el plato es inválido o está inactivo`);
    } else l.plato_id = plato_id;

    const cantidad = Number(raw.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      errores.push(`Línea ${n}: la cantidad debe ser un número entero mayor a 0`);
    } else l.cantidad = cantidad;

    const modo = String(raw.modo || '').trim();
    if (!MODOS.includes(modo)) {
      errores.push(`Línea ${n}: el modo debe ser "puntual" o "recurrente"`);
    } else l.modo = modo;

    l.comentario = raw.comentario ? String(raw.comentario).trim().slice(0, 500) : null;

    const override = raw.tipo_envase_override ? String(raw.tipo_envase_override).trim() : null;
    if (override && !TIPOS_ENVASE.includes(override)) {
      errores.push(`Línea ${n}: tipo de envase inválido`);
    } else {
      l.tipo_envase_override = override;
    }

    // Las fechas tienen que coincidir con el modo: lo mismo que exige el
    // CHECK pedido_detalle_fechas_check, validado acá para devolver un
    // mensaje entendible en lugar de un error 500 de Postgres.
    l.fecha_entrega = null;
    l.fecha_desde = null;
    l.fecha_hasta = null;

    if (modo === 'puntual') {
      const f = String(raw.fecha_entrega || '').trim();
      if (!FECHA_RE.test(f)) {
        errores.push(`Línea ${n}: la fecha de entrega es requerida en una línea puntual (formato YYYY-MM-DD)`);
      } else l.fecha_entrega = f;
    } else if (modo === 'recurrente') {
      const desde = String(raw.fecha_desde || '').trim();
      const hasta = String(raw.fecha_hasta || '').trim();
      if (!FECHA_RE.test(desde) || !FECHA_RE.test(hasta)) {
        errores.push(`Línea ${n}: fecha desde y fecha hasta son requeridas en una línea recurrente (formato YYYY-MM-DD)`);
      } else if (hasta < desde) {
        errores.push(`Línea ${n}: la fecha hasta no puede ser anterior a la fecha desde`);
      } else if (detalle.diasEnRango(desde, hasta) > detalle.MAX_DIAS_RANGO) {
        errores.push(`Línea ${n}: el rango no puede superar ${detalle.MAX_DIAS_RANGO} días`);
      } else if (!detalle.expandirHabiles(desde, hasta).length) {
        // Un rango de sábado a domingo no produciría ninguna entrega: mejor
        // avisarlo que guardar una línea que no genera nada.
        errores.push(`Línea ${n}: el rango no incluye ningún día hábil (las líneas recurrentes se entregan de lunes a viernes)`);
      } else {
        l.fecha_desde = desde;
        l.fecha_hasta = hasta;
      }
    }

    lineas.push(l);
  });

  return { lineas, errores };
}

// Parsea y valida body.lineas. Devuelve { lineas, errores }.
async function parsearLineas(body) {
  const raw = Array.isArray(body.lineas) ? body.lineas : [];
  if (!raw.length) return { lineas: [], errores: [] };
  if (raw.length > MAX_LINEAS) {
    return { lineas: [], errores: [`No se pueden cargar más de ${MAX_LINEAS} líneas por vez`] };
  }

  const ids = raw.map(l => Number(l.plato_id)).filter(Number.isInteger);
  const platosActivos = await platos.idsActivos([...new Set(ids)]);
  return validarLineas(raw, platosActivos);
}

// Carga una línea verificando que pertenezca al pedido indicado, para que
// /api/pedidos/7/lineas/99 no pueda tocar una línea del pedido 3.
async function cargarLinea(pedidoId, lineaId) {
  if (!lineaId) return null;
  const linea = await detalle.getById(lineaId);
  if (!linea || linea.pedido_id !== pedidoId) return null;
  return linea;
}

// GET /api/pedidos — historial de pedidos con filtros (admin y operador)
router.get('/', async (req, res, next) => {
  try {
    const {
      cliente_id, fecha_desde, fecha_hasta, estado,
      estado_pago, tipo_vianda, segmento, canal_origen,
    } = req.query;
    const filtros = {};
    if (cliente_id && Number(cliente_id)) filtros.cliente_id = Number(cliente_id);
    if (fecha_desde && /^\d{4}-\d{2}-\d{2}$/.test(fecha_desde)) filtros.fecha_desde = fecha_desde;
    if (fecha_hasta && /^\d{4}-\d{2}-\d{2}$/.test(fecha_hasta)) filtros.fecha_hasta = fecha_hasta;
    if (estado && ESTADOS_CLIENTE.includes(estado)) filtros.estado = estado;
    if (estado_pago && ESTADOS_PAGO.includes(estado_pago)) filtros.estado_pago = estado_pago;
    if (tipo_vianda && TIPOS_VIANDA_FILTRO.includes(tipo_vianda)) filtros.tipo_vianda = tipo_vianda;
    if (segmento && SEGMENTOS.includes(segmento)) filtros.segmento = segmento;
    if (canal_origen && CANALES.includes(canal_origen)) filtros.canal_origen = canal_origen;
    res.json({ pedidos: await pedidos.listFiltered(filtros) });
  } catch (err) { next(err); }
});

// POST /api/pedidos — registrar nuevo pedido (admin y operador; visor no puede)
router.post('/', requireEscritura, async (req, res, next) => {
  try {
    const body = req.body || {};
    const errores = [];

    const cliente_id = Number(body.cliente_id);
    const clienteObj = cliente_id ? await clientes.getById(cliente_id) : null;
    if (!cliente_id || !clienteObj) errores.push('Cliente inválido');

    const fecha_pedido = String(body.fecha_pedido || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_pedido)) errores.push('Fecha de pedido inválida (formato YYYY-MM-DD)');

    const monto = Number(body.monto);
    if (!Number.isInteger(monto) || monto <= 0) errores.push('El monto debe ser un número entero positivo (en guaraníes)');

    let monto_pagado = null;
    if (body.monto_pagado !== undefined && body.monto_pagado !== null && body.monto_pagado !== '') {
      monto_pagado = Number(body.monto_pagado);
      if (!Number.isInteger(monto_pagado) || monto_pagado < 0) errores.push('El monto pagado debe ser un número entero positivo o cero');
    }

    const estado_pago = body.estado_pago ? String(body.estado_pago).trim() : 'pendiente';
    if (!ESTADOS_PAGO.includes(estado_pago)) errores.push('Estado de pago inválido');
    if (estado_pago === 'parcial' && monto_pagado === null) {
      errores.push('El monto abonado es requerido para pago parcial');
    }

    const medio_pago = body.medio_pago ? String(body.medio_pago).trim() : null;
    if (medio_pago && !MEDIOS_PAGO.includes(medio_pago)) errores.push('Medio de pago inválido');
    if (medio_pago === 'cortesia' && clienteObj && clienteObj.segmento !== 'embajador') {
      errores.push('El medio de pago "Cortesía" solo puede usarse con clientes del segmento Embajador');
    }

    const tipo_vianda = body.tipo_vianda ? String(body.tipo_vianda).trim() : null;
    if (tipo_vianda && !TIPOS_VIANDA.includes(tipo_vianda)) errores.push('Tipo de vianda inválido');

    const detalle_modificacion = body.detalle_modificacion ? String(body.detalle_modificacion).trim() : null;
    if (tipo_vianda === 'modificacion_menu' && !detalle_modificacion) {
      errores.push('El detalle de la modificación es requerido cuando el tipo de vianda es "Modificación de menú"');
    }

    const fecha_entrega_desde = body.fecha_entrega_desde ? String(body.fecha_entrega_desde).trim() : null;
    if (fecha_entrega_desde && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_entrega_desde)) errores.push('Fecha de entrega desde inválida (formato YYYY-MM-DD)');
    const fecha_entrega_hasta = body.fecha_entrega_hasta ? String(body.fecha_entrega_hasta).trim() : null;
    if (fecha_entrega_hasta && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_entrega_hasta)) errores.push('Fecha de entrega hasta inválida (formato YYYY-MM-DD)');

    // Ubicación de entrega: tiene que ser una de las ubicaciones guardadas
    // del cliente del pedido.
    let ubicacion_id = null;
    if (body.ubicacion_id !== undefined && body.ubicacion_id !== null && body.ubicacion_id !== '') {
      ubicacion_id = Number(body.ubicacion_id);
      if (!Number.isInteger(ubicacion_id) || ubicacion_id <= 0) {
        errores.push('Ubicación inválida');
        ubicacion_id = null;
      } else if (clienteObj && !(await ubicaciones.belongsToCliente(ubicacion_id, cliente_id))) {
        errores.push('La ubicación elegida no pertenece a este cliente');
        ubicacion_id = null;
      }
    }

    // Líneas de pedido (plato + cantidad + comentario + modo + fechas).
    const { lineas, errores: erroresLineas } = await parsearLineas(body);
    errores.push(...erroresLineas);

    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    // Normalizar monto_pagado según estado de pago:
    // pagado → siempre el monto completo; pendiente → siempre null;
    // parcial → el monto abonado ingresado (ya validado arriba que no sea null).
    if (estado_pago === 'pagado') monto_pagado = monto;
    else if (estado_pago === 'pendiente') monto_pagado = null;

    const pedido = await pedidos.create({
      cliente_id,
      fecha_pedido,
      monto,
      monto_pagado,
      estado_pago,
      medio_pago,
      tipo_vianda,
      descripcion: body.descripcion ? String(body.descripcion).trim() : null,
      fecha_entrega_desde,
      fecha_entrega_hasta,
      detalle_modificacion,
      ubicacion_id,
      lineas,
      // Quién lo cargó: el id queda en pedidos.recibido_por y el username en
      // la fila 'creacion' de pedidos_auditoria, las dos en la misma
      // transacción que el pedido (fase 8).
      recibido_por: req.user.id,
      usuario: req.user.username,
    });

    // El pedido ya está guardado. Si el espejado hacia Narma Pedidos falla,
    // queda registrado en sync_errores y la respuesta lo informa, pero el
    // pedido NO se deshace (requisito 9.c).
    const sync = await syncPedidos.sincronizarSinFallar(pedido.id);
    res.status(201).json({ pedido, sync });
  } catch (err) { next(err); }
});

// GET /api/pedidos/:id — pedido con sus líneas y las excepciones de cada línea
// (cualquier usuario autenticado). Es lo que carga la vista de edición.
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pedido = id ? await pedidos.getConDetalle(id) : null;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ pedido });
  } catch (err) { next(err); }
});

// PATCH /api/pedidos/:id/pago — modificar estado de pago de un pedido (admin y operador)
router.patch('/:id/pago', requireEscritura, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pedido = id ? await pedidos.getById(id) : null;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    // La facturación del comedor no es parte de la fase 7: el pedido semanal
    // nace con monto 0 y estado 'pendiente', y marcarlo pagado sería registrar
    // un cobro de Gs. 0 que no existe.
    if (esDeGrilla(pedido)) return res.status(400).json({ error: MSG_PEDIDO_GRILLA });

    const body = req.body || {};
    const estado_pago = body.estado_pago ? String(body.estado_pago).trim() : '';
    if (!ESTADOS_PAGO.includes(estado_pago)) {
      return res.status(400).json({ error: 'Estado de pago inválido' });
    }

    // Resolver monto_pagado según el estado:
    // pagado → monto completo del pedido; pendiente → null; parcial → monto del body (entero > 0).
    let monto_pagado;
    if (estado_pago === 'pagado') {
      monto_pagado = pedido.monto;
    } else if (estado_pago === 'pendiente') {
      monto_pagado = null;
    } else { // parcial
      const mp = Number(body.monto_pagado);
      if (!Number.isInteger(mp) || mp <= 0) {
        return res.status(400).json({ error: 'El monto abonado es requerido y debe ser un número entero mayor a 0' });
      }
      monto_pagado = mp;
    }

    // updatePago hace el UPDATE y la fila 'pago' de pedidos_auditoria en una
    // sola transacción: un cambio de estado de pago no puede quedar sin
    // constancia de quién lo hizo (fase 8). Va sin motivo — el estado de pago
    // lo cambia la ATC en el día a día y no es una edición que haya que
    // justificar por escrito, a diferencia de PATCH /:id.
    const actualizado = await pedidos.updatePago(
      id, pedido, estado_pago, monto_pagado, req.user.username
    );
    res.json({ pedido: actualizado });
  } catch (err) { next(err); }
});

// PATCH /api/pedidos/:id — editar campos clave de un pedido (admin y operador; visor no puede).
// El motivo sigue siendo obligatorio y la edición sigue quedando en pedidos_auditoria:
// lo que cambió es quién puede hacerla, no que haya que justificarla.
router.patch('/:id', requireEscritura, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pedido = id ? await pedidos.getById(id) : null;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    if (esDeGrilla(pedido)) return res.status(400).json({ error: MSG_PEDIDO_GRILLA });
    if (pedido.cancelado) return res.status(400).json({ error: 'No se puede editar un pedido cancelado' });

    const body = req.body || {};
    const motivo = String(body.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'El motivo es requerido' });

    const CAMPOS_EDITABLES = ['monto', 'fecha_pedido', 'tipo_vianda', 'ubicacion_id'];
    const provistos = CAMPOS_EDITABLES.filter(campo => body[campo] !== undefined);
    if (!provistos.length) {
      return res.status(400).json({ error: 'Debe indicar al menos un campo a modificar (monto, fecha_pedido, tipo_vianda o ubicacion_id)' });
    }

    const cambios = {};
    const errores = [];

    if (provistos.includes('monto')) {
      const monto = Number(body.monto);
      if (!Number.isInteger(monto) || monto <= 0) errores.push('El monto debe ser un número entero positivo (en guaraníes)');
      else cambios.monto = monto;
    }
    if (provistos.includes('fecha_pedido')) {
      const fecha_pedido = String(body.fecha_pedido || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_pedido)) errores.push('Fecha de pedido inválida (formato YYYY-MM-DD)');
      else cambios.fecha_pedido = fecha_pedido;
    }
    if (provistos.includes('tipo_vianda')) {
      const tipo_vianda = String(body.tipo_vianda || '').trim();
      if (!TIPOS_VIANDA.includes(tipo_vianda)) errores.push('Tipo de vianda inválido');
      else cambios.tipo_vianda = tipo_vianda;
    }
    if (provistos.includes('ubicacion_id')) {
      // null explícito = quitar la ubicación del pedido
      if (body.ubicacion_id === null || body.ubicacion_id === '') {
        cambios.ubicacion_id = null;
      } else {
        const ubicacion_id = Number(body.ubicacion_id);
        if (!Number.isInteger(ubicacion_id) || ubicacion_id <= 0) {
          errores.push('Ubicación inválida');
        } else if (!(await ubicaciones.belongsToCliente(ubicacion_id, pedido.cliente_id))) {
          errores.push('La ubicación elegida no pertenece a este cliente');
        } else {
          cambios.ubicacion_id = ubicacion_id;
        }
      }
    }

    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    const actualizado = await pedidos.update(id, pedido, cambios, req.user.username, motivo);
    // ubicacion_id cambia la dirección que ve producción, así que se re-espeja.
    const sync = await syncPedidos.sincronizarSinFallar(id);
    res.json({ pedido: actualizado, sync });
  } catch (err) { next(err); }
});

// PATCH /api/pedidos/:id/cancelar — cancelar un pedido (admin y operador; visor no puede),
// con motivo obligatorio.
router.patch('/:id/cancelar', requireEscritura, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pedido = id ? await pedidos.getById(id) : null;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    if (esDeGrilla(pedido)) return res.status(400).json({ error: MSG_PEDIDO_GRILLA });
    if (pedido.cancelado) return res.status(400).json({ error: 'Este pedido ya está cancelado' });

    const motivo = String((req.body || {}).motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'El motivo es requerido' });

    const actualizado = await pedidos.cancelar(id, req.user.username, motivo);
    // Marca cancelado = true en todas las filas del pedido en Narma Pedidos
    // (UPDATE, no DELETE — requisito 9.d).
    const sync = await syncPedidos.sincronizarSinFallar(id);
    res.json({ pedido: actualizado, sync });
  } catch (err) { next(err); }
});

// GET /api/pedidos/:id/auditoria — historial de ediciones/cancelaciones (cualquier usuario autenticado)
router.get('/:id/auditoria', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id de pedido inválido' });
    res.json({ auditoria: await pedidos.listAuditoria(id) });
  } catch (err) { next(err); }
});

// ── Líneas de pedido ──────────────────────────────────────────────
// Agregar, editar y cancelar líneas son ediciones del pedido: van por el mismo
// patrón de auditoría obligatoria que PATCH /:id y PATCH /:id/cancelar
// (admin y operador + motivo requerido + registro en pedidos_auditoria).

// Resuelve el pedido de la ruta y corta con el status correcto si no se puede
// editar. Devuelve { pedido, motivo } o null si ya respondió.
async function contextoEdicion(req, res, { exigirMotivo = true } = {}) {
  const id = Number(req.params.id);
  const pedido = id ? await pedidos.getById(id) : null;
  if (!pedido) {
    res.status(404).json({ error: 'Pedido no encontrado' });
    return null;
  }
  // Cubre de una sola vez las rutas de líneas y de excepciones: todas pasan
  // por acá antes de tocar nada.
  if (esDeGrilla(pedido)) {
    res.status(400).json({ error: MSG_PEDIDO_GRILLA });
    return null;
  }
  if (pedido.cancelado) {
    res.status(400).json({ error: 'No se puede editar un pedido cancelado' });
    return null;
  }
  // En DELETE el motivo puede venir por query: hay clientes HTTP que descartan
  // el body de un DELETE.
  const motivo = String((req.body || {}).motivo || req.query.motivo || '').trim();
  if (exigirMotivo && !motivo) {
    res.status(400).json({ error: 'El motivo es requerido' });
    return null;
  }
  return { pedido, motivo };
}

// POST /api/pedidos/:id/lineas — agregar una o más líneas a un pedido existente
router.post('/:id/lineas', requireEscritura, async (req, res, next) => {
  try {
    const ctx = await contextoEdicion(req, res);
    if (!ctx) return;
    const { pedido, motivo } = ctx;

    const { lineas, errores } = await parsearLineas(req.body || {});
    if (errores.length) return res.status(400).json({ error: errores.join('. ') });
    if (!lineas.length) return res.status(400).json({ error: 'Debe enviar al menos una línea' });

    const creadas = await detalle.createMany(pedido.id, lineas);
    await pedidos.auditar(pedido.id, 'edicion', req.user.username, {
      lineas_agregadas: creadas.map(l => ({
        id: l.id, plato_id: l.plato_id, cantidad: l.cantidad, modo: l.modo,
        fecha_entrega: l.fecha_entrega, fecha_desde: l.fecha_desde, fecha_hasta: l.fecha_hasta,
      })),
    }, motivo);

    const sync = await syncPedidos.sincronizarSinFallar(pedido.id);
    res.status(201).json({ pedido: await pedidos.getConDetalle(pedido.id), sync });
  } catch (err) { next(err); }
});

// PATCH /api/pedidos/:id/lineas/:lineaId — editar una línea.
// Espera la definición COMPLETA de la línea (plato_id, cantidad, modo y las
// fechas del modo), no un parche parcial: así la combinación modo/fechas se
// valida como un todo y nunca se arma un UPDATE que viole el CHECK de la tabla.
router.patch('/:id/lineas/:lineaId', requireEscritura, async (req, res, next) => {
  try {
    const ctx = await contextoEdicion(req, res);
    if (!ctx) return;
    const { pedido, motivo } = ctx;

    const linea = await cargarLinea(pedido.id, Number(req.params.lineaId));
    if (!linea) return res.status(404).json({ error: 'Línea no encontrada' });
    if (linea.cancelado) return res.status(400).json({ error: 'No se puede editar una línea cancelada' });

    const { lineas, errores } = await parsearLineas({ lineas: [req.body || {}] });
    if (errores.length) return res.status(400).json({ error: errores.join('. ') });
    const nueva = lineas[0];

    // Solo se escriben (y se auditan) los campos que realmente cambiaron.
    const CAMPOS_LINEA_EDITABLES = [
      'plato_id', 'cantidad', 'comentario', 'modo',
      'fecha_entrega', 'fecha_desde', 'fecha_hasta', 'tipo_envase_override',
    ];
    const cambios = {};
    const detalleAuditoria = {};
    for (const campo of CAMPOS_LINEA_EDITABLES) {
      const anterior = campo.startsWith('fecha') ? detalle.aISO(linea[campo]) : linea[campo];
      const nuevo = nueva[campo] === undefined ? null : nueva[campo];
      if (anterior !== nuevo) {
        cambios[campo] = nuevo;
        detalleAuditoria[campo] = { anterior, nuevo };
      }
    }

    if (!Object.keys(cambios).length) {
      return res.status(400).json({ error: 'La línea no tiene cambios' });
    }

    // Si la línea pasa a puntual, las excepciones (que solo aplican a líneas
    // recurrentes) dejan de tener sentido y se van con ella.
    const pasaAPuntual = cambios.modo === 'puntual';
    const actualizada = await detalle.update(linea.id, cambios);
    if (pasaAPuntual) {
      const excepciones = await detalle.listExcepciones(linea.id);
      for (const e of excepciones) await detalle.deleteExcepcion(e.id);
      if (excepciones.length) detalleAuditoria.excepciones_eliminadas = excepciones.length;
    }

    await pedidos.auditar(pedido.id, 'edicion', req.user.username, {
      linea_id: linea.id, campos: detalleAuditoria,
    }, motivo);

    const sync = await syncPedidos.sincronizarSinFallar(pedido.id);
    res.json({ linea: actualizada, pedido: await pedidos.getConDetalle(pedido.id), sync });
  } catch (err) { next(err); }
});

// PATCH /api/pedidos/:id/lineas/:lineaId/cancelar — cancelar una línea sola,
// sin cancelar el pedido entero.
router.patch('/:id/lineas/:lineaId/cancelar', requireEscritura, async (req, res, next) => {
  try {
    const ctx = await contextoEdicion(req, res);
    if (!ctx) return;
    const { pedido, motivo } = ctx;

    const linea = await cargarLinea(pedido.id, Number(req.params.lineaId));
    if (!linea) return res.status(404).json({ error: 'Línea no encontrada' });
    if (linea.cancelado) return res.status(400).json({ error: 'Esta línea ya está cancelada' });

    const cancelada = await detalle.cancelar(linea.id);
    await pedidos.auditar(pedido.id, 'cancelacion', req.user.username, {
      linea_cancelada: {
        id: linea.id, plato_id: linea.plato_id, plato_nombre: linea.plato_nombre,
        cantidad: linea.cantidad, modo: linea.modo,
      },
    }, motivo);

    const sync = await syncPedidos.sincronizarSinFallar(pedido.id);
    res.json({ linea: cancelada, pedido: await pedidos.getConDetalle(pedido.id), sync });
  } catch (err) { next(err); }
});

// ── Excepciones de líneas recurrentes ─────────────────────────────

// PUT /api/pedidos/:id/lineas/:lineaId/excepciones — alta o edición de la
// excepción de una fecha. PUT y no POST porque es idempotente: cargar dos veces
// la misma fecha actualiza, no duplica (UNIQUE (pedido_detalle_id, fecha)).
router.put('/:id/lineas/:lineaId/excepciones', requireEscritura, async (req, res, next) => {
  try {
    const ctx = await contextoEdicion(req, res);
    if (!ctx) return;
    const { pedido, motivo } = ctx;

    const linea = await cargarLinea(pedido.id, Number(req.params.lineaId));
    if (!linea) return res.status(404).json({ error: 'Línea no encontrada' });
    if (linea.cancelado) return res.status(400).json({ error: 'No se pueden cargar excepciones en una línea cancelada' });
    if (linea.modo !== 'recurrente') {
      return res.status(400).json({ error: 'Las excepciones solo aplican a líneas recurrentes' });
    }

    const body = req.body || {};
    const errores = [];

    const fecha = String(body.fecha || '').trim();
    const desde = detalle.aISO(linea.fecha_desde);
    const hasta = detalle.aISO(linea.fecha_hasta);
    if (!FECHA_RE.test(fecha)) {
      errores.push('Fecha de excepción inválida (formato YYYY-MM-DD)');
    } else if (fecha < desde || fecha > hasta) {
      errores.push(`La fecha debe estar dentro del rango de la línea (${desde} a ${hasta})`);
    } else if (!detalle.expandirHabiles(fecha, fecha).length) {
      // Una excepción en sábado o domingo no pisaría ninguna entrega.
      errores.push('Esa fecha no es un día hábil, la línea no produce entregas ese día');
    }

    const omitir = body.omitir === true || body.omitir === 'true';

    let plato_id = null;
    if (body.plato_id !== undefined && body.plato_id !== null && body.plato_id !== '') {
      plato_id = Number(body.plato_id);
      if (!Number.isInteger(plato_id) || !(await platos.idsActivos([plato_id])).has(plato_id)) {
        errores.push('El plato de la excepción es inválido o está inactivo');
        plato_id = null;
      }
    }

    let cantidad = null;
    if (body.cantidad !== undefined && body.cantidad !== null && body.cantidad !== '') {
      cantidad = Number(body.cantidad);
      if (!Number.isInteger(cantidad) || cantidad <= 0) {
        errores.push('La cantidad de la excepción debe ser un número entero mayor a 0');
        cantidad = null;
      }
    }

    const comentario = body.comentario ? String(body.comentario).trim().slice(0, 500) : null;

    // Una excepción sin omitir y sin ningún campo pisado no cambiaría nada.
    if (!omitir && plato_id === null && cantidad === null && comentario === null) {
      errores.push('La excepción no cambia nada: indicá omitir, u otro plato, cantidad o comentario');
    }

    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    const excepcion = await detalle.upsertExcepcion(linea.id, {
      fecha, plato_id, cantidad, comentario, omitir,
    });

    await pedidos.auditar(pedido.id, 'edicion', req.user.username, {
      linea_id: linea.id,
      excepcion: { id: excepcion.id, fecha, plato_id, cantidad, comentario, omitir },
    }, motivo);

    const sync = await syncPedidos.sincronizarSinFallar(pedido.id);
    res.json({ excepcion, pedido: await pedidos.getConDetalle(pedido.id), sync });
  } catch (err) { next(err); }
});

// DELETE /api/pedidos/:id/lineas/:lineaId/excepciones/:excId — quitar una
// excepción; esa fecha vuelve a producirse con los valores de la línea.
router.delete('/:id/lineas/:lineaId/excepciones/:excId', requireEscritura, async (req, res, next) => {
  try {
    const ctx = await contextoEdicion(req, res);
    if (!ctx) return;
    const { pedido, motivo } = ctx;

    const linea = await cargarLinea(pedido.id, Number(req.params.lineaId));
    if (!linea) return res.status(404).json({ error: 'Línea no encontrada' });

    const excId = Number(req.params.excId);
    const excepcion = excId ? await detalle.getExcepcionById(excId) : null;
    if (!excepcion || excepcion.pedido_detalle_id !== linea.id) {
      return res.status(404).json({ error: 'Excepción no encontrada' });
    }

    await detalle.deleteExcepcion(excepcion.id);
    await pedidos.auditar(pedido.id, 'edicion', req.user.username, {
      linea_id: linea.id,
      excepcion_eliminada: { id: excepcion.id, fecha: detalle.aISO(excepcion.fecha) },
    }, motivo);

    const sync = await syncPedidos.sincronizarSinFallar(pedido.id);
    res.json({ pedido: await pedidos.getConDetalle(pedido.id), sync });
  } catch (err) { next(err); }
});

// GET /api/pedidos/sync/errores — intentos de sync fallidos (solo admin).
// No colisiona con GET /:id porque son dos segmentos de path.
// Es la vista de diagnóstico de la bitácora: qué quedó sin espejar en Narma
// Pedidos y con qué payload reenviarlo.
router.get('/sync/errores', requireAdmin, async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 100, 500);
    res.json({ errores: await syncPedidos.listarErrores(limite) });
  } catch (err) { next(err); }
});

module.exports = router;
