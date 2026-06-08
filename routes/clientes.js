const express = require('express');
const clientes = require('../models/clientes');
const pedidos = require('../models/pedidos');
const { ALERT_DAYS } = require('../config');

const router = express.Router();

const SEGMENTOS = ['particular', 'empresa'];
const CANALES = ['whatsapp', 'redes', 'embajador', 'boca_a_boca', 'b2b', 'otro'];
const ESTADOS = ['activo', 'pausado', 'inactivo', 'baja'];

function requireAdmin(req, res, next) {
  if (req.session.user.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
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

// GET /api/clientes — listado con filtros y búsqueda
router.get('/', (req, res) => {
  const { estado, segmento, canal_origen, empresa, q } = req.query;
  const filtros = {};
  if (estado && ESTADOS.includes(estado)) filtros.estado = estado;
  if (segmento && SEGMENTOS.includes(segmento)) filtros.segmento = segmento;
  if (canal_origen && CANALES.includes(canal_origen)) filtros.canal_origen = canal_origen;
  if (empresa) filtros.empresa = String(empresa).trim();
  if (q) filtros.q = String(q).trim();

  res.json({ clientes: clientes.list(filtros) });
});

// GET /api/clientes/empresas — nombres de empresa distintos (para filtro)
router.get('/empresas', (req, res) => {
  res.json({ empresas: clientes.listEmpresas() });
});

// GET /api/clientes/alertas — clientes sin pedido reciente (solo admin)
router.get('/alertas', requireAdmin, (req, res) => {
  res.json({ alertDays: ALERT_DAYS, alertas: clientes.listAlertas() });
});

// GET /api/clientes/kpis — KPIs del dashboard (solo admin)
router.get('/kpis', requireAdmin, (req, res) => {
  res.json({
    total_activos: clientes.countActivos(),
    alertas: clientes.countAlertas(),
    altas_mes: clientes.countAltasMes(),
    bajas_mes: clientes.countBajasMes(),
    ticket_promedio_general: clientes.ticketPromedioGeneral(),
    ticket_promedio_segmento: clientes.ticketPromedioPorSegmento(),
    evolucion_activos: clientes.evolucionActivosPorMes(6),
    alert_days: ALERT_DAYS,
  });
});

// GET /api/clientes/:id — ficha + historial de pedidos
router.get('/:id', (req, res) => {
  const cliente = clientes.getById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const colaboradores = cliente.empresa ? clientes.listColaboradores(cliente.empresa, cliente.id) : [];
  res.json({ cliente, pedidos: pedidos.listByCliente(cliente.id), colaboradores });
});

// POST /api/clientes — crear cliente nuevo (operador y admin)
router.post('/', (req, res) => {
  const { data, errores } = validarCliente(req.body || {});
  if (errores.length) return res.status(400).json({ error: errores.join('. ') });

  if (clientes.existsCedula(data.cedula)) {
    return res.status(409).json({ error: 'Ya existe un cliente con esa cédula' });
  }

  const cliente = clientes.create(data);
  res.status(201).json({ cliente });
});

// PUT /api/clientes/:id — editar datos básicos (operador y admin)
router.put('/:id', (req, res) => {
  const cliente = clientes.getById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  const { data, errores } = validarCliente(req.body || {});
  if (errores.length) return res.status(400).json({ error: errores.join('. ') });

  if (clientes.existsCedula(data.cedula, cliente.id)) {
    return res.status(409).json({ error: 'Ya existe otro cliente con esa cédula' });
  }

  const actualizado = clientes.update(cliente.id, data);
  res.json({ cliente: actualizado });
});

// PUT /api/clientes/:id/estado — cambiar estado (solo admin)
router.put('/:id/estado', requireAdmin, (req, res) => {
  const cliente = clientes.getById(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  const { estado } = req.body || {};
  if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const actualizado = clientes.updateEstado(cliente.id, estado);
  res.json({ cliente: actualizado });
});

module.exports = router;
