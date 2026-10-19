// Resolución de entregas: el paso que convierte las LÍNEAS de pedido del CRM
// en ENTREGAS concretas (un plato, una fecha, una cantidad, un envase), ya
// denormalizadas como las espera cocina.
//
// Vive en su propio módulo porque tiene dos consumidores que están obligados a
// dar exactamente el mismo número:
//
//   models/syncPedidos.js  → lo que se escribe en pedidos_crm_detalle, que es
//                            lo único que ve cocina.
//   models/resumen.js      → el Resumen del día, con el que Administración
//                            revisa la noche anterior que lo cargado cuadre.
//
// Si la regla del envase o la etiqueta del plato estuvieran escritas dos veces,
// el resumen podría decir una cosa y cocina producir otra — que es justo lo que
// el resumen existe para detectar. De ahí que las dos pasen por acá.
//
// Nada de este módulo consulta la base: recibe las filas ya leídas (líneas,
// excepciones, nombres de plato) y resuelve en memoria. Quien llama decide cómo
// las trae: el sync las lee por pedido, el resumen en lote por fecha.

const detalle = require('./pedidoDetalle');

// ── Una entrega → una fila ───────────────────────────────────────
// La forma exacta de pedidos_crm_detalle (ver el contrato documentado en
// models/syncPedidos.js). Las dos reglas que importan y que no se pueden
// repetir en otro lado:
//
//   tipo_envase  → el override de la línea gana sobre el envase del cliente.
//   plato_nombre → la ETIQUETA del plato (platos.nombresPorId), no el nombre
//                  pelado: con el nombre solo, 'César' no distingue la ensalada
//                  del wrap.
//
// segmento va con el valor crudo de la base ('particular' / 'empresa' /
// 'embajador'); la etiqueta "Corporativo" es solo de la UI del CRM.
function armarFila(pedido, linea, entrega, nombres) {
  return {
    crm_pedido_id: pedido.pedido_id,
    crm_pedido_detalle_id: linea.id,
    crm_excepcion_id: entrega.excepcion_id,
    cliente_nombre: pedido.cliente_nombre,
    segmento: pedido.segmento,
    tipo_envase: linea.tipo_envase_override || pedido.cliente_tipo_envase,
    plato_nombre: nombres.get(entrega.plato_id) || null,
    cantidad: entrega.cantidad,
    fecha_entrega: entrega.fecha_entrega,
    ubicacion_direccion: pedido.ubicacion_direccion,
    comentario: entrega.comentario,
  };
}

// ids de todos los platos en juego para un conjunto de líneas: el de la línea
// y el de cada excepción que lo pisa. Sirve para resolver los nombres en UNA
// sola consulta en lugar de una por línea.
function idsDePlatos(lineas, excepcionesPorLinea) {
  const ids = new Set();
  for (const l of lineas) {
    ids.add(l.plato_id);
    for (const e of excepcionesPorLinea.get(l.id) || []) {
      if (e.plato_id != null) ids.add(e.plato_id);
    }
  }
  return [...ids];
}

// ── Expansión ────────────────────────────────────────────────────
// Convierte líneas en filas listas para pedidos_crm_detalle.
//
//   lineas              → filas de pedido_detalle (cualquier cantidad de pedidos)
//   pedidosPorId        → Map pedido_id → cabecera (cliente_nombre, segmento,
//                         cliente_tipo_envase, ubicacion_direccion, pedido_id)
//   excepcionesPorLinea → Map pedido_detalle_id → excepciones[]
//   nombres             → Map plato_id → etiqueta
//   soloFecha           → opcional: deja solo las entregas de ese día.
//
// Devuelve { filas, lineasCanceladas }: las líneas canceladas no generan
// entregas y se devuelven aparte porque el sync tiene que marcar cancelado =
// true en las filas que ya les había escrito.
//
// La expansión de una línea recurrente NO se reimplementa acá: es la misma
// llamada a detalle.resolverEntregas() en los dos casos. Con soloFecha se
// expande el rango completo igual y después se filtra, a propósito: así el
// resumen no puede diferir del sync por una diferencia en la expansión, el
// techo de MAX_DIAS_RANGO o el salteo de fines de semana.
function expandir({ lineas, pedidosPorId, excepcionesPorLinea, nombres, soloFecha = null }) {
  const filas = [];
  const lineasCanceladas = [];

  for (const linea of lineas) {
    if (linea.cancelado) {
      lineasCanceladas.push(linea.id);
      continue;
    }

    const pedido = pedidosPorId.get(linea.pedido_id);
    if (!pedido) continue; // defensivo: no debería pasar, la cabecera sale del mismo JOIN

    const entregas = detalle.resolverEntregas(linea, excepcionesPorLinea.get(linea.id) || []);
    for (const entrega of entregas) {
      if (soloFecha && entrega.fecha_entrega !== soloFecha) continue;
      filas.push(armarFila(pedido, linea, entrega, nombres));
    }
  }

  return { filas, lineasCanceladas };
}

module.exports = { armarFila, idsDePlatos, expandir };
