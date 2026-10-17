const express = require('express');
const detalle = require('../models/pedidoDetalle');
const grilla = require('../models/grilla');
const platos = require('../models/platos');
const syncPedidos = require('../models/syncPedidos');
const usuarios = require('../models/usuarios');

const router = express.Router();

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
// Techo del alta masiva de colaboradores. UENO, la empresa más grande, tiene
// ~195 clientes cargados: 200 cubre "seleccionar todos" sin dejar pasar un
// body absurdo.
const MAX_ALTAS = 200;

// ── Permisos (definidos localmente, como en el resto de routes/) ──
//
// La grilla tiene DOS permisos distintos:
//   ver    → admin, visor, o quien tenga gestiona_grilla
//   editar → SOLO gestiona_grilla
//
// gestiona_grilla se lee de la BASE en cada request y no del JWT: si se le
// saca el permiso a alguien, tiene que aplicar en el acto y no cuando se le
// venza el token de 8 horas. Es un SELECT por id (PK), despreciable.
//
// No es redundante con el rol: Admin1, que es quien edita la grilla, tiene
// rol 'operador' en la base.

async function requireVerGrilla(req, res, next) {
  try {
    req.gestionaGrilla = await usuarios.gestionaGrilla(req.user.id);
    if (req.gestionaGrilla || req.user.rol === 'admin' || req.user.rol === 'visor') return next();
    return res.status(403).json({ error: 'No autorizado' });
  } catch (err) { next(err); }
}

async function requireEditarGrilla(req, res, next) {
  try {
    req.gestionaGrilla = await usuarios.gestionaGrilla(req.user.id);
    if (!req.gestionaGrilla) {
      return res.status(403).json({ error: 'La grilla solo la edita quien tiene el permiso de gestión' });
    }
    next();
  } catch (err) { next(err); }
}

// ── Validaciones compartidas ──────────────────────────────────────

// FECHA_RE deja pasar fechas que no existen ('2026-02-31'). Postgres las
// rechazaría con un 500; acá se devuelve un 400 entendible.
function fechaReal(iso) {
  if (!FECHA_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Las tres reglas de una fecha editable de la grilla. Devuelve el mensaje de
// error, o null si la fecha sirve.
function errorFechaEditable(fecha) {
  if (!fechaReal(fecha)) return 'Fecha inválida (formato YYYY-MM-DD)';
  if (!grilla.esHabil(fecha)) return 'La grilla cubre solo días hábiles (lunes a viernes)';
  if (fecha < grilla.hoyISO()) return 'Los días anteriores a hoy son de solo lectura';
  return null;
}

// Resuelve la empresa del request y corta con el status correcto si no sirve.
// Devuelve la fila de grilla_empresas, o null si ya respondió.
async function resolverEmpresa(req, res, valor, { paraEditar = false } = {}) {
  const empresa = String(valor || '').trim();
  if (!empresa) {
    res.status(400).json({ error: 'La empresa es requerida' });
    return null;
  }
  const emp = await grilla.getEmpresa(empresa);
  if (!emp) {
    res.status(404).json({ error: 'Esa empresa no tiene grilla de comedor configurada' });
    return null;
  }
  if (paraEditar && !emp.activa) {
    res.status(400).json({ error: 'La grilla de esa empresa está desactivada' });
    return null;
  }
  return emp;
}

// El lunes pedido, o el de la semana en curso si no vino ninguno.
// Devuelve { lunes } o { error }.
function resolverLunes(valor) {
  if (valor === undefined || valor === null || valor === '') {
    return { lunes: grilla.lunesDe(grilla.hoyISO()) };
  }
  const lunes = String(valor).trim();
  if (!fechaReal(lunes)) return { error: 'Semana inválida (formato YYYY-MM-DD)' };
  if (!grilla.esLunes(lunes)) return { error: 'La semana se identifica por su lunes' };
  return { lunes };
}

// Carga el colaborador y verifica que pueda editarse su celda en esa empresa.
// Devuelve { plan } o { error }.
async function resolverColaborador(empresa, clienteIdCrudo) {
  const cliente_id = Number(clienteIdCrudo);
  if (!Number.isInteger(cliente_id) || cliente_id <= 0) return { error: 'Colaborador inválido' };

  const plan = await grilla.getPlan(cliente_id);
  if (!plan) return { error: 'Ese colaborador no está en el plan de comedor' };
  if (plan.empresa !== empresa) return { error: 'Ese colaborador no pertenece a esta empresa' };
  return { plan };
}

// Valida el contenido de una celda: exactamente uno de plato o ausencia, que
// es lo mismo que exige el CHECK grilla_celdas_una_cosa_check.
// Devuelve { plato_id, ausencia, comentario } o { error }.
async function resolverContenidoCelda(body) {
  const tieneAusencia = body.ausencia !== undefined && body.ausencia !== null && body.ausencia !== '';
  const tienePlato = body.plato_id !== undefined && body.plato_id !== null && body.plato_id !== '';

  if (tieneAusencia === tienePlato) {
    return { error: 'Indicá un plato distinto O una ausencia, no ambos ni ninguno' };
  }

  const comentario = body.comentario ? String(body.comentario).trim().slice(0, 500) : null;

  if (tieneAusencia) {
    const ausencia = String(body.ausencia).trim();
    if (!grilla.AUSENCIAS.includes(ausencia)) return { error: 'Motivo de ausencia inválido' };
    return { plato_id: null, ausencia, comentario };
  }

  const plato_id = Number(body.plato_id);
  if (!Number.isInteger(plato_id) || !(await platos.idsActivos([plato_id])).has(plato_id)) {
    // idsActivos deja afuera la categoría 'General': esos ítems van al pedido
    // general, no al plato de una persona.
    return { error: 'El plato es inválido, está inactivo o es un ítem del pedido general' };
  }
  return { plato_id, ausencia: null, comentario };
}

// Reenvía las semanas tocadas por un conjunto de fechas, pero solo las que ya
// habían sido enviadas a cocina. Nunca lanza.
function reenviarPorFechas(empresa, fechas, usuario) {
  return grilla.reenviarSiCorresponde(empresa, fechas.map(f => grilla.lunesDe(f)), usuario);
}

// Un cambio de plan (plato base, observación, baja) puede afectar cualquier
// día: se reenvían todas las semanas ya enviadas de hoy en adelante. Las
// semanas pasadas no se tocan — ya se entregaron.
async function reenviarPlan(empresa, usuario) {
  const desde = grilla.lunesDe(grilla.hoyISO());
  const semanas = await grilla.semanasEnviadas(empresa, { desde });
  return grilla.reenviarSiCorresponde(empresa, semanas, usuario);
}

// ── Lectura ───────────────────────────────────────────────────────

// GET /api/grilla/empresas — empresas con comedor configurado.
router.get('/empresas', requireVerGrilla, async (req, res, next) => {
  try {
    res.json({ empresas: await grilla.listEmpresas(), puede_editar: req.gestionaGrilla === true });
  } catch (err) { next(err); }
});

// GET /api/grilla/semana?empresa=&lunes= — todo lo que dibuja la grilla:
// colaboradores con plan activo en algún día de la semana, su plato base, las
// celdas cargadas, los días sin servicio, el pedido general, los totales por
// plato y día (calculados en el servidor, nunca en el front) y el estado del
// envío.
router.get('/semana', requireVerGrilla, async (req, res, next) => {
  try {
    const emp = await resolverEmpresa(req, res, req.query.empresa);
    if (!emp) return;

    const { lunes, error } = resolverLunes(req.query.lunes);
    if (error) return res.status(400).json({ error });

    const datos = await grilla.cargarSemana(emp.empresa, lunes);
    const totales = grilla.totalesDesdeDatos(datos);

    // Nombres de todos los platos en juego, incluidos los inactivos: una celda
    // vieja puede apuntar a un plato que después se desactivó.
    const idsPlato = new Set();
    for (const c of datos.colaboradores) idsPlato.add(c.plato_base_id);
    for (const celda of datos.celdas.values()) if (celda.plato_id) idsPlato.add(celda.plato_id);
    for (const g of datos.general) idsPlato.add(g.plato_id);
    for (const t of totales.values()) idsPlato.add(t.plato_id);
    const fichas = await platos.fichasPorId([...idsPlato]);
    const nombrePlato = id => (fichas.get(id) || {}).etiqueta || `Plato #${id}`;

    // Un colaborador por fila, con lo que come cada día ya resuelto en el
    // servidor: el front dibuja, no calcula.
    const colaboradores = datos.colaboradores.map(c => {
      const dias = {};
      for (const fecha of datos.dias) {
        const efectivo = grilla.platoEfectivo(datos, c, fecha);
        if (!efectivo) { dias[fecha] = { estado: 'fuera_de_plan' }; continue; }
        if (efectivo.tipo === 'ausencia') {
          dias[fecha] = {
            estado: 'ausencia',
            ausencia: efectivo.ausencia,
            comentario: efectivo.comentario,
            celda_id: efectivo.celda.id,
          };
          continue;
        }
        dias[fecha] = {
          estado: efectivo.base ? 'base' : 'cambio',
          plato_id: efectivo.plato_id,
          plato_nombre: nombrePlato(efectivo.plato_id),
          comentario: efectivo.comentario,
          celda_id: efectivo.celda ? efectivo.celda.id : null,
        };
      }
      return {
        cliente_id: c.cliente_id,
        nombre_completo: c.nombre_completo,
        cedula: c.cedula,
        estado: c.estado,
        plato_base_id: c.plato_base_id,
        plato_base_nombre: nombrePlato(c.plato_base_id),
        observacion: c.observacion,
        fecha_alta: c.fecha_alta,
        fecha_baja: c.fecha_baja,
        dias,
      };
    });

    // Pedido general: una fila por ítem, con la cantidad de cada día.
    const generalPorPlato = new Map();
    for (const g of datos.general) {
      if (!generalPorPlato.has(g.plato_id)) {
        generalPorPlato.set(g.plato_id, { plato_id: g.plato_id, plato_nombre: nombrePlato(g.plato_id), cantidades: {} });
      }
      generalPorPlato.get(g.plato_id).cantidades[g.fecha] = g.cantidad;
    }

    // Totales por plato y día + total de viandas por día, al pie de la grilla.
    const totalesPorPlato = new Map();
    const totalesPorDia = {};
    for (const fecha of datos.dias) totalesPorDia[fecha] = 0;
    for (const t of totales.values()) {
      if (!totalesPorPlato.has(t.plato_id)) {
        totalesPorPlato.set(t.plato_id, { plato_id: t.plato_id, plato_nombre: nombrePlato(t.plato_id), por_dia: {}, total: 0 });
      }
      const fila = totalesPorPlato.get(t.plato_id);
      fila.por_dia[t.fecha] = t.cantidad;
      fila.total += t.cantidad;
      totalesPorDia[t.fecha] += t.cantidad;
    }

    const pedido = await grilla.getPedidoSemana(emp.empresa, lunes);
    const envio = await grilla.ultimoEnvio(emp.empresa, lunes);

    // Aviso del jueves: a partir del jueves, la semana siguiente ya tendría
    // que estar enviada para que cocina pueda comprar. Se calcula acá porque
    // "hoy" es en Asunción, no en el huso del navegador ni en UTC.
    const hoy = grilla.hoyISO();
    const diaHoy = detalle.diaSemana(hoy);
    const lunesProxima = detalle.sumarDias(grilla.lunesDe(hoy), 7);
    const proximaEnviada = !!(await grilla.getPedidoSemana(emp.empresa, lunesProxima));

    res.json({
      empresa: emp.empresa,
      cliente_pedido: { id: emp.cliente_pedido_id, nombre: emp.cliente_nombre, tipo_envase: emp.cliente_tipo_envase },
      lunes,
      hoy,
      dias: datos.dias,
      dias_sin_servicio: Object.fromEntries(datos.sinServicio),
      colaboradores,
      general: [...generalPorPlato.values()],
      catalogo_general: await platos.listTodosActivosPorCategoria(),
      totales: [...totalesPorPlato.values()].sort((a, b) => a.plato_nombre.localeCompare(b.plato_nombre, 'es')),
      totales_por_dia: totalesPorDia,
      // Una semana cuyo viernes ya pasó es de solo lectura entera: la vista
      // apaga el botón de enviar en vez de dejar que ATC coma el 400.
      semana_terminada: grilla.semanaTerminada(lunes),
      envio: {
        enviada: !!pedido,
        pedido_id: pedido ? pedido.id : null,
        ultimo: envio,
      },
      aviso_proxima_semana: {
        // jueves (4), viernes (5), sábado (6) y domingo (0)
        mostrar: (diaHoy >= 4 || diaHoy === 0) && !proximaEnviada,
        lunes: lunesProxima,
        enviada: proximaEnviada,
      },
      puede_editar: req.gestionaGrilla === true,
    });
  } catch (err) { next(err); }
});

// GET /api/grilla/dia?empresa=&fecha= — hoja del día imprimible: totales por
// plato y lista nominal de quien come algo distinto al estándar o no come.
router.get('/dia', requireVerGrilla, async (req, res, next) => {
  try {
    const emp = await resolverEmpresa(req, res, req.query.empresa);
    if (!emp) return;

    const fecha = String(req.query.fecha || '').trim();
    if (!fechaReal(fecha)) return res.status(400).json({ error: 'Fecha inválida (formato YYYY-MM-DD)' });
    if (!grilla.esHabil(fecha)) return res.status(400).json({ error: 'La grilla cubre solo días hábiles (lunes a viernes)' });

    res.json({ dia: await grilla.hojaDia(emp.empresa, fecha), puede_editar: req.gestionaGrilla === true });
  } catch (err) { next(err); }
});

// GET /api/grilla/candidatos?empresa=&q= — clientes de la empresa que todavía
// no están en el plan, para el alta de colaboradores.
router.get('/candidatos', requireVerGrilla, async (req, res, next) => {
  try {
    const emp = await resolverEmpresa(req, res, req.query.empresa);
    if (!emp) return;
    const q = req.query.q ? String(req.query.q).trim() : null;
    res.json({ candidatos: await grilla.candidatos(emp.empresa, { q }) });
  } catch (err) { next(err); }
});

// ── Escritura: celdas ─────────────────────────────────────────────

// PUT /api/grilla/celda — marcar la diferencia de un colaborador en un día.
// PUT y no POST porque es idempotente: volver a marcar la misma celda la pisa
// (UNIQUE (cliente_id, fecha)).
router.put('/celda', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const fecha = String(body.fecha || '').trim();
    const errFecha = errorFechaEditable(fecha);
    if (errFecha) return res.status(400).json({ error: errFecha });

    const { plan, error: errCol } = await resolverColaborador(emp.empresa, body.cliente_id);
    if (errCol) return res.status(400).json({ error: errCol });

    if (!grilla.planActivoEn(plan, fecha)) {
      return res.status(400).json({ error: 'Ese día el colaborador no está en el plan (fuera del alta/baja)' });
    }

    const contenido = await resolverContenidoCelda(body);
    if (contenido.error) return res.status(400).json({ error: contenido.error });

    const celda = await grilla.upsertCelda({ cliente_id: plan.cliente_id, fecha, ...contenido }, req.user);
    const envios = await reenviarPorFechas(emp.empresa, [fecha], req.user);

    res.json({ celda, envios });
  } catch (err) { next(err); }
});

// DELETE /api/grilla/celda — quitar la diferencia: ese día vuelve al plato base.
// Los parámetros van por query además de por body: hay clientes HTTP que
// descartan el body de un DELETE (mismo criterio que routes/pedidos.js).
router.delete('/celda', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa || req.query.empresa, { paraEditar: true });
    if (!emp) return;

    const fecha = String(body.fecha || req.query.fecha || '').trim();
    const errFecha = errorFechaEditable(fecha);
    if (errFecha) return res.status(400).json({ error: errFecha });

    const { plan, error: errCol } = await resolverColaborador(emp.empresa, body.cliente_id || req.query.cliente_id);
    if (errCol) return res.status(400).json({ error: errCol });

    const borrada = await grilla.borrarCelda(plan.cliente_id, fecha, req.user);
    if (!borrada) return res.status(404).json({ error: 'Ese día no tenía ninguna diferencia marcada' });

    const envios = await reenviarPorFechas(emp.empresa, [fecha], req.user);
    res.json({ celda: borrada, envios });
  } catch (err) { next(err); }
});

// PUT /api/grilla/celda/rango — la misma diferencia para un rango de fechas
// (vacaciones, una licencia). Solo toca los días hábiles del rango en los que
// el colaborador está efectivamente en el plan; el resto se informa como
// omitido en lugar de fallar.
router.put('/celda/rango', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const desde = String(body.desde || '').trim();
    const hasta = String(body.hasta || '').trim();
    if (!fechaReal(desde) || !fechaReal(hasta)) {
      return res.status(400).json({ error: 'Las fechas desde y hasta son requeridas (formato YYYY-MM-DD)' });
    }
    if (hasta < desde) return res.status(400).json({ error: 'La fecha hasta no puede ser anterior a la fecha desde' });
    if (desde < grilla.hoyISO()) return res.status(400).json({ error: 'Los días anteriores a hoy son de solo lectura' });
    if (detalle.diasEnRango(desde, hasta) > detalle.MAX_DIAS_RANGO) {
      return res.status(400).json({ error: `El rango no puede superar ${detalle.MAX_DIAS_RANGO} días` });
    }

    const { plan, error: errCol } = await resolverColaborador(emp.empresa, body.cliente_id);
    if (errCol) return res.status(400).json({ error: errCol });

    const contenido = await resolverContenidoCelda(body);
    if (contenido.error) return res.status(400).json({ error: contenido.error });

    const habiles = detalle.expandirHabiles(desde, hasta);
    const fechas = habiles.filter(f => grilla.planActivoEn(plan, f));
    if (!fechas.length) {
      return res.status(400).json({
        error: 'El rango no incluye ningún día hábil en el que el colaborador esté en el plan',
      });
    }

    const celdas = await grilla.upsertCeldasRango({ cliente_id: plan.cliente_id, fechas, ...contenido }, req.user);
    const envios = await reenviarPorFechas(emp.empresa, fechas, req.user);

    res.json({ celdas, aplicadas: fechas.length, omitidas: habiles.length - fechas.length, envios });
  } catch (err) { next(err); }
});

// ── Escritura: día sin servicio ───────────────────────────────────

// PUT /api/grilla/sin-servicio — feriado o cierre: ese día no se produce nada
// para esa empresa.
router.put('/sin-servicio', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const fecha = String(body.fecha || '').trim();
    const errFecha = errorFechaEditable(fecha);
    if (errFecha) return res.status(400).json({ error: errFecha });

    const motivo = body.motivo ? String(body.motivo).trim().slice(0, 200) : null;

    const fila = await grilla.setSinServicio(emp.empresa, fecha, motivo, req.user);
    const envios = await reenviarPorFechas(emp.empresa, [fecha], req.user);
    res.json({ sin_servicio: fila, envios });
  } catch (err) { next(err); }
});

// DELETE /api/grilla/sin-servicio — vuelve a haber servicio ese día.
router.delete('/sin-servicio', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa || req.query.empresa, { paraEditar: true });
    if (!emp) return;

    const fecha = String(body.fecha || req.query.fecha || '').trim();
    const errFecha = errorFechaEditable(fecha);
    if (errFecha) return res.status(400).json({ error: errFecha });

    const borrada = await grilla.borrarSinServicio(emp.empresa, fecha, req.user);
    if (!borrada) return res.status(404).json({ error: 'Ese día no estaba marcado sin servicio' });

    const envios = await reenviarPorFechas(emp.empresa, [fecha], req.user);
    res.json({ sin_servicio: borrada, envios });
  } catch (err) { next(err); }
});

// ── Escritura: pedido general ─────────────────────────────────────

// PUT /api/grilla/general — cantidad de un ítem que no va por persona.
router.put('/general', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const fecha = String(body.fecha || '').trim();
    const errFecha = errorFechaEditable(fecha);
    if (errFecha) return res.status(400).json({ error: errFecha });

    // Cualquier plato activo del catálogo, de cualquier categoría: el pedido
    // general no se limita a 'General' (sopa, jugo), también lleva wraps,
    // sándwiches y ensaladas pedidos por cantidad y no por colaborador.
    const plato_id = Number(body.plato_id);
    if (!Number.isInteger(plato_id) || !(await platos.idsActivosTodos([plato_id])).has(plato_id)) {
      return res.status(400).json({ error: 'El ítem del pedido general es inválido o está inactivo' });
    }

    const cantidad = Number(body.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor o igual a 0' });
    }

    const fila = await grilla.setGeneral(emp.empresa, fecha, plato_id, cantidad, req.user);
    const envios = await reenviarPorFechas(emp.empresa, [fecha], req.user);
    res.json({ general: fila, envios });
  } catch (err) { next(err); }
});

// ── Escritura: planes ─────────────────────────────────────────────

// POST /api/grilla/planes — alta de uno o varios colaboradores al comedor.
// fecha_alta puede ser pasada (alguien que empezó la semana anterior y se
// carga ahora). Lo que impide que eso reescriba lo ya entregado NO es el filtro
// de semanas —la semana en curso incluye días que ya pasaron—, sino que
// conciliarLineas deja intactas las líneas con fecha anterior a hoy.
router.post('/planes', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const crudos = Array.isArray(body.cliente_ids) ? body.cliente_ids : [body.cliente_id];
    const ids = [...new Set(crudos.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Indicá al menos un colaborador' });
    if (ids.length > MAX_ALTAS) return res.status(400).json({ error: `No se pueden dar de alta más de ${MAX_ALTAS} colaboradores por vez` });

    const plato_base_id = Number(body.plato_base_id);
    if (!Number.isInteger(plato_base_id) || !(await platos.idsActivos([plato_base_id])).has(plato_base_id)) {
      return res.status(400).json({ error: 'El plato base es inválido, está inactivo o es un ítem del pedido general' });
    }

    const fecha_alta = String(body.fecha_alta || '').trim();
    if (!fechaReal(fecha_alta)) return res.status(400).json({ error: 'Fecha de alta inválida (formato YYYY-MM-DD)' });

    const observacion = body.observacion ? String(body.observacion).trim().slice(0, 500) : null;

    // Todos tienen que ser clientes de esta empresa, y ninguno puede tener ya
    // un plan vigente: reincorporar a alguien dado de baja sí vale, pisar el
    // plan de alguien activo no.
    const revision = await grilla.revisarAlta(emp.empresa, ids);
    const errores = [];
    for (const id of ids) {
      const cliente = revision.get(id);
      if (!cliente) { errores.push(`El colaborador #${id} no existe`); continue; }
      if (cliente.empresa !== emp.empresa) { errores.push(`${cliente.nombre_completo} no pertenece a ${emp.empresa}`); continue; }
      if (cliente.es_cuenta_empresa) { errores.push('La cuenta de la empresa no puede sumarse al plan como colaborador'); continue; }
      if (cliente.plan_vigente) errores.push(`${cliente.nombre_completo} ya tiene un plan vigente`);
    }
    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    const planes = await grilla.crearPlanes(ids, { plato_base_id, observacion, fecha_alta }, req.user);
    const envios = await reenviarPlan(emp.empresa, req.user);

    res.status(201).json({ planes, envios });
  } catch (err) { next(err); }
});

// PATCH /api/grilla/planes/:cliente_id — cambiar plato base, observación o dar
// de baja. fecha_baja es EXCLUSIVA: es el primer día que la persona ya no come.
router.patch('/planes/:cliente_id', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const { plan, error: errCol } = await resolverColaborador(emp.empresa, req.params.cliente_id);
    if (errCol) return res.status(404).json({ error: errCol });

    const CAMPOS_EDITABLES = ['plato_base_id', 'observacion', 'fecha_baja'];
    const provistos = CAMPOS_EDITABLES.filter(campo => body[campo] !== undefined);
    if (!provistos.length) {
      return res.status(400).json({ error: 'Indicá al menos un campo a modificar (plato_base_id, observacion o fecha_baja)' });
    }

    const cambios = {};
    const errores = [];

    if (provistos.includes('plato_base_id')) {
      const plato_base_id = Number(body.plato_base_id);
      if (!Number.isInteger(plato_base_id) || !(await platos.idsActivos([plato_base_id])).has(plato_base_id)) {
        errores.push('El plato base es inválido, está inactivo o es un ítem del pedido general');
      } else cambios.plato_base_id = plato_base_id;
    }

    if (provistos.includes('observacion')) {
      cambios.observacion = body.observacion ? String(body.observacion).trim().slice(0, 500) : null;
    }

    if (provistos.includes('fecha_baja')) {
      // null o '' deshace la baja y reincorpora al colaborador.
      if (body.fecha_baja === null || body.fecha_baja === '') {
        cambios.fecha_baja = null;
      } else {
        const fecha_baja = String(body.fecha_baja).trim();
        if (!fechaReal(fecha_baja)) errores.push('Fecha de baja inválida (formato YYYY-MM-DD)');
        else if (fecha_baja < plan.fecha_alta) errores.push('La fecha de baja no puede ser anterior al alta');
        // Una baja retroactiva diría que la persona no comió días que cocina
        // ya produjo y que probablemente ya retiró. Para corregir el pasado
        // hay que ir a la base, no a la grilla.
        else if (fecha_baja < grilla.hoyISO()) errores.push('La fecha de baja no puede ser anterior a hoy');
        else cambios.fecha_baja = fecha_baja;
      }
    }

    if (errores.length) return res.status(400).json({ error: errores.join('. ') });

    const actualizado = await grilla.actualizarPlan(plan.cliente_id, cambios, req.user);
    const envios = await reenviarPlan(emp.empresa, req.user);

    res.json({ plan: actualizado, envios });
  } catch (err) { next(err); }
});

// ── Envío a cocina ────────────────────────────────────────────────

// POST /api/grilla/enviar — crea (o actualiza) el pedido semanal de la empresa
// y lo espeja hacia Narma Pedidos. Es idempotente: reenviar la misma semana
// deja el pedido igual a los totales de ese momento.
router.post('/enviar', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const { lunes, error } = resolverLunes(body.lunes);
    if (error) return res.status(400).json({ error });

    // Una semana cuyo viernes ya pasó no se manda a cocina: no queda ningún
    // día por producir, y los días pasados son de solo lectura.
    if (grilla.semanaTerminada(lunes)) {
      return res.status(400).json({ error: 'Esa semana ya terminó: no se puede enviar a cocina' });
    }

    const resultado = await grilla.enviarSemana(emp.empresa, lunes, req.user);
    if (!resultado.ok) {
      const MOTIVOS = {
        empresa_sin_grilla: 'Esa empresa no tiene grilla de comedor configurada',
        ubicacion_ajena: 'La ubicación configurada en grilla_empresas no pertenece al cliente cuenta-empresa. Corregila antes de enviar.',
      };
      return res.status(400).json({ error: MOTIVOS[resultado.motivo] || 'No se pudo enviar la semana', detalle: resultado });
    }

    // El pedido ya está guardado. Si el espejado falló, queda en sync_errores
    // y la respuesta lo informa, pero no se deshace nada (igual que la fase 6).
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/grilla/reintentar-sync — reintenta SOLO el espejado hacia Narma
// Pedidos del pedido semanal ya creado. No recalcula la grilla: para eso está
// POST /enviar.
router.post('/reintentar-sync', requireEditarGrilla, async (req, res, next) => {
  try {
    const body = req.body || {};
    const emp = await resolverEmpresa(req, res, body.empresa, { paraEditar: true });
    if (!emp) return;

    const { lunes, error } = resolverLunes(body.lunes);
    if (error) return res.status(400).json({ error });

    const pedido = await grilla.getPedidoSemana(emp.empresa, lunes);
    if (!pedido) return res.status(404).json({ error: 'Esa semana todavía no fue enviada a cocina' });

    // Bajo el mismo lock de semana que usa enviarSemana: un reintento manual
    // puede coincidir con un reenvío automático, y sin el lock el que lee
    // primero podría espejar un estado más viejo.
    const sync = await grilla.sincronizarConLock(emp.empresa, lunes, pedido.id);
    await grilla.auditar(
      req.user.id, 'grilla_envio', grilla.claveSemana(emp.empresa, lunes), null,
      { pedido_id: pedido.id, reintento: true, sync }
    );

    res.json({ ok: true, pedido, sync });
  } catch (err) { next(err); }
});

module.exports = router;
