const express = require('express');
const detalle = require('../models/pedidoDetalle');
const resumen = require('../models/resumen');

const router = express.Router();

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// FECHA_RE deja pasar fechas que no existen ('2026-02-31'). Postgres las
// rechazaría con un 500; acá se devuelve un 400 entendible. Mismo criterio que
// routes/grilla.js.
function fechaReal(iso) {
  if (!FECHA_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// GET /api/resumen?fecha=YYYY-MM-DD — todo lo que dibuja el Resumen del día:
// el total por plato y envase, el control contra lo que recibió cocina y el
// desglose por fuente.
//
// Sin fecha, devuelve MAÑANA en hora de Asunción: es el día que Administración
// revisa cada noche. La fecha resuelta vuelve en la respuesta, así la pantalla
// no tiene que adivinar el día del servidor con el reloj del navegador.
//
// Lo ven admin, operador y visor — los tres roles que existen. No hay nada que
// escribir en esta pantalla, así que no hay un permiso aparte: es la misma
// información de producción que ya ven en pedidos y en la grilla.
router.get('/', async (req, res, next) => {
  try {
    const crudo = req.query.fecha;
    const fecha = (crudo === undefined || crudo === null || crudo === '')
      ? resumen.fechaPorDefecto()
      : String(crudo).trim();

    if (!fechaReal(fecha)) return res.status(400).json({ error: 'Fecha inválida (formato YYYY-MM-DD)' });

    // hoy va en la respuesta para que la pantalla pueda marcar "mañana" /
    // "hoy" sin usar el reloj del navegador, que puede estar en otra zona.
    res.json({ resumen: await resumen.armar(fecha), hoy: detalle.hoyISO() });
  } catch (err) { next(err); }
});

module.exports = router;
