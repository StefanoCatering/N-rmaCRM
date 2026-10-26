const express = require('express');
const clientes = require('../models/clientes');
const pedidos = require('../models/pedidos');
const detalle = require('../models/pedidoDetalle');
const ubicaciones = require('../models/ubicaciones');
const grilla = require('../models/grilla');
// Las validaciones del alta de un plan de comedor son las MISMAS que las de
// POST /api/grilla/planes: viven en un módulo aparte para no tener dos copias
// (fase 12).
const grillaCompartido = require('./grillaCompartido');
const { ALERT_DAYS } = require('../config');

const router = express.Router();

const SEGMENTOS = ['particular', 'empresa', 'embajador'];
const CANALES = ['whatsapp', 'redes', 'embajador', 'boca_a_boca', 'b2b', 'otro'];
const ESTADOS = ['activo', 'pausado', 'inactivo', 'baja'];

// Estados que se pueden ELEGIR desde la ficha. La base sigue aceptando los
// cuatro de ESTADOS: 'pausado' y 'baja' son estados históricos que la ficha
// sabe mostrar (hoy no hay ningún cliente en ninguno de los dos), pero el
// activar / desactivar de ATC es un interruptor de dos posiciones y no un
// selector de cuatro valores que nadie sabía distinguir.
const ESTADOS_ASIGNABLES = ['activo', 'inactivo'];
const TIPOS_ENVASE = ['Narma', 'Venezia'];

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

// Solo admin puede marcar el seguimiento de una alerta
function requireAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  next();
}

// Activar / desactivar un cliente lo hace ATC en el día a día, así que ya no
// es exclusivo del admin (fase 11). Visor no, porque es de solo lectura, y
// comedor tampoco: su rol ni ve la ficha (lista blanca de requireAuth).
// Se nombran los roles permitidos en lugar de negar visor, para que un rol
// nuevo quede afuera hasta que alguien decida lo contrario.
function requireAdminOrOperador(req, res, next) {
  if (req.user.rol !== 'admin' && req.user.rol !== 'operador') {
    return res.status(403).json({ error: 'No autorizado' });
  }
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

  // tipo_envase: en qué envase se entrega. Default 'Venezia' (igual que el
  // DEFAULT de la columna); los clientes de empresas con envase propio se
  // cargan como 'Narma'.
  data.tipo_envase = body.tipo_envase ? String(body.tipo_envase).trim() : 'Venezia';
  if (!TIPOS_ENVASE.includes(data.tipo_envase)) errores.push('Tipo de envase inválido');

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

// GET /api/clientes — listado con filtros y búsqueda.
// solo_activos=1 restringe a los clientes activos: lo usa el buscador del alta
// de pedidos, que no tiene por qué ofrecer un cliente al que el POST le va a
// rechazar el pedido. Va después del filtro estado y lo pisa a propósito:
// "solo activos" es una restricción del llamador, no una preferencia.
// Sin el parámetro, el endpoint se comporta igual que antes.
router.get('/', async (req, res, next) => {
  try {
    const { estado, segmento, canal_origen, empresa, q } = req.query;
    const filtros = {};
    if (estado && ESTADOS.includes(estado)) filtros.estado = estado;
    if (req.query.solo_activos === '1') filtros.estado = 'activo';
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
//
// Con el bloque opcional `grilla` { plato_base_id, fecha_alta, observacion } el
// cliente queda además en la grilla de comedor de su empresa (fase 12): es el
// caso de ATC cargando un colaborador de UENO, que antes había que dar de alta
// dos veces, acá y en la grilla.
router.post('/', requireEscritura, async (req, res, next) => {
  try {
    const body = req.body || {};
    const { data, errores } = validarCliente(body);
    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    const pedidoDeGrilla = body.grilla && typeof body.grilla === 'object' ? body.grilla : null;

    // req.user.gestiona_grilla lo lee requireAuth de la BASE en cada request
    // (no del token), así que es el permiso vigente: sacárselo a alguien aplica
    // en el acto, igual que en routes/grilla.js.
    if (pedidoDeGrilla && !req.user.gestiona_grilla) {
      return res.status(403).json({ error: 'La grilla solo la edita quien tiene el permiso de gestión' });
    }

    // Todo lo del plan se valida ANTES de insertar nada: un alta de comedor
    // rechazada no tiene que dejar un cliente a medio crear.
    let emp = null;
    let datosPlan = null;
    if (pedidoDeGrilla) {
      if (data.segmento !== 'empresa') {
        return res.status(400).json({ error: 'Solo un cliente de segmento Corporativo puede figurar en la grilla' });
      }

      // La búsqueda es por nombre exacto: si entrara una variante de
      // mayúsculas, el plan quedaría creado y la persona no aparecería en
      // ninguna grilla (cargarSemana filtra por clientes.empresa). El form
      // normaliza el nombre antes de mandarlo.
      const resEmp = await grillaCompartido.resolverEmpresaGrilla(data.empresa, { paraEditar: true });
      if (resEmp.error) return res.status(resEmp.status).json({ error: resEmp.error });
      emp = resEmp.emp;

      const resPlan = await grillaCompartido.validarDatosPlan(pedidoDeGrilla);
      if (resPlan.error) return res.status(400).json({ error: resPlan.error });
      datosPlan = resPlan.datos;
    }

    if (await clientes.existsCedula(data.cedula)) {
      return res.status(409).json({ error: 'Ya existe un cliente con esa cédula' });
    }

    const ubicacionesCliente = parseUbicaciones(body);

    // Sin bloque de comedor, el alta es la de siempre.
    if (!datosPlan) {
      const cliente = await clientes.create(data);
      if (ubicacionesCliente.length) await ubicaciones.replaceForCliente(cliente.id, ubicacionesCliente);
      cliente.ubicaciones = await ubicaciones.listByCliente(cliente.id);
      return res.status(201).json({ cliente });
    }

    // Con bloque de comedor: cliente, ubicaciones y plan en UNA transacción.
    // Si el plan falla, el cliente no se crea — media alta sería peor que
    // ninguna, porque nadie se entera de que falta la mitad.
    //
    // Las comprobaciones que hace el alta desde la grilla (que el colaborador
    // sea de la empresa, que no sea la cuenta-empresa, que no tenga ya un plan
    // vigente) acá se cumplen por construcción: el cliente se acaba de crear
    // con esta empresa y no tiene ningún plan.
    const { cliente, plan } = await grilla.enTransaccion(async (client) => {
      const creado = await clientes.create(data, client);
      if (ubicacionesCliente.length) await ubicaciones.replaceForCliente(creado.id, ubicacionesCliente, client);
      const planCreado = await grilla.insertarPlan(client, creado.id, datosPlan, req.user);
      return { cliente: creado, plan: planCreado };
    });

    cliente.ubicaciones = await ubicaciones.listByCliente(cliente.id);

    // Después del COMMIT: si la semana ya se le había enviado a cocina, se
    // reenvía con el colaborador nuevo adentro. Nunca lanza, así que un
    // reenvío fallido no voltea un alta que ya está guardada.
    const envios = await grillaCompartido.reenviarPlan(emp.empresa, req.user);

    res.status(201).json({ cliente, plan, envios });
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

// PUT /api/clientes/:id/estado — activar o desactivar un cliente
// (admin y operador), con motivo obligatorio y registro en clientes_auditoria.
//
// La respuesta incluye un aviso con lo que quedó cargado y sigue vigente
// cuando se DESACTIVA. Nada se cancela automáticamente: un pedido con
// entregas pendientes o un plan de comedor se cancelan o se dan de baja a
// mano, porque desactivar al cliente y dejar de cocinarle son dos decisiones
// distintas (y la segunda, en el comedor, la toma otra persona).
router.put('/:id/estado', requireAdminOrOperador, async (req, res, next) => {
  try {
    const cliente = await clientes.getById(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { estado } = req.body || {};
    if (!ESTADOS_ASIGNABLES.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    if (estado === cliente.estado) {
      return res.status(400).json({ error: 'El cliente ya está en ese estado' });
    }

    const motivo = String((req.body || {}).motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'El motivo es requerido' });

    const actualizado = await clientes.updateEstado(cliente.id, {
      estado,
      estado_antes: cliente.estado,
      motivo,
      usuario: req.user.username,
    });

    const aviso = estado === 'activo'
      ? null
      : await clientes.pendientesAlDesactivar(cliente.id, detalle.hoyISO());

    res.json({ cliente: actualizado, aviso });
  } catch (err) { next(err); }
});

// GET /api/clientes/:id/auditoria — historial de cambios de estado.
// Sin guard de rol: lo ve cualquiera que pueda ver la ficha, igual que la
// auditoría de un pedido (fase 8). Saber por qué un cliente está inactivo es
// parte de leer su ficha, no un dato de administración.
router.get('/:id/auditoria', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id de cliente inválido' });
    res.json({ auditoria: await clientes.listAuditoria(id) });
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
