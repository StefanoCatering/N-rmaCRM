// Validaciones del alta de un plan de comedor, compartidas por las DOS rutas
// que pueden crear uno (fase 12):
//   POST /api/grilla/planes  — el alta de siempre, desde la grilla
//   POST /api/clientes       — el alta de cliente con "Figura en la grilla"
//
// Viven acá y no duplicadas en cada ruta para que las dos exijan exactamente lo
// mismo: la empresa tiene que tener grilla y estar activa, el plato base tiene
// que ser un plato por persona activo, y la fecha de alta tiene que existir de
// verdad. Si mañana cambia una de esas reglas, cambia para las dos.
//
// Ninguna de estas funciones toca `res`: devuelven { error, status } y es la
// ruta la que responde. Así la del cliente puede abortar su transacción antes
// de crear nada.
const grilla = require('../models/grilla');
const platos = require('../models/platos');

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// FECHA_RE deja pasar fechas que no existen ('2026-02-31'). Postgres las
// rechazaría con un 500; acá se devuelve un 400 entendible.
function fechaReal(iso) {
  if (!FECHA_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// La empresa del request, resuelta contra grilla_empresas.
// Devuelve { emp } o { status, error }.
//
// La búsqueda es por nombre EXACTO, igual que todo lo demás de la grilla
// (cargarSemana filtra con clientes.empresa = $1): si se aceptara una variante
// de mayúsculas, el plan quedaría creado y la persona no aparecería en ninguna
// grilla. Quien llama se encarga de mandar el nombre tal cual está cargado.
async function resolverEmpresaGrilla(valor, { paraEditar = false } = {}) {
  const empresa = String(valor || '').trim();
  if (!empresa) return { status: 400, error: 'La empresa es requerida' };

  const emp = await grilla.getEmpresa(empresa);
  if (!emp) return { status: 404, error: 'Esa empresa no tiene grilla de comedor configurada' };
  if (paraEditar && !emp.activa) return { status: 400, error: 'La grilla de esa empresa está desactivada' };

  return { emp };
}

// El plato base de un plan: un plato activo que no sea de la categoría
// 'General' (esos van al pedido general, no al plato de una persona).
// Devuelve { plato_base_id } o { error }.
async function validarPlatoBase(valor) {
  const plato_base_id = Number(valor);
  if (!Number.isInteger(plato_base_id) || !(await platos.idsActivos([plato_base_id])).has(plato_base_id)) {
    return { error: 'El plato base es inválido, está inactivo o es un ítem del pedido general' };
  }
  return { plato_base_id };
}

// Los tres datos del plan en sí. Devuelve { datos } o { error }.
//
// fecha_alta puede ser pasada (alguien que empezó la semana anterior y se carga
// ahora). Lo que impide que eso reescriba lo ya entregado NO es ninguna
// validación de acá, sino que conciliarLineas deja intactas las líneas con
// fecha anterior a hoy.
async function validarDatosPlan(body) {
  const { plato_base_id, error } = await validarPlatoBase(body.plato_base_id);
  if (error) return { error };

  const fecha_alta = String(body.fecha_alta || '').trim();
  if (!fechaReal(fecha_alta)) return { error: 'Fecha de alta inválida (formato YYYY-MM-DD)' };

  const observacion = body.observacion ? String(body.observacion).trim().slice(0, 500) : null;

  return { datos: { plato_base_id, fecha_alta, observacion } };
}

// Un cambio de plan (alta, plato base, observación, baja) puede afectar
// cualquier día: se reenvían todas las semanas ya enviadas de hoy en adelante.
// Las semanas pasadas no se tocan — ya se entregaron.
//
// Va SIEMPRE después del COMMIT: reenviarSiCorresponde habla con la base de
// Narma Pedidos y nunca lanza, así que un reenvío fallido no puede deshacer un
// plan que ya se guardó.
async function reenviarPlan(empresa, usuario) {
  const desde = grilla.lunesDe(grilla.hoyISO());
  const semanas = await grilla.semanasEnviadas(empresa, { desde });
  return grilla.reenviarSiCorresponde(empresa, semanas, usuario);
}

module.exports = {
  FECHA_RE, fechaReal,
  resolverEmpresaGrilla, validarPlatoBase, validarDatosPlan, reenviarPlan,
};
