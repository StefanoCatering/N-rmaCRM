const express = require('express');
const grilla = require('../models/grilla');
const retiros = require('../models/retiros');

const router = express.Router();

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Permisos (definidos localmente, como en el resto de routes/) ──
//
// ver     → admin, visor, comedor
// marcar  → admin, comedor
//
// El visor entra igual que en todo el CRM: ve y no toca. El operador no entra:
// la entrega de las viandas en el comedor del banco no es parte de su trabajo,
// y la lista nominal de funcionarios no tiene por qué estar a la vista de
// quien carga pedidos.
//
// req.user.rol se lee de la BASE en cada request (requireAuth, fase 8), así
// que acá no hace falta una segunda consulta: cambiarle el rol a alguien ya
// aplica en el acto.

const PUEDEN_VER = ['admin', 'visor', 'comedor'];
const PUEDEN_MARCAR = ['admin', 'comedor'];

function requireVer(req, res, next) {
  if (PUEDEN_VER.includes(req.user.rol)) return next();
  return res.status(403).json({ error: 'No autorizado' });
}

function requireMarcar(req, res, next) {
  if (PUEDEN_MARCAR.includes(req.user.rol)) return next();
  return res.status(403).json({ error: 'Los retiros los marca el comedor; esta pantalla es de solo lectura para vos' });
}

// ── Validaciones ──────────────────────────────────────────────────

// FECHA_RE deja pasar fechas que no existen ('2026-02-31'). Postgres las
// rechazaría con un 500; acá se devuelve un 400 entendible. Mismo criterio que
// routes/grilla.js y routes/resumen.js.
function fechaReal(iso) {
  if (!FECHA_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Fecha que se puede CONSULTAR: cualquier día hábil hasta hoy. El pasado se ve
// (de solo lectura), el futuro no: todavía no se entregó nada.
// Devuelve el mensaje de error, o null si la fecha sirve.
function errorFechaConsulta(fecha) {
  if (!fechaReal(fecha)) return 'Fecha inválida (formato YYYY-MM-DD)';
  if (!grilla.esHabil(fecha)) return 'El comedor funciona solo de lunes a viernes';
  if (fecha > grilla.hoyISO()) return 'Todavía no se puede ver un día que no llegó';
  return null;
}

// Fecha que se puede MARCAR: hoy o el día hábil anterior a hoy. Lo demás ya
// está cerrado — ver models/retiros.js (fechasEditables).
function errorFechaMarca(fecha) {
  const consulta = errorFechaConsulta(fecha);
  if (consulta) return consulta;
  if (!retiros.fechaEditable(fecha)) {
    return 'Ese día ya no se puede modificar: solo se marcan hoy y el día hábil anterior';
  }
  return null;
}

// La empresa del request. Sin empresa en el query, la única activa en
// grilla_empresas (hoy UENO BANK, el único comedor con atención en el lugar).
// Si alguna vez hay más de una activa, hay que pedirla: elegir una por el
// orden alfabético sería adivinar.
//
// Devuelve la fila de grilla_empresas, o null si ya respondió.
async function resolverEmpresa(res, valor) {
  const pedida = String(valor || '').trim();

  if (!pedida) {
    const activas = await grilla.listEmpresas();
    if (!activas.length) {
      res.status(404).json({ error: 'No hay ninguna empresa con grilla de comedor activa' });
      return null;
    }
    if (activas.length > 1) {
      res.status(400).json({
        error: 'Hay más de una empresa con comedor activo: indicá cuál (' +
          activas.map(e => e.empresa).join(', ') + ')',
      });
      return null;
    }
    return activas[0];
  }

  const emp = await grilla.getEmpresa(pedida);
  if (!emp) {
    res.status(404).json({ error: 'Esa empresa no tiene grilla de comedor configurada' });
    return null;
  }
  if (!emp.activa) {
    res.status(400).json({ error: 'La grilla de esa empresa está desactivada' });
    return null;
  }
  return emp;
}

// ── Lectura ───────────────────────────────────────────────────────

// GET /api/retiros/dia?empresa=&fecha= — todo lo que dibuja la pantalla:
// quiénes deben retirar con su plato, quiénes están ausentes, el comentario
// del día y los totales. Sin fecha, hoy en hora de Asunción.
//
// 'hoy' va en la respuesta para que la pantalla no tenga que adivinar el día
// del servidor con el reloj del navegador, que puede estar en otra zona.
router.get('/dia', requireVer, async (req, res, next) => {
  try {
    const emp = await resolverEmpresa(res, req.query.empresa);
    if (!emp) return;

    const crudo = req.query.fecha;
    const fecha = (crudo === undefined || crudo === null || crudo === '')
      ? grilla.hoyISO()
      : String(crudo).trim();

    const errorFecha = errorFechaConsulta(fecha);
    if (errorFecha) return res.status(400).json({ error: errorFecha });

    const dia = await retiros.armarDia(emp.empresa, fecha);

    res.json({
      ...dia,
      // Dos condiciones, y las dos tienen que darse: que el usuario pueda
      // marcar y que el día siga abierto.
      editable: PUEDEN_MARCAR.includes(req.user.rol) && retiros.fechaEditable(fecha),
      puede_marcar: PUEDEN_MARCAR.includes(req.user.rol),
      hoy: grilla.hoyISO(),
    });
  } catch (err) { next(err); }
});

// ── Escritura ─────────────────────────────────────────────────────

// PUT /api/retiros/marca { cliente_id, fecha, retiro } — marca o desmarca el
// retiro de una vianda.
//
// La empresa no viene en el body: sale del plan del colaborador. Así no se
// puede marcar a alguien "por" otra empresa, y la validación de que ese día le
// toca vianda se hace contra su propia grilla.
router.put('/marca', requireMarcar, async (req, res, next) => {
  try {
    const body = req.body || {};

    const cliente_id = Number(body.cliente_id);
    if (!Number.isInteger(cliente_id) || cliente_id <= 0) {
      return res.status(400).json({ error: 'Colaborador inválido' });
    }

    const fecha = String(body.fecha || '').trim();
    const errorFecha = errorFechaMarca(fecha);
    if (errorFecha) return res.status(400).json({ error: errorFecha });

    if (typeof body.retiro !== 'boolean') {
      return res.status(400).json({ error: 'retiro tiene que ser true o false' });
    }

    const plan = await grilla.getPlan(cliente_id);
    if (!plan) return res.status(400).json({ error: 'Ese colaborador no está en el plan de comedor' });

    const emp = await resolverEmpresa(res, plan.empresa);
    if (!emp) return;

    // Que ese día le toque vianda se resuelve contra la misma lista que ve la
    // pantalla: si está ausente o fuera de plan, no hay nada que marcar.
    const errorMarcable = await retiros.errorMarcable(emp.empresa, fecha, cliente_id);
    if (errorMarcable) return res.status(400).json({ error: errorMarcable });

    const fila = body.retiro
      ? await retiros.marcar(cliente_id, fecha, req.user)
      : await retiros.desmarcar(cliente_id, fecha, req.user);

    console.log(
      '[retiros]', body.retiro ? 'marca' : 'desmarca',
      '| user:', req.user.username, '| cliente:', cliente_id, '| fecha:', fecha
    );

    res.json({
      ok: true,
      cliente_id,
      fecha,
      retiro: body.retiro,
      marcado_en: fila ? fila.marcado_en : null,
    });
  } catch (err) { next(err); }
});

// PUT /api/retiros/nota { empresa, fecha, texto } — comentario libre del día
// ("vino Fulano, no figura en la lista"). Texto vacío borra la nota.
router.put('/nota', requireMarcar, async (req, res, next) => {
  try {
    const body = req.body || {};

    const emp = await resolverEmpresa(res, body.empresa);
    if (!emp) return;

    const fecha = String(body.fecha || '').trim();
    const errorFecha = errorFechaMarca(fecha);
    if (errorFecha) return res.status(400).json({ error: errorFecha });

    if (body.texto !== undefined && body.texto !== null && typeof body.texto !== 'string') {
      return res.status(400).json({ error: 'El comentario tiene que ser texto' });
    }
    const crudo = typeof body.texto === 'string' ? body.texto : '';
    if (crudo.trim().length > retiros.MAX_NOTA) {
      return res.status(400).json({ error: `El comentario no puede pasar de ${retiros.MAX_NOTA} caracteres` });
    }

    const fila = await retiros.setNota(emp.empresa, fecha, crudo, req.user);

    console.log(
      '[retiros] nota | user:', req.user.username,
      '| empresa:', emp.empresa, '| fecha:', fecha, '|', fila ? 'guardada' : 'borrada'
    );

    res.json({ ok: true, empresa: emp.empresa, fecha, nota: fila ? fila.texto : null });
  } catch (err) { next(err); }
});

module.exports = router;
