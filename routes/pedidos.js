const express = require('express');
const clientes = require('../models/clientes');
const pedidos = require('../models/pedidos');

const router = express.Router();

const MEDIOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'pos'];
const ESTADOS_PAGO = ['pagado', 'pendiente'];
const TIPOS_VIANDA = ['economico', 'saludable', 'low_carb'];

function requireEscritura(req, res, next) {
  if (req.user.rol === 'visor') return res.status(403).json({ error: 'Acceso de solo lectura' });
  next();
}

// POST /api/pedidos — registrar nuevo pedido (admin y operador; visor no puede)
router.post('/', requireEscritura, async (req, res, next) => {
  try {
    const body = req.body || {};
    const errores = [];

    const cliente_id = Number(body.cliente_id);
    if (!cliente_id || !(await clientes.getById(cliente_id))) errores.push('Cliente inválido');

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

    const medio_pago = body.medio_pago ? String(body.medio_pago).trim() : null;
    if (medio_pago && !MEDIOS_PAGO.includes(medio_pago)) errores.push('Medio de pago inválido');

    const tipo_vianda = body.tipo_vianda ? String(body.tipo_vianda).trim() : null;
    if (tipo_vianda && !TIPOS_VIANDA.includes(tipo_vianda)) errores.push('Tipo de vianda inválido');

    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    // Si se marca como pagado y no se especificó el monto pagado, se asume pago completo.
    if (estado_pago === 'pagado' && monto_pagado === null) monto_pagado = monto;

    const pedido = await pedidos.create({
      cliente_id,
      fecha_pedido,
      monto,
      monto_pagado,
      estado_pago,
      medio_pago,
      tipo_vianda,
      descripcion: body.descripcion ? String(body.descripcion).trim() : null,
    });
    res.status(201).json({ pedido });
  } catch (err) { next(err); }
});

module.exports = router;
