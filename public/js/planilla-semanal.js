// Planilla semanal de líneas de pedido — compartida por el alta de pedido y
// por el detalle de un pedido existente (fase 14).
//
// Para qué: cargar rápido una semana irregular. "Lunes 1 Saludable + 1 Low
// carb, martes 2 Saludable, miércoles 1 Saludable + 1 Pollo grillé" son cinco
// líneas puntuales que a mano se cargan de una en una. Acá es una tabla:
// un renglón por plato, una columna por día, y se tipea la cantidad.
//
// Lo que produce son LÍNEAS PUNTUALES normales: la planilla no es un modo de
// pedido nuevo ni toca el backend. Cada casilla > 0 se convierte en
// { plato_id, cantidad, modo: 'puntual', fecha_entrega }, y se envían en el
// mismo POST que las líneas sueltas.
//
// Dos reglas que vienen del negocio y no de la pantalla:
//   · De lunes a viernes, nada más: no hay sábado ni domingo (la misma
//     definición de día hábil que expandirHabiles en models/pedidoDetalle.js).
//   · Solo los días POSTERIORES a hoy son cargables. Lo de hoy ya se produjo
//     de madrugada, así que ofrecer cargarlo sería mentir. Hoy y los días
//     anteriores se ven grisados, con el input deshabilitado, y nunca generan
//     una línea aunque algo quedara escrito.
//
// API:
//   montarPlanilla(contenedor, { catalogo, etiquetaEnvase, onCambio })
//   leerPlanilla(contenedor)   → { lineas, error }
//   resumenPlanilla(contenedor) → { lineas, viandas }
//   vaciarPlanilla(contenedor)
//   actualizarEtiquetaEnvasePlanilla(texto, contenedor)
// El contenedor es opcional en todas menos en montarPlanilla: cada pantalla
// monta una sola planilla y se usa esa.

const PLANILLAS = new Map();
let PLANILLA_ULTIMA = null;

const PLANILLA_DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie'];
const PLANILLA_ENVASES = ['Narma', 'Venezia'];
// Columnas de la tabla: plato + 5 días + ⟲ + total. Lo usa el colspan de la
// fila de "más opciones", que se tiene que estirar de punta a punta.
const PLANILLA_COLUMNAS = 8;

// ── Fechas ────────────────────────────────────────────────────────
// La aritmética va en UTC, igual que en contarHabiles (common.js) y en la
// grilla: sumar 86.400.000 ms es exacto porque UTC no tiene horario de verano.
// Lo único que se lee en hora local es HOY, porque "posterior a hoy" se
// decide con el día que ve quien está cargando el pedido.

function planillaISO(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function planillaSumarDias(iso, n) {
  return planillaISO(msUTCDesdeISO(iso) + n * UN_DIA_MS_UI);
}

function planillaDiaSemana(iso) {
  return new Date(msUTCDesdeISO(iso)).getUTCDay();
}

function planillaLunesDe(iso) {
  const d = planillaDiaSemana(iso);
  return planillaSumarDias(iso, d === 0 ? -6 : 1 - d);
}

function planillaHoy() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function planillaDiaMes(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

// La semana que se muestra al abrir: la primera cuyo lunes-a-viernes tenga al
// menos un día posterior a hoy. Un viernes, un sábado o un domingo eso ya cae
// en la semana que viene, que es justo lo que se va a cargar.
function planillaSemanaPorDefecto(hoy) {
  let lunes = planillaLunesDe(hoy);
  // Dos vueltas alcanzan siempre (el salto es de una semana), pero el límite
  // está para que un hoy inesperado no cuelgue la pantalla.
  for (let i = 0; i < 3; i++) {
    if (planillaSumarDias(lunes, 4) > hoy) return lunes;
    lunes = planillaSumarDias(lunes, 7);
  }
  return lunes;
}

// ── Montaje ───────────────────────────────────────────────────────

function montarPlanilla(contenedor, opciones) {
  const cont = planillaElemento(contenedor);
  if (!cont) return null;
  const { catalogo = [], etiquetaEnvase = '— Según el cliente —', onCambio = null } = opciones || {};

  const hoy = planillaHoy();
  const estado = {
    cont,
    catalogo,
    etiquetaEnvase,
    onCambio,
    hoy,
    lunes: planillaSemanaPorDefecto(hoy),
  };

  cont.innerHTML = [
    '<div class="planilla-barra">',
    '  <button type="button" class="btn-secondary planilla-nav" data-paso="-7" title="Semana anterior">◀</button>',
    '  <div class="planilla-semana"></div>',
    '  <button type="button" class="btn-secondary planilla-nav" data-paso="7" title="Semana siguiente">▶</button>',
    '</div>',
    '<div class="nota planilla-aviso hidden"></div>',
    '<div class="table-wrap">',
    '  <table class="planilla-tabla">',
    '    <thead><tr>',
    '      <th class="planilla-col-plato">Plato</th>',
    PLANILLA_DIAS.map((_, i) => `      <th class="planilla-col-dia" data-dia="${i}"></th>`).join('\n'),
    '      <th class="planilla-col-mini"></th>',
    '      <th class="planilla-col-total">Total</th>',
    '    </tr></thead>',
    '    <tfoot><tr class="planilla-fila-total">',
    '      <td>Total del día</td>',
    PLANILLA_DIAS.map((_, i) => `      <td class="planilla-total planilla-total-dia" data-dia="${i}">0</td>`).join('\n'),
    '      <td></td>',
    '      <td class="planilla-total planilla-total-general">0</td>',
    '    </tr></tfoot>',
    '  </table>',
    '</div>',
    '<button type="button" class="btn-secondary mt-8 planilla-agregar">+ agregar plato</button>',
  ].join('\n');

  // Cada renglón es su propio <tbody>, insertado antes del tfoot. Van sueltos
  // dentro de la tabla y NO dentro de otro tbody: un tbody anidado es HTML
  // inválido y el navegador lo saca del layout de la tabla, con lo que las
  // celdas dejan de alinearse con los encabezados.
  estado.tabla = cont.querySelector('.planilla-tabla');
  estado.pie = estado.tabla.querySelector('tfoot');

  cont.querySelectorAll('.planilla-nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      planillaIrASemana(estado, planillaSumarDias(estado.lunes, Number(btn.dataset.paso)));
    });
  });
  cont.querySelector('.planilla-agregar').addEventListener('click', () => {
    planillaAgregarRenglon(estado);
  });

  PLANILLAS.set(cont, estado);
  PLANILLA_ULTIMA = cont;

  planillaAgregarRenglon(estado);
  planillaRefrescar(estado);
  return estado;
}

function planillaElemento(ref) {
  if (!ref) return null;
  return typeof ref === 'string' ? document.getElementById(ref) : ref;
}

function planillaEstado(contenedor) {
  const cont = planillaElemento(contenedor) || PLANILLA_ULTIMA;
  return cont ? PLANILLAS.get(cont) || null : null;
}

// Los renglones, en el orden en el que se ven. Son los <tbody> de la tabla,
// uno por plato.
function planillaRenglones(estado) {
  return [...estado.tabla.querySelectorAll('tbody.planilla-renglon')];
}

// ── Renglones ─────────────────────────────────────────────────────

// Un renglón son DOS <tr> dentro de su propio <tbody>: el de las cantidades y
// el de "más opciones", plegado. Van juntos en un tbody para poder quitarlos
// de una y para que el orden del DOM —y con él el recorrido del Tab— sea
// plato, lunes a viernes, y después el renglón siguiente.
function planillaAgregarRenglon(estado) {
  const grupo = document.createElement('tbody');
  grupo.className = 'planilla-renglon';

  const celdas = PLANILLA_DIAS.map((_, i) => `
        <td class="planilla-td-dia" data-dia="${i}">
          <input type="number" class="planilla-cant" data-dia="${i}"
                 inputmode="numeric" min="0" step="1"/>
        </td>`).join('');

  grupo.innerHTML = `
    <tr>
      <td class="planilla-col-plato">
        <select class="planilla-plato"><option value="">— Elegir —</option>${planillaOpcionesPlatos(estado)}</select>
        <div class="planilla-acciones">
          <button type="button" class="planilla-mini planilla-opciones" tabindex="-1">más opciones</button>
          <button type="button" class="planilla-mini planilla-quitar" tabindex="-1">quitar</button>
        </div>
      </td>${celdas}
      <td class="planilla-col-mini">
        <button type="button" class="planilla-mini planilla-repetir" tabindex="-1"
                title="Copiar la primera cantidad cargada a todos los días cargables">⟲</button>
      </td>
      <td class="planilla-total planilla-total-renglon">0</td>
    </tr>
    <tr class="planilla-fila-opciones hidden">
      <td colspan="${PLANILLA_COLUMNAS}">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Envase</label>
            <select class="planilla-envase">
              <option value="">${escapeHtml(estado.etiquetaEnvase)}</option>
              ${PLANILLA_ENVASES.map((e) => `<option value="${e}">${e}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Comentario</label>
            <input type="text" class="planilla-comentario" placeholder="Ej: sin sal"/>
          </div>
        </div>
        <div class="nota">El envase y el comentario se aplican a todas las líneas de este renglón.</div>
      </td>
    </tr>
  `;

  grupo.querySelectorAll('.planilla-cant').forEach((input) => {
    input.addEventListener('input', () => planillaRecalcular(estado));
  });
  grupo.querySelector('.planilla-repetir').addEventListener('click', () => {
    planillaRepetir(estado, grupo);
  });
  grupo.querySelector('.planilla-opciones').addEventListener('click', (ev) => {
    const fila = grupo.querySelector('.planilla-fila-opciones');
    const plegada = fila.classList.toggle('hidden');
    ev.target.textContent = plegada ? 'más opciones' : 'menos opciones';
  });
  grupo.querySelector('.planilla-quitar').addEventListener('click', () => {
    planillaQuitarRenglon(estado, grupo);
  });

  estado.tabla.insertBefore(grupo, estado.pie);
  planillaAplicarDias(estado, grupo);
  planillaRecalcular(estado);
  return grupo;
}

// Siempre queda al menos un renglón: una tabla sin renglones no se entiende y
// obligaría a buscar "+ agregar plato" para volver a empezar.
function planillaQuitarRenglon(estado, grupo) {
  const renglones = planillaRenglones(estado);
  if (renglones.length <= 1) {
    grupo.querySelector('.planilla-plato').value = '';
    grupo.querySelector('.planilla-envase').value = '';
    grupo.querySelector('.planilla-comentario').value = '';
    grupo.querySelectorAll('.planilla-cant').forEach((i) => { i.value = ''; });
  } else {
    grupo.remove();
  }
  planillaRecalcular(estado);
}

function planillaOpcionesPlatos(estado) {
  return estado.catalogo.map((c) => `
    <optgroup label="${escapeHtml(c.categoria)}">
      ${c.platos.map((p) => `<option value="${p.id}">${escapeHtml(p.etiqueta)}</option>`).join('')}
    </optgroup>`).join('');
}

// ⟲ — la primera cantidad cargada del renglón, copiada a todos sus días
// cargables. Es el caso "lo mismo toda la semana", que es lo más común después
// de la semana irregular. Los días no cargables no se tocan.
function planillaRepetir(estado, grupo) {
  const inputs = [...grupo.querySelectorAll('.planilla-cant')];
  const primera = inputs.find((i) => i.value.trim() !== '');
  if (!primera) return;
  const valor = primera.value.trim();
  inputs.forEach((i) => { if (!i.disabled) i.value = valor; });
  planillaRecalcular(estado);
}

// ── Semana ────────────────────────────────────────────────────────

function planillaFechas(estado) {
  return PLANILLA_DIAS.map((_, i) => planillaSumarDias(estado.lunes, i));
}

function planillaCargable(estado, fecha) {
  return fecha > estado.hoy;
}

// Cambiar de semana borra las cantidades: son de los días de la semana que se
// está dejando y no significan nada en la nueva. Los platos y las opciones de
// cada renglón sí se conservan — es lo que se vuelve a usar.
function planillaIrASemana(estado, lunes) {
  if (planillaHayCantidades(estado)) {
    const ok = confirm(
      'Al cambiar de semana se vacían las cantidades cargadas.\n\n'
      + 'Los platos y las opciones de cada renglón se conservan.'
    );
    if (!ok) return;
  }
  estado.lunes = lunes;
  planillaVaciarCantidades(estado);
  planillaRefrescar(estado);
}

function planillaHayCantidades(estado) {
  return [...estado.cont.querySelectorAll('.planilla-cant')].some((i) => i.value.trim() !== '');
}

function planillaVaciarCantidades(estado) {
  estado.cont.querySelectorAll('.planilla-cant').forEach((i) => { i.value = ''; });
}

// Redibuja lo que depende de la semana: el título, los encabezados de día y
// qué casillas se pueden tocar.
function planillaRefrescar(estado) {
  const fechas = planillaFechas(estado);
  estado.cont.querySelector('.planilla-semana').textContent =
    'Semana del lunes ' + planillaDiaMes(estado.lunes);

  estado.cont.querySelectorAll('.planilla-col-dia').forEach((th) => {
    const i = Number(th.dataset.dia);
    const fecha = fechas[i];
    const cargable = planillaCargable(estado, fecha);
    th.innerHTML = `<div class="planilla-dia-nombre">${PLANILLA_DIAS[i]}</div>`
      + `<div class="planilla-dia-fecha">${planillaDiaMes(fecha)}</div>`;
    th.classList.toggle('planilla-dia-cerrado', !cargable);
  });

  planillaRenglones(estado).forEach((grupo) => {
    planillaAplicarDias(estado, grupo);
  });

  // Un día que ya se produjo no se puede pedir. Cuando la semana entera quedó
  // atrás no hay nada que cargar, y conviene decirlo en lugar de dejar una
  // tabla muda y toda grisada.
  const aviso = estado.cont.querySelector('.planilla-aviso');
  const cargables = fechas.filter((f) => planillaCargable(estado, f)).length;
  if (!cargables) {
    aviso.textContent = 'Esta semana ya pasó: no hay ningún día que se pueda cargar.';
    aviso.classList.remove('hidden');
  } else if (cargables < PLANILLA_DIAS.length) {
    aviso.textContent = 'Los días grisados son hoy y los anteriores: ya se produjeron de madrugada, '
      + 'así que no se pueden cargar desde acá.';
    aviso.classList.remove('hidden');
  } else {
    aviso.classList.add('hidden');
  }

  planillaRecalcular(estado);
}

function planillaAplicarDias(estado, grupo) {
  const fechas = planillaFechas(estado);
  grupo.querySelectorAll('.planilla-cant').forEach((input) => {
    const i = Number(input.dataset.dia);
    const cargable = planillaCargable(estado, fechas[i]);
    input.disabled = !cargable;
    input.title = cargable ? '' : 'Este día ya se produjo: no se puede cargar.';
    if (!cargable) input.value = '';
    input.closest('td').classList.toggle('planilla-td-cerrado', !cargable);
  });
}

// ── Totales ───────────────────────────────────────────────────────

// Cantidad de una casilla, para los totales en vivo. Lo que no es un entero
// válido cuenta como 0 acá; el error se da al leer la planilla para guardar,
// que es cuando importa.
function planillaCantidad(input) {
  const txt = input.value.trim();
  if (!/^\d+$/.test(txt)) return 0;
  return parseInt(txt, 10);
}

function planillaRecalcular(estado) {
  const fechas = planillaFechas(estado);
  const porDia = PLANILLA_DIAS.map(() => 0);
  let general = 0;

  planillaRenglones(estado).forEach((grupo) => {
    let totalRenglon = 0;
    grupo.querySelectorAll('.planilla-cant').forEach((input) => {
      const i = Number(input.dataset.dia);
      if (!planillaCargable(estado, fechas[i])) return;
      const c = planillaCantidad(input);
      totalRenglon += c;
      porDia[i] += c;
    });
    general += totalRenglon;
    const celda = grupo.querySelector('.planilla-total-renglon');
    celda.textContent = totalRenglon;
    celda.classList.toggle('planilla-total-cero', totalRenglon === 0);
  });

  estado.cont.querySelectorAll('.planilla-total-dia').forEach((td) => {
    const total = porDia[Number(td.dataset.dia)];
    td.textContent = total;
    td.classList.toggle('planilla-total-cero', total === 0);
  });
  const td = estado.cont.querySelector('.planilla-total-general');
  td.textContent = general;
  td.classList.toggle('planilla-total-cero', general === 0);

  if (estado.onCambio) estado.onCambio(planillaResumenDe(estado));
}

// ── Lectura ───────────────────────────────────────────────────────

// Cuántas líneas y cuántas viandas saldrían de la planilla tal como está.
// Es lo que muestra el resumen del form, y lo que se compara contra el techo
// de 50 líneas por request del backend.
function planillaResumenDe(estado) {
  const fechas = planillaFechas(estado);
  let lineas = 0;
  let viandas = 0;
  planillaRenglones(estado).forEach((grupo) => {
    grupo.querySelectorAll('.planilla-cant').forEach((input) => {
      if (!planillaCargable(estado, fechas[Number(input.dataset.dia)])) return;
      const c = planillaCantidad(input);
      if (c > 0) { lineas++; viandas += c; }
    });
  });
  return { lineas, viandas };
}

function resumenPlanilla(contenedor) {
  const estado = planillaEstado(contenedor);
  return estado ? planillaResumenDe(estado) : { lineas: 0, viandas: 0 };
}

// Las líneas que va a enviar la planilla, o el primer error que lo impide.
//
// Cada casilla > 0 de un día cargable es una línea puntual con la fecha de su
// columna. Un renglón con plato y sin cantidades se ignora (es un renglón que
// se dejó preparado y no se usó); un renglón con cantidades y sin plato es un
// error, porque hay trabajo cargado que se perdería en silencio. Un mismo
// plato en dos renglones está permitido a propósito: son líneas distintas, con
// envases o comentarios distintos.
function leerPlanilla(contenedor) {
  const estado = planillaEstado(contenedor);
  if (!estado) return { lineas: [], error: null };

  const fechas = planillaFechas(estado);
  const lineas = [];
  const grupos = planillaRenglones(estado);

  for (let g = 0; g < grupos.length; g++) {
    const grupo = grupos[g];
    const nro = g + 1;
    const platoStr = grupo.querySelector('.planilla-plato').value;
    const comentario = grupo.querySelector('.planilla-comentario').value.trim() || null;
    const envase = grupo.querySelector('.planilla-envase').value || null;
    const propias = [];

    const inputs = [...grupo.querySelectorAll('.planilla-cant')];
    for (const input of inputs) {
      const i = Number(input.dataset.dia);
      if (!planillaCargable(estado, fechas[i])) continue;
      const txt = input.value.trim();
      if (txt === '') continue;
      if (!/^\d+$/.test(txt)) {
        const plato = planillaNombrePlato(grupo);
        return {
          lineas: [],
          error: `El renglón ${nro}${plato ? ' (' + plato + ')' : ''} tiene "${txt}" en el día`
            + ` ${planillaDiaMes(fechas[i])}: la cantidad tiene que ser un número entero.`,
        };
      }
      const cantidad = parseInt(txt, 10);
      if (cantidad === 0) continue;
      propias.push({
        plato_id: null,
        cantidad,
        modo: 'puntual',
        fecha_entrega: fechas[i],
        comentario,
        tipo_envase_override: envase,
      });
    }

    if (!propias.length) continue;
    if (!platoStr) {
      return {
        lineas: [],
        error: `El renglón ${nro} de la planilla tiene cantidades cargadas pero no tiene plato elegido.`,
      };
    }
    propias.forEach((l) => { l.plato_id = Number(platoStr); });
    lineas.push(...propias);
  }

  return { lineas, error: null };
}

function planillaNombrePlato(grupo) {
  const sel = grupo.querySelector('.planilla-plato');
  return sel.value ? sel.options[sel.selectedIndex].textContent : '';
}

// ── Desde la pantalla ─────────────────────────────────────────────

// Vacía las cantidades sin tocar los platos ni las opciones. La usan el botón
// que oculta la planilla y el guardado del detalle, para no dejar cargada una
// semana que ya se guardó.
function vaciarPlanilla(contenedor) {
  const estado = planillaEstado(contenedor);
  if (!estado) return;
  planillaVaciarCantidades(estado);
  planillaRecalcular(estado);
}

function planillaTieneCantidades(contenedor) {
  const estado = planillaEstado(contenedor);
  return estado ? planillaHayCantidades(estado) : false;
}

// El texto de "Según el cliente (X)" cambia cuando cambia el cliente elegido,
// igual que en las líneas sueltas del form.
function actualizarEtiquetaEnvasePlanilla(texto, contenedor) {
  const estado = planillaEstado(contenedor);
  if (!estado) return;
  estado.etiquetaEnvase = texto;
  estado.cont.querySelectorAll('.planilla-envase option[value=""]').forEach((opt) => {
    opt.textContent = texto;
  });
}
