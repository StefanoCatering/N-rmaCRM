const express = require('express');
const clientes = require('../models/clientes');
const pedidos = require('../models/pedidos');
const ubicaciones = require('../models/ubicaciones');
const { ALERT_DAYS } = require('../config');

const router = express.Router();

const SEGMENTOS = ['particular', 'empresa', 'embajador'];
const CANALES = ['whatsapp', 'redes', 'embajador', 'boca_a_boca', 'b2b', 'otro'];
const ESTADOS = ['activo', 'pausado', 'inactivo', 'baja'];

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Rango por defecto de los KPIs del dashboard cuando no se pasan fecha_desde/fecha_hasta:
// el mes actual completo (primer día al último día).
function rangoMesActual() {
  const now = new Date();
  const desde = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const finDeMes = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const hasta = finDeMes.toISOString().split('T')[0];
  return { desde, hasta };
}

// Resuelve fecha_desde/fecha_hasta desde query params, con fallback al mes actual
// si no vienen o no tienen el formato esperado.
function resolverRangoFechas(query) {
  const { desde, hasta } = rangoMesActual();
  const fecha_desde = FECHA_RE.test(query.fecha_desde) ? query.fecha_desde : desde;
  const fecha_hasta = FECHA_RE.test(query.fecha_hasta) ? query.fecha_hasta : hasta;
  return { fecha_desde, fecha_hasta };
}

// Admin y visor pueden ver datos de dashboard (KPIs, alertas)
function requireAdminOrVisor(req, res, next) {
  if (req.user.rol !== 'admin' && req.user.rol !== 'visor') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  next();
}

// Solo admin puede modificar estado/seguimiento
function requireAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  next();
}

// Visor es solo lectura — no puede crear ni editar clientes/pedidos
function requireEscritura(req, res, next) {
  if (req.user.rol === 'visor') return res.status(403).json({ error: 'Acceso de solo lectura' });
  next();
}

function validarCliente(body, { partial = false } = {}) {
  const errores = [];
  const data = {};

  if (!partial || body.nombre_completo !== undefined) {
    data.nombre_completo = String(body.nombre_completo || '').trim();
    if (!data.nombre_completo) errores.push('El nombre completo es requerido');
  }
  if (!partial || body.cedula !== undefined) {
    data.cedula = String(body.cedula || '').trim();
    if (!data.cedula) errores.push('La cédula es requerida');
  }
  if (!partial || body.segmento !== undefined) {
    data.segmento = body.segmento;
    if (!SEGMENTOS.includes(data.segmento)) errores.push('Segmento inválido');
  }
  if (!partial || body.canal_origen !== undefined) {
    data.canal_origen = body.canal_origen;
    if (!CANALES.includes(data.canal_origen)) errores.push('Canal de origen inválido');
  }
  if (!partial || body.fecha_ingreso !== undefined) {
    data.fecha_ingreso = String(body.fecha_ingreso || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.fecha_ingreso)) errores.push('Fecha de ingreso inválida (formato YYYY-MM-DD)');
  }

  data.email = body.email ? String(body.email).trim() : null;
  data.telefono = body.telefono ? String(body.telefono).trim() : null;
  data.telefono2 = body.telefono2 ? String(body.telefono2).trim() : null;
  data.telefono3 = body.telefono3 ? String(body.telefono3).trim() : null;
  data.observaciones = body.observaciones ? String(body.observaciones).trim().slice(0, 500) : null;
  data.codigo_embajador = body.codigo_embajador ? String(body.codigo_embajador).trim() : null;
  data.empresa = body.empresa ? String(body.empresa).trim() : null;

  if (data.canal_origen === 'embajador' && !data.codigo_embajador) {
    errores.push('El código de embajador es requerido cuando el canal es "embajador"');
  }
  if (data.segmento === 'empresa' && !data.empresa) {
    errores.push('El nombre de la empresa es requerido cuando el segmento es "empresa"');
  }

  return { data, errores };
}

// Hasta 3 ubicaciones de entrega; descarta las que vienen completamente vacías.
function parseUbicaciones(body) {
  const raw = Array.isArray(body.ubicaciones) ? body.ubicaciones : [];
  return raw
    .slice(0, 3)
    .map(u => ({
      direccion: u && u.direccion ? String(u.direccion).trim() : '',
      zona: u && u.zona ? String(u.zona).trim() : '',
      referencia: u && u.referencia ? String(u.referencia).trim() : '',
    }))
    .filter(u => u.direccion || u.zona || u.referencia);
}

// GET /api/clientes — listado con filtros y búsqueda
router.get('/', async (req, res, next) => {
  try {
    const { estado, segmento, canal_origen, empresa, q } = req.query;
    const filtros = {};
    if (estado && ESTADOS.includes(estado)) filtros.estado = estado;
    if (segmento && SEGMENTOS.includes(segmento)) filtros.segmento = segmento;
    if (canal_origen && CANALES.includes(canal_origen)) filtros.canal_origen = canal_origen;
    if (empresa) filtros.empresa = String(empresa).trim();
    if (q) filtros.q = String(q).trim();
    res.json({ clientes: await clientes.list(filtros) });
  } catch (err) { next(err); }
});

// GET /api/clientes/empresas — nombres de empresa distintos (para filtro)
router.get('/empresas', async (req, res, next) => {
  try {
    res.json({ empresas: await clientes.listEmpresas() });
  } catch (err) { next(err); }
});

// GET /api/clientes/alertas — clientes sin pedido reciente (admin y visor)
router.get('/alertas', requireAdminOrVisor, async (req, res, next) => {
  try {
    res.json({ alertDays: ALERT_DAYS, alertas: await clientes.listAlertas() });
  } catch (err) { next(err); }
});

// GET /api/clientes/kpis — KPIs del dashboard (admin y visor)
// Acepta fecha_desde/fecha_hasta (YYYY-MM-DD) para acotar los KPIs de período;
// sin esos params, default al mes actual completo. total_activos y evolucion_activos
// no dependen del rango (foto actual / últimos 6 meses corridos).
router.get('/kpis', requireAdminOrVisor, async (req, res, next) => {
  try {
    const { fecha_desde, fecha_hasta } = resolverRangoFechas(req.query);
    const [
      total_activos,
      alertas,
      altas,
      bajas,
      ticket_promedio_general,
      ticket_promedio_segmento,
      evolucion_activos,
      pedidos_recepcionados,
      viandas_entregadas,
      cortesias,
      viandas_por_tipo_semana,
    ] = await Promise.all([
      clientes.countActivos(),
      clientes.countAlertas(),
      clientes.countAltas(fecha_desde, fecha_hasta),
      clientes.countBajas(fecha_desde, fecha_hasta),
      clientes.ticketPromedioGeneral(fecha_desde, fecha_hasta),
      clientes.ticketPromedioPorSegmento(fecha_desde, fecha_hasta),
      clientes.evolucionActivosPorMes(6),
      pedidos.countRecepcionadas(fecha_desde, fecha_hasta),
      pedidos.countEntregadas(fecha_desde, fecha_hasta),
      pedidos.countCortesia(fecha_desde, fecha_hasta),
      pedidos.viandasPorTipoPorSemana(fecha_desde, fecha_hasta),
    ]);
    res.json({
      total_activos,
      alertas,
      altas,
      bajas,
      ticket_promedio_general,
      ticket_promedio_segmento,
      evolucion_activos,
      pedidos_recepcionados,
      viandas_entregadas,
      cortesias,
      viandas_por_tipo_semana,
      fecha_desde,
      fecha_hasta,
      alert_days: ALERT_DAYS,
    });
  } catch (err) { next(err); }
});

// GET /api/clientes/:id — ficha + historial de pedidos
router.get('/:id', async (req, res, next) => {
  try {
    const cliente = await clientes.getById(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const [colaboradores, historialPedidos, ubicacionesCliente] = await Promise.all([
      cliente.empresa ? clientes.listColaboradores(cliente.empresa, cliente.id) : Promise.resolve([]),
      pedidos.listByCliente(cliente.id),
      ubicaciones.listByCliente(cliente.id),
    ]);
    cliente.ubicaciones = ubicacionesCliente;
    res.json({ cliente, pedidos: historialPedidos, colaboradores });
  } catch (err) { next(err); }
});

// POST /api/clientes — crear cliente nuevo (admin y operador; visor no puede)
router.post('/', requireEscritura, async (req, res, next) => {
  try {
    const { data, errores } = validarCliente(req.body || {});
    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    if (await clientes.existsCedula(data.cedula)) {
      return res.status(409).json({ error: 'Ya existe un cliente con esa cédula' });
    }

    const cliente = await clientes.create(data);
    const ubicacionesCliente = parseUbicaciones(req.body || {});
    if (ubicacionesCliente.length) await ubicaciones.replaceForCliente(cliente.id, ubicacionesCliente);
    cliente.ubicaciones = await ubicaciones.listByCliente(cliente.id);
    res.status(201).json({ cliente });
  } catch (err) { next(err); }
});

// PUT /api/clientes/:id — editar datos básicos (admin y operador; visor no puede)
router.put('/:id', requireEscritura, async (req, res, next) => {
  try {
    const cliente = await clientes.getById(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { data, errores } = validarCliente(req.body || {});
    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    if (await clientes.existsCedula(data.cedula, cliente.id)) {
      return res.status(409).json({ error: 'Ya existe otro cliente con esa cédula' });
    }

    const actualizado = await clientes.update(cliente.id, data);
    await ubicaciones.replaceForCliente(cliente.id, parseUbicaciones(req.body || {}));
    actualizado.ubicaciones = await ubicaciones.listByCliente(cliente.id);
    res.json({ cliente: actualizado });
  } catch (err) { next(err); }
});

// PUT /api/clientes/:id/estado — cambiar estado (solo admin)
router.put('/:id/estado', requireAdmin, async (req, res, next) => {
  try {
    const cliente = await clientes.getById(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { estado } = req.body || {};
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    const actualizado = await clientes.updateEstado(cliente.id, estado);
    res.json({ cliente: actualizado });
  } catch (err) { next(err); }
});

// PATCH /api/clientes/:id/seguimiento — marcar seguimiento de una alerta (solo admin)
router.patch('/:id/seguimiento', requireAdmin, async (req, res, next) => {
  try {
    const cliente = await clientes.getById(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const actualizado = await clientes.marcarSeguimiento(cliente.id);
    res.json({ cliente: actualizado });
  } catch (err) { next(err); }
});

module.exports = router;
