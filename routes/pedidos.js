const express = require('express');
const clientes = require('../models/clientes');
const pedidos = require('../models/pedidos');

const router = express.Router();

const MEDIOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'pos', 'cortesia'];
const ESTADOS_PAGO = ['pagado', 'pendiente', 'parcial'];
const TIPOS_VIANDA = ['economico', 'saludable', 'low_carb', 'modificacion_menu'];
const ESTADOS_CLIENTE = ['activo', 'pausado', 'inactivo', 'baja'];
const SEGMENTOS = ['particular', 'empresa'];
const CANALES = ['whatsapp', 'redes', 'embajador', 'boca_a_boca', 'b2b', 'otro'];
const TIPOS_VIANDA_FILTRO = [...TIPOS_VIANDA, 'sin_vianda']; // filtro de listado acepta también "sin vianda"

function requireEscritura(req, res, next) {
  if (req.user.rol === 'visor') return res.status(403).json({ error: 'Acceso de solo lectura' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  next();
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
    });
    res.status(201).json({ pedido });
  } catch (err) { next(err); }
});

// PATCH /api/pedidos/:id/pago — modificar estado de pago de un pedido (admin y operador)
router.patch('/:id/pago', requireEscritura, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pedido = id ? await pedidos.getById(id) : null;
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

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

    const actualizado = await pedidos.updatePago(id, estado_pago, monto_pagado);
    res.json({ pedido: actualizado });
  } catch (err) { next(err); }
});

module.exports = router;
