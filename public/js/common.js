// Helpers compartidos por todas las vistas del CRM Närma

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

function initials(nombre) {
  if (!nombre) return '?';
  const partes = nombre.trim().split(/\s+/);
  return (partes[0][0] + (partes[1] ? partes[1][0] : '')).toUpperCase();
}

const ESTADO_LABEL = { activo: 'Activo', pausado: 'Pausado', inactivo: 'Inactivo', baja: 'Baja' };
const SEGMENTO_LABEL = { particular: 'Particular', empresa: 'Empresa' };
const CANAL_LABEL = {
  whatsapp: 'WhatsApp', redes: 'Redes sociales', embajador: 'Embajador',
  boca_a_boca: 'Boca a boca', b2b: 'B2B', otro: 'Otro',
};
const MEDIO_PAGO_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', pos: 'POS' };
const ESTADO_PAGO_LABEL = { pagado: 'Pagado', pendiente: 'Pendiente' };
const TIPO_VIANDA_LABEL = { economico: 'Económico', saludable: 'Saludable', low_carb: 'Low Carb' };

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
  if (CURRENT_USER.rol === 'admin') {
    links.push(['/dashboard', 'Dashboard']);
  } else {
    links.push(['/inicio', 'Inicio']);
  }
  links.push(['/clientes', 'Clientes']);

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
