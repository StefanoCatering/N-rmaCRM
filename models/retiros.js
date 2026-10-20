// Retiros en el comedor (fase 10).
//
// La planilla con la que la persona de atención del comedor (Matrix) marca,
// día por día, quién RETIRÓ su vianda. Es un registro de ENTREGA, no de
// producción: no cambia los totales que ve cocina, ni los pedidos, ni la
// grilla, y no se sincroniza a narma-pedidos.
//
// La lista de quién debe retirar NO se guarda: sale de la grilla de la fase 7
// (grilla_planes + grilla_celdas + grilla_sin_servicio) con las mismas
// funciones que usa la hoja del día. Esta tabla solo agrega la marca de
// retirado. Así una ausencia cargada a las 11 de la mañana saca a esa persona
// de la lista en el acto, sin tener que sincronizar nada.
//
// Que exista la fila en grilla_retiros = retiró. Desmarcar = borrar la fila:
// no hay un tercer estado ("marcado como no retirado") que habría que
// distinguir de "todavía sin marcar".

const pool = require('./db');
const detalle = require('./pedidoDetalle');
const grilla = require('./grilla');
const platos = require('./platos');

const MAX_NOTA = 1000;

// ── Fechas ───────────────────────────────────────────────────────
// Toda la aritmética sale de models/pedidoDetalle.js, igual que la grilla: el
// "hoy" es el de Asunción y no el del servidor.

// El último día hábil ESTRICTAMENTE anterior a una fecha. Desde un lunes
// devuelve el viernes.
function habilAnterior(iso) {
  let f = detalle.sumarDias(iso, -1);
  while (!grilla.esHabil(f)) f = detalle.sumarDias(f, -1);
  return f;
}

// Los días que todavía se pueden marcar: hoy (si es hábil) y el día hábil
// anterior a hoy. Pasado eso la planilla queda de solo lectura — lo que se
// entregó el martes no se corrige el viernes.
//
// En fin de semana hoy no es hábil, así que queda editable solo el viernes; es
// lo que corresponde para quien cierra la semana el sábado a la mañana.
function fechasEditables(hoy = grilla.hoyISO()) {
  const dias = [habilAnterior(hoy)];
  if (grilla.esHabil(hoy)) dias.push(hoy);
  return dias;
}

function fechaEditable(fecha, hoy = grilla.hoyISO()) {
  return fechasEditables(hoy).includes(fecha);
}

// ── Lectura de un día ────────────────────────────────────────────

async function marcasDelDia(empresa, fecha, ejecutor = pool) {
  const r = await ejecutor.query(`
    SELECT r.cliente_id, r.marcado_en
    FROM grilla_retiros r
    JOIN clientes c ON c.id = r.cliente_id
    WHERE c.empresa = $1 AND r.fecha = $2
  `, [empresa, fecha]);
  return new Map(r.rows.map(row => [row.cliente_id, row.marcado_en]));
}

async function getNota(empresa, fecha, ejecutor = pool) {
  const r = await ejecutor.query(
    'SELECT * FROM grilla_retiros_notas WHERE empresa = $1 AND fecha = $2',
    [empresa, fecha]
  );
  if (!r.rows.length) return null;
  return { ...r.rows[0], fecha: detalle.aISO(r.rows[0].fecha) };
}

const porNombre = (a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es');

// Todo lo que dibuja la pantalla de Retiros para UN día.
//
// No devuelve 'editable': eso depende de QUIÉN pregunta (un visor ve la misma
// lista y no puede marcar), así que lo resuelve routes/retiros.js.
//
// Sin cédula ni teléfono: quien entrega las viandas no necesita los datos
// personales de los funcionarios del banco, solo el nombre y qué le toca.
async function armarDia(empresa, fecha) {
  const datos = await grilla.cargarSemana(empresa, grilla.lunesDe(fecha));
  const sinServicio = datos.sinServicio.has(fecha);

  const [marcas, nota] = await Promise.all([
    marcasDelDia(empresa, fecha),
    getNota(empresa, fecha),
  ]);

  const deben_retirar = [];
  const ausentes = [];

  // Día sin servicio: ese día no se produjo ni se entregó nada para esa
  // empresa, así que las dos listas van vacías. Mismo criterio que la hoja del
  // día, donde el sin servicio también gana sobre cualquier celda cargada.
  if (!sinServicio) {
    // Los nombres de plato salen de fichasPorId, igual que hojaDia: incluye
    // los inactivos, porque una celda vieja puede apuntar a un plato que
    // después se desactivó.
    const idsPlato = new Set();
    for (const c of datos.colaboradores) idsPlato.add(c.plato_base_id);
    for (const celda of datos.celdas.values()) if (celda.plato_id) idsPlato.add(celda.plato_id);
    const fichas = await platos.fichasPorId([...idsPlato]);
    const nombrePlato = id => (fichas.get(id) || {}).etiqueta || `Plato #${id}`;

    for (const colaborador of datos.colaboradores) {
      // null = ese día no está en el plan (alta posterior o baja ya cumplida):
      // no va en ninguna de las dos listas.
      const efectivo = grilla.platoEfectivo(datos, colaborador, fecha);
      if (!efectivo) continue;

      if (efectivo.tipo === 'ausencia') {
        ausentes.push({
          cliente_id: colaborador.cliente_id,
          nombre_completo: colaborador.nombre_completo,
          ausencia: efectivo.ausencia,
          comentario: efectivo.comentario || null,
        });
        continue;
      }

      const marcadoEn = marcas.get(colaborador.cliente_id);
      deben_retirar.push({
        cliente_id: colaborador.cliente_id,
        nombre_completo: colaborador.nombre_completo,
        plato_nombre: nombrePlato(efectivo.plato_id),
        // La observación fija del plan ("no consume cerdo"): no cambia lo que
        // se cocina, pero sí lo que se le entrega a esa persona.
        observacion: colaborador.observacion || null,
        retiro: marcadoEn !== undefined,
        marcado_en: marcadoEn !== undefined ? marcadoEn : null,
      });
    }
  }

  deben_retirar.sort(porNombre);
  ausentes.sort(porNombre);

  const retiraron = deben_retirar.filter(p => p.retiro).length;

  return {
    empresa,
    fecha,
    sin_servicio: sinServicio,
    motivo_sin_servicio: sinServicio ? (datos.sinServicio.get(fecha) || null) : null,
    deben_retirar,
    ausentes,
    nota: nota ? nota.texto : null,
    totales: {
      deben_retirar: deben_retirar.length,
      retiraron,
      sin_marcar: deben_retirar.length - retiraron,
    },
  };
}

// ¿Este colaborador tiene que retirar su vianda ese día? Es la validación de
// PUT /marca, y se resuelve contra la MISMA lista que devuelve armarDia: así
// no hay dos criterios de "a quién le toca hoy" que puedan discrepar.
// Devuelve null si se puede marcar, o el mensaje de error.
async function errorMarcable(empresa, fecha, clienteId) {
  const dia = await armarDia(empresa, fecha);
  if (dia.sin_servicio) {
    return `Ese día ${empresa} no tiene servicio${dia.motivo_sin_servicio ? ': ' + dia.motivo_sin_servicio : ''}`;
  }
  if (dia.deben_retirar.some(p => p.cliente_id === clienteId)) return null;
  if (dia.ausentes.some(p => p.cliente_id === clienteId)) {
    return 'Ese colaborador está marcado como ausente ese día: no tiene vianda para retirar';
  }
  return 'Ese colaborador no tiene vianda para retirar ese día';
}

// ── Escritura ────────────────────────────────────────────────────
// Cada cambio y su registro de auditoría van en UNA transacción, igual que el
// resto de las escrituras de la grilla: un cambio sin rastro (o un rastro sin
// cambio) sería peor que no auditar nada. Es un BEGIN…COMMIT sobre un solo
// client, sin advisory locks ni estado de sesión, así que no le molesta al
// pooler en modo transacción.

const claveMarca = (clienteId, fecha) => grilla.claveCelda(clienteId, fecha);

// Marca el retiro. Es un upsert por la PK (cliente_id, fecha): volver a marcar
// lo mismo refresca quién y cuándo, no duplica.
async function marcar(clienteId, fecha, usuario) {
  return grilla.enTransaccion(async (client) => {
    const antes = (await client.query(
      'SELECT * FROM grilla_retiros WHERE cliente_id = $1 AND fecha = $2',
      [clienteId, fecha]
    )).rows[0] || null;

    const fila = (await client.query(`
      INSERT INTO grilla_retiros (cliente_id, fecha, marcado_por, marcado_en)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (cliente_id, fecha) DO UPDATE SET
        marcado_por = EXCLUDED.marcado_por,
        marcado_en  = NOW()
      RETURNING *
    `, [clienteId, fecha, (usuario && usuario.id) || null])).rows[0];

    await grilla.auditar(
      usuario && usuario.id, 'grilla_retiros', claveMarca(clienteId, fecha), antes, fila, client
    );
    return fila;
  });
}

// Desmarca: borra la fila. Si no había nada, no hay cambio que auditar.
async function desmarcar(clienteId, fecha, usuario) {
  return grilla.enTransaccion(async (client) => {
    const borrada = (await client.query(
      'DELETE FROM grilla_retiros WHERE cliente_id = $1 AND fecha = $2 RETURNING *',
      [clienteId, fecha]
    )).rows[0] || null;

    if (borrada) {
      await grilla.auditar(
        usuario && usuario.id, 'grilla_retiros', claveMarca(clienteId, fecha), borrada, null, client
      );
    }
    return borrada;
  });
}

// Comentario libre del día. Texto vacío = se borra la nota: una fila con ''
// no dice nada distinto de no tener fila.
async function setNota(empresa, fecha, texto, usuario) {
  const limpio = String(texto === null || texto === undefined ? '' : texto).trim().slice(0, MAX_NOTA);

  return grilla.enTransaccion(async (client) => {
    const antes = (await client.query(
      'SELECT * FROM grilla_retiros_notas WHERE empresa = $1 AND fecha = $2',
      [empresa, fecha]
    )).rows[0] || null;

    if (!limpio) {
      const borrada = (await client.query(
        'DELETE FROM grilla_retiros_notas WHERE empresa = $1 AND fecha = $2 RETURNING *',
        [empresa, fecha]
      )).rows[0] || null;
      if (borrada) {
        await grilla.auditar(
          usuario && usuario.id, 'grilla_retiros_notas', `${empresa}|${fecha}`, borrada, null, client
        );
      }
      return null;
    }

    const fila = (await client.query(`
      INSERT INTO grilla_retiros_notas (empresa, fecha, texto, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (empresa, fecha) DO UPDATE SET
        texto      = EXCLUDED.texto,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
    `, [empresa, fecha, limpio, (usuario && usuario.id) || null])).rows[0];

    await grilla.auditar(
      usuario && usuario.id, 'grilla_retiros_notas', `${empresa}|${fecha}`, antes, fila, client
    );
    return fila;
  });
}

module.exports = {
  MAX_NOTA,
  // fechas
  habilAnterior, fechasEditables, fechaEditable,
  // lectura
  armarDia, marcasDelDia, getNota, errorMarcable,
  // escritura
  marcar, desmarcar, setNota,
};
