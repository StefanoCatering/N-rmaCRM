// Helpers compartidos por todas las vistas del CRM Närma

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);

  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = '/login';
    return new Promise(() => {});
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function fmtGs(n) {
  if (n === null || n === undefined) return '—';
  return 'Gs. ' + Math.round(n).toLocaleString('es-PY');
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// La ventana de entrega de un pedido, como la muestran el listado, el modal de
// edición y el encabezado del detalle: una sola fecha cuando empieza y termina
// el mismo día, el rango cuando no, y "—" cuando el pedido no tiene entrega
// cargada (ver entregaEfectiva en models/pedidos.js).
// Si de la ventana se conoce una sola punta, se la muestra como un día suelto
// en lugar de dejar un "→ —" colgado.
function fmtEntrega(desde, hasta) {
  const d = desde || hasta;
  const h = hasta || desde;
  if (!d) return '—';
  if (String(d).slice(0, 10) === String(h).slice(0, 10)) return fmtFecha(d);
  return `${fmtFecha(d)} → ${fmtFecha(h)}`;
}

// ── Días hábiles de un rango ──────────────────────────────────────
// Misma definición que expandirHabiles en models/pedidoDetalle.js: lunes a
// viernes, bordes incluidos. Una línea recurrente entrega su cantidad en CADA
// uno de estos días, así que es lo que multiplica el total que se muestra al
// cargarla.
//
// La aritmética va en UTC (sumar 86.400.000 ms es exacto porque UTC no tiene
// horario de verano) para que el huso de la máquina del navegador no corra un
// día, igual que en el backend. Las semanas completas se cuentan de una
// (7 días = 5 hábiles) y solo el resto —a lo sumo 6 días— se recorre, así un
// rango mal tipeado (2026 → 2036) no cuelga la pantalla.
const UN_DIA_MS_UI = 24 * 60 * 60 * 1000;

function msUTCDesdeISO(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function contarHabiles(desdeISO, hastaISO) {
  if (!desdeISO || !hastaISO) return 0;
  const inicio = msUTCDesdeISO(desdeISO);
  const fin = msUTCDesdeISO(hastaISO);
  if (!Number.isFinite(inicio) || !Number.isFinite(fin) || fin < inicio) return 0;

  const dias = Math.round((fin - inicio) / UN_DIA_MS_UI) + 1;
  const semanas = Math.floor(dias / 7);
  let habiles = semanas * 5;
  for (let i = semanas * 7; i < dias; i++) {
    const dow = new Date(inicio + i * UN_DIA_MS_UI).getUTCDay();
    if (dow >= 1 && dow <= 5) habiles++;
  }
  return habiles;
}

// El texto que acompaña a "Cantidad por día" en una línea recurrente: la
// cantidad se repite en cada día hábil del rango, así que lo que importa saber
// antes de guardar es el TOTAL de viandas que se van a producir.
// Devuelve '' cuando todavía no hay con qué calcularlo (sin fechas o sin
// cantidad), para no mostrar un cálculo a medias.
function textoTotalRecurrente(desdeISO, hastaISO, cantidad) {
  const c = Number(cantidad);
  if (!desdeISO || !hastaISO || !Number.isFinite(c) || c <= 0) return '';
  const dias = contarHabiles(desdeISO, hastaISO);
  if (!dias) return '';
  const total = dias * c;
  return `${dias} día${dias === 1 ? '' : 's'} hábil${dias === 1 ? '' : 'es'}`
    + ` × ${c} = ${total} vianda${total === 1 ? '' : 's'}`;
}

function initials(nombre) {
  if (!nombre) return '?';
  const partes = nombre.trim().split(/\s+/);
  return (partes[0][0] + (partes[1] ? partes[1][0] : '')).toUpperCase();
}

const ESTADO_LABEL = { activo: 'Activo', pausado: 'Pausado', inactivo: 'Inactivo', baja: 'Baja' };
// 'empresa' es el valor que vive en la base; "Corporativo" es solo la etiqueta visible.
const SEGMENTO_LABEL = { particular: 'Particular', empresa: 'Corporativo', embajador: 'Embajador' };
const CANAL_LABEL = {
  whatsapp: 'WhatsApp', redes: 'Redes sociales', embajador: 'Embajador',
  boca_a_boca: 'Boca a boca', b2b: 'B2B', otro: 'Otro',
};
const MEDIO_PAGO_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', pos: 'POS', cortesia: 'Cortesía' };
const ESTADO_PAGO_LABEL = { pagado: 'Pagado', pendiente: 'Pendiente', parcial: 'Parcial' };
// Acciones de pedidos_auditoria. Las claves son los valores del CHECK de
// pedidos_auditoria.accion: si se agrega una, va en los dos lados.
// 'creacion' y 'pago' no llevan motivo (ver fase 8).
const ACCION_LABEL = {
  creacion: 'Creación', edicion: 'Edición', cancelacion: 'Cancelación', pago: 'Pago',
};
const TIPO_VIANDA_LABEL = { economico: 'Económico', saludable: 'Saludable', low_carb: 'Low Carb', modificacion_menu: 'Modificación de menú' };
// Motivos de ausencia de la grilla de comedor. Las claves son los valores del
// CHECK de grilla_celdas.ausencia: si se agrega uno, va en los dos lados.
const AUSENCIA_LABEL = {
  home_office: 'Home office', vacaciones: 'Vacaciones', reposo: 'Reposo',
  licencia: 'Licencia', otro: 'Otro',
};

function badgeEstado(estado) {
  return `<span class="badge badge-${estado}">${ESTADO_LABEL[estado] || estado}</span>`;
}

function badgeEstadoPago(estado) {
  if (!estado) return '—';
  return `<span class="badge badge-pago-${estado}">${ESTADO_PAGO_LABEL[estado] || estado}</span>`;
}

function diasSinPedirLabel(dias) {
  if (dias === null || dias === undefined) return '<span class="text-muted">Sin pedidos</span>';
  return `${dias} día${dias === 1 ? '' : 's'}`;
}

let CURRENT_USER = null;

async function ensureSession() {
  try {
    const data = await api('/api/me');
    CURRENT_USER = data.user;
    window.ALERT_DAYS = data.alertDays;
    return data.user;
  } catch (e) {
    window.location.href = '/login';
    return null;
  }
}

function renderNav(activeHref) {
  const cont = document.getElementById('nav');
  if (!cont || !CURRENT_USER) return;

  const links = [];

  // El rol 'comedor' tiene UNA pantalla y su cuenta, y nada más: el resto le
  // daría 403 (la lista blanca de requireAuth en server.js). Sale temprano
  // para no tener que negarlo en cada link de abajo.
  if (CURRENT_USER.rol === 'comedor') {
    pintarNav(cont, [['/retiros', 'Retiros'], ['/cuenta', 'Mi cuenta']], activeHref);
    return;
  }

  // Solo el operador: /inicio es requireAuth('operador'), para admin/visor daría 403.
  if (CURRENT_USER.rol === 'operador') {
    links.push(['/inicio', 'Inicio']);
  }
  if (CURRENT_USER.rol === 'admin' || CURRENT_USER.rol === 'visor') {
    links.push(['/dashboard', 'Dashboard']);
  }
  links.push(['/clientes', 'Clientes']);
  if (CURRENT_USER.rol === 'admin' || CURRENT_USER.rol === 'operador') {
    links.push(['/pedidos', 'Pedidos']);
  }
  // El resumen del día lo ven los tres roles: es solo lectura y es la hoja con
  // la que se controla, la noche anterior, lo que va a producir cocina.
  links.push(['/resumen', 'Resumen']);
  // La grilla la ven admin, visor y quien tenga gestiona_grilla (que puede ser
  // un operador: es un permiso aparte del rol). Para el resto, ni aparece.
  if (CURRENT_USER.rol === 'admin' || CURRENT_USER.rol === 'visor' || CURRENT_USER.gestiona_grilla) {
    links.push(['/grilla', 'Grilla']);
  }
  // Los retiros del comedor los ven admin y visor además del rol comedor. Es
  // la contracara de la grilla: la grilla dice qué se produce, los retiros
  // dicen qué se entregó.
  if (CURRENT_USER.rol === 'admin' || CURRENT_USER.rol === 'visor') {
    links.push(['/retiros', 'Retiros']);
  }
  // Su propia cuenta la tiene cualquier usuario logueado, visor incluido.
  links.push(['/cuenta', 'Mi cuenta']);

  pintarNav(cont, links, activeHref);
}

function pintarNav(cont, links, activeHref) {
  const linksHtml = links.map(([href, label]) => {
    const active = href === activeHref ? ' active' : '';
    return `<a class="nav-btn${active}" href="${href}">${label}</a>`;
  }).join('');

  cont.innerHTML = `
    <span class="nav-logo">när<span>ma</span> <span style="font-size:9px;color:rgba(240,235,231,0.4);font-weight:400;">crm</span></span>
    ${linksHtml}
    <div style="flex:1;"></div>
    <span class="nav-usuario">${CURRENT_USER.username} · ${CURRENT_USER.rol}</span>
    <button class="nav-btn nav-btn-salir" id="btn-salir">Salir</button>
  `;
  document.getElementById('btn-salir').addEventListener('click', cerrarSesion);
}

async function cerrarSesion() {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}
