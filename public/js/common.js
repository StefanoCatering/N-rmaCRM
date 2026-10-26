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

// ── A quién se factura (fase 13) ──────────────────────────────────
// Un control compartido por el form de cliente y el form de pedido: los dos
// preguntan lo mismo (mismo cliente / otro cliente / otros datos) y el pedido
// agrega una opción más ("según el cliente"). Está acá y no copiado en las dos
// vistas para que elegir el destinatario se vea y se valide igual en las dos.
//
// Las reglas de validación de verdad son las del backend
// (models/facturacion.js); lo de acá solo evita el viaje para pedir algo que
// ya se sabe que falta.

// Cómo se muestra una facturación ya resuelta, en una línea: el nombre y el
// RUC, o el aviso de que falta. Lo usan la ficha del cliente y el detalle del
// pedido, que tienen que leerse igual.
function fmtFacturacion(f) {
  if (!f) return '—';
  const nombre = f.nombre || f.cliente_nombre || '';
  if (!nombre && !f.ruc) return '<span class="text-muted">Sin datos de facturación cargados</span>';
  const ruc = f.ruc
    ? 'RUC ' + escapeHtml(f.ruc)
    : '<span class="text-muted">sin RUC cargado</span>';
  const quien = nombre ? escapeHtml(nombre) : '<span class="text-muted">sin razón social</span>';
  return quien + ' · ' + ruc;
}

// Dibuja el control dentro de `contenedorId`.
// opciones:
//   prefijo         → prefijo de los ids que genera (único por pantalla)
//   conSegunCliente → true en un pedido: agrega la opción por defecto
//                     "Según el cliente", que es factura_a = null
//   excluirId       → id de cliente que no puede elegirse como "otro cliente"
function montarFacturacionDestino(contenedorId, opciones) {
  const { prefijo, conSegunCliente = false, excluirId = null } = opciones || {};
  const p = prefijo;
  const cont = document.getElementById(contenedorId);
  if (!cont) return;

  cont.dataset.excluirId = excluirId === null ? '' : String(excluirId);
  cont.dataset.prefijo = p;
  cont.innerHTML = [
    conSegunCliente ? opcionFacturacion(p, 'segun_cliente', 'Según el cliente') : '',
    opcionFacturacion(p, 'mismo', conSegunCliente ? 'Mismo cliente del pedido' : 'Mismo cliente'),
    opcionFacturacion(p, 'otro_cliente', 'Otro cliente'),
    opcionFacturacion(p, 'otros', 'Otros datos'),
    '<div class="nota mt-8" id="' + p + '-resumen"></div>',

    '<div class="hidden mt-8" id="' + p + '-grupo-cliente" style="position:relative;">',
    '  <label class="form-label">Cliente al que se le factura</label>',
    '  <input type="text" id="' + p + '-buscar" placeholder="Buscar por nombre o cédula..." autocomplete="off"/>',
    '  <div id="' + p + '-resultados" class="card hidden" style="position:absolute;z-index:10;width:100%;margin-top:4px;padding:6px;max-height:200px;overflow-y:auto;"></div>',
    '  <input type="hidden" id="' + p + '-cliente-id"/>',
    '  <div class="nota mt-8 hidden" id="' + p + '-elegido"></div>',
    '</div>',

    '<div class="hidden mt-8" id="' + p + '-grupo-otros">',
    '  <div class="form-row">',
    '    <div class="form-group">',
    '      <label class="form-label">Razón social</label>',
    '      <input type="text" id="' + p + '-razon-social" placeholder="Ej: Comercial San Juan S.A."/>',
    '    </div>',
    '    <div class="form-group">',
    '      <label class="form-label">RUC</label>',
    '      <input type="text" id="' + p + '-ruc" maxlength="20" placeholder="Ej: 80012345-6"/>',
    '    </div>',
    '  </div>',
    '  <div class="form-group">',
    '    <label class="form-label">Email para la factura</label>',
    '    <input type="email" id="' + p + '-email" placeholder="facturacion@ejemplo.com"/>',
    '  </div>',
    '</div>',
  ].join('\n');

  cont.querySelectorAll('input[name="' + p + '-modo"]').forEach(function (r) {
    r.addEventListener('change', function () { refrescarFacturacionDestino(p); });
  });

  // Buscador de clientes: el mismo endpoint que usa el alta de pedido. No se
  // filtra por activos — el marido al que va la factura puede no pedir nunca
  // nada y estar inactivo, y la factura igual va a su nombre.
  const buscar = document.getElementById(p + '-buscar');
  let timer = null;
  buscar.addEventListener('input', function () {
    document.getElementById(p + '-cliente-id').value = '';
    document.getElementById(p + '-elegido').classList.add('hidden');
    clearTimeout(timer);
    const q = buscar.value.trim();
    if (!q) { document.getElementById(p + '-resultados').classList.add('hidden'); return; }
    timer = setTimeout(function () { buscarClientesFacturacion(contenedorId, p, q); }, 250);
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#' + p + '-resultados') && e.target.id !== p + '-buscar') {
      document.getElementById(p + '-resultados').classList.add('hidden');
    }
  });

  const porDefecto = conSegunCliente ? 'segun_cliente' : 'mismo';
  cont.querySelector('input[name="' + p + '-modo"][value="' + porDefecto + '"]').checked = true;
  refrescarFacturacionDestino(p);
}

function opcionFacturacion(p, valor, etiqueta) {
  return '<label class="form-label" style="font-weight:normal;text-transform:none;display:block;">'
    + '<input type="radio" name="' + p + '-modo" value="' + valor + '"/> ' + etiqueta
    + '</label>';
}

function modoFacturacion(p) {
  const marcado = document.querySelector('input[name="' + p + '-modo"]:checked');
  return marcado ? marcado.value : 'mismo';
}

function refrescarFacturacionDestino(p) {
  const modo = modoFacturacion(p);
  document.getElementById(p + '-grupo-cliente').classList.toggle('hidden', modo !== 'otro_cliente');
  document.getElementById(p + '-grupo-otros').classList.toggle('hidden', modo !== 'otros');
}

async function buscarClientesFacturacion(contenedorId, p, q) {
  const cont = document.getElementById(p + '-resultados');
  const excluir = document.getElementById(contenedorId).dataset.excluirId;
  let encontrados = [];
  try {
    encontrados = (await api('/api/clientes?q=' + encodeURIComponent(q))).clientes;
  } catch (e) {
    cont.innerHTML = '<div class="empty-state" style="padding:10px;">No se pudo buscar.</div>';
    cont.classList.remove('hidden');
    return;
  }

  const candidatos = encontrados.filter(function (c) { return String(c.id) !== String(excluir); }).slice(0, 8);
  if (!candidatos.length) {
    cont.innerHTML = '<div class="empty-state" style="padding:10px;">Sin resultados.</div>';
  } else {
    cont.innerHTML = candidatos.map(function (c) {
      return '<div class="fact-resultado" data-id="' + c.id + '"'
        + ' data-nombre="' + escapeHtml(c.nombre_completo) + '"'
        + ' data-ruc="' + escapeHtml(c.ruc || '') + '"'
        + ' style="padding:8px 10px;cursor:pointer;border-radius:8px;font-size:11px;">'
        + '<strong>' + escapeHtml(c.nombre_completo) + '</strong>'
        + ' <span class="text-muted">· ' + escapeHtml(c.cedula || '') + ' · '
        + (c.ruc ? 'RUC ' + escapeHtml(c.ruc) : 'sin RUC cargado') + '</span>'
        + '</div>';
    }).join('');
    cont.querySelectorAll('.fact-resultado').forEach(function (el) {
      el.addEventListener('mouseenter', function () { el.style.background = 'var(--beige)'; });
      el.addEventListener('mouseleave', function () { el.style.background = ''; });
      el.addEventListener('click', function () {
        elegirClienteFacturacion(p, el.dataset.id, el.dataset.nombre, el.dataset.ruc);
      });
    });
  }
  cont.classList.remove('hidden');
}

function elegirClienteFacturacion(p, id, nombre, ruc) {
  document.getElementById(p + '-cliente-id').value = id;
  document.getElementById(p + '-buscar').value = '';
  document.getElementById(p + '-resultados').classList.add('hidden');
  const box = document.getElementById(p + '-elegido');
  box.innerHTML = 'Se factura a <strong>' + escapeHtml(nombre) + '</strong> · '
    + (ruc
      ? 'RUC ' + escapeHtml(ruc)
      : '<strong>sin RUC cargado</strong> (se puede cargar después, en la ficha de esa persona)');
  box.classList.remove('hidden');
}

// Deja el control mostrando una facturación ya guardada.
// valores: las cinco columnas tal cual están en la base y, opcionales,
// cliente_nombre / cliente_ruc del elegido, para poder mostrarlo sin ir a
// buscarlo de nuevo.
function setFacturacionDestino(p, valores) {
  const v = valores || {};
  const tieneSegunCliente = !!document.querySelector('input[name="' + p + '-modo"][value="segun_cliente"]');
  const modo = v.factura_a || (tieneSegunCliente ? 'segun_cliente' : 'mismo');
  const radio = document.querySelector('input[name="' + p + '-modo"][value="' + modo + '"]');
  if (radio) radio.checked = true;

  if (modo === 'otro_cliente' && v.factura_cliente_id) {
    elegirClienteFacturacion(
      p, v.factura_cliente_id,
      v.cliente_nombre || ('Cliente #' + v.factura_cliente_id),
      v.cliente_ruc || ''
    );
  }
  if (modo === 'otros') {
    document.getElementById(p + '-razon-social').value = v.factura_razon_social || '';
    document.getElementById(p + '-ruc').value = v.factura_ruc || '';
    document.getElementById(p + '-email').value = v.factura_email || '';
  }
  refrescarFacturacionDestino(p);
}

// Qué no puede elegirse como "otro cliente". En el form de pedido cambia al
// elegir el cliente del pedido.
function setFacturacionExcluido(contenedorId, id) {
  const cont = document.getElementById(contenedorId);
  if (cont) cont.dataset.excluirId = (id === null || id === undefined) ? '' : String(id);
}

// La línea gris que dice a quién iría la factura si no se toca nada.
function setFacturacionResumen(p, html) {
  const box = document.getElementById(p + '-resumen');
  if (box) box.innerHTML = html || '';
}

// Lo que va al body del request. Devuelve { datos } o { error }.
// Las mismas dos reglas que exige el backend: razón social y RUC obligatorios
// en "otros datos", y un cliente elegido en "otro cliente".
function leerFacturacionDestino(p) {
  const modo = modoFacturacion(p);

  if (modo === 'segun_cliente') return { datos: { factura_a: null } };
  if (modo === 'mismo') return { datos: { factura_a: 'mismo' } };

  if (modo === 'otro_cliente') {
    const id = document.getElementById(p + '-cliente-id').value;
    if (!id) return { error: 'Elegí el cliente al que se le factura.' };
    return { datos: { factura_a: 'otro_cliente', factura_cliente_id: Number(id) } };
  }

  const razon = document.getElementById(p + '-razon-social').value.trim();
  const ruc = document.getElementById(p + '-ruc').value.trim();
  const email = document.getElementById(p + '-email').value.trim();
  if (!razon) return { error: 'La razón social es requerida cuando se factura a otros datos.' };
  if (!ruc) return { error: 'El RUC es requerido cuando se factura a otros datos.' };
  return {
    datos: {
      factura_a: 'otros',
      factura_razon_social: razon,
      factura_ruc: ruc,
      factura_email: email || null,
    },
  };
}
