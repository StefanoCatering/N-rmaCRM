// A nombre de quién se factura (fase 13).
//
// Desde el CRM no se factura nada: esto es el registro del dato, para que
// quien emite la factura no tenga que preguntar. El caso que lo motiva es el
// más común del negocio: la señora hace el pedido y la factura va a nombre del
// marido, que también es cliente.
//
// Las reglas viven TODAS acá —la validación y la resolución— porque las
// comparten cuatro lugares: el alta y la edición de cliente, el alta de pedido
// y la edición de pedido. Con una copia en cada ruta, la primera regla que
// cambiara dejaría a las otras tres mintiendo.
//
// ── Por qué no hay cadenas ───────────────────────────────────────
// Un cliente tiene DOS cosas distintas:
//   sus datos PROPIOS      → razon_social / ruc / email_facturacion
//   a quién le factura     → factura_a (+ factura_cliente_id / factura_*)
// Cuando A factura a B se leen los datos PROPIOS de B y NO se vuelve a mirar
// el factura_a de B. Si B a su vez factura a C, los pedidos de A siguen
// saliendo con el RUC de B. Es a propósito: una cadena haría que cambiarle la
// facturación a B le cambiara en silencio la factura a A, y nadie que mira la
// ficha de A podría explicar de dónde salió un RUC que no figura en ninguna de
// las dos fichas.
const pool = require('./db');

const MODOS = ['mismo', 'otro_cliente', 'otros'];

// RUC como texto libre: los paraguayos llevan guion y dígito verificador
// ('80012345-6'), hay clientes extranjeros, y el CRM no emite facturas — así
// que validar el dígito verificador sería inventar una regla que nadie pidió.
// El techo de 20 es para que no entre un párrafo por ese campo.
const MAX_RUC = 20;
const MAX_RAZON_SOCIAL = 200;
const MAX_EMAIL = 200;

// Formato básico, solo si el email viene cargado: algo@algo.algo. No se
// persigue la RFC — un email mal escrito lo corrige quien factura, y rechazar
// un alta por eso sería peor que guardarlo.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// trim, y vacío → NULL. Que '' y NULL signifiquen lo mismo ("no cargado") es
// lo que permite que borrar un campo desde el form lo deje realmente vacío.
function limpiar(valor, max) {
  if (valor === undefined || valor === null) return null;
  const s = String(valor).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// ── Datos propios del cliente ────────────────────────────────────
// Los tres son opcionales: hoy no se tiene el RUC de casi nadie y pedirlo como
// obligatorio frenaría el alta de un cliente que quiere su vianda mañana.
// "Sin RUC cargado" es un estado válido del sistema.
function normalizarPropios(body) {
  const errores = [];
  const datos = {
    razon_social:      limpiar(body.razon_social, MAX_RAZON_SOCIAL),
    ruc:               limpiar(body.ruc, MAX_RUC),
    email_facturacion: limpiar(body.email_facturacion, MAX_EMAIL),
  };
  if (datos.email_facturacion && !EMAIL_RE.test(datos.email_facturacion)) {
    errores.push('El email de facturación no tiene un formato válido');
  }
  return { datos, errores };
}

// ── A quién se factura ───────────────────────────────────────────
// Valida el destino de la facturación y devuelve las cinco columnas listas
// para escribir, ya sea de clientes o de pedidos (son las mismas cinco).
//
// opciones:
//   enPedido    → true en un pedido: ahí factura_a admite NULL, que significa
//                 "según el cliente" y es el valor por defecto. En un cliente
//                 el valor por defecto es 'mismo'.
//   idExcluido  → un id que no puede ser el destinatario: el del propio
//                 cliente que se está editando, o el del cliente del pedido.
//                 Facturarle a él por la vía de 'otro_cliente' no es un caso
//                 —para eso está 'mismo'— y además abriría un ciclo.
//
// Devuelve { datos, errores, aviso, destino }:
//   datos   → { factura_a, factura_cliente_id, factura_razon_social, factura_ruc, factura_email }
//   aviso   → texto para la respuesta cuando algo es válido pero conviene
//             decirlo (el cliente elegido no tiene RUC propio). NO es un error:
//             el dato se completa después y nada se bloquea por eso.
//   destino → la fila del cliente elegido, para no volver a buscarla
async function validarDestino(body, { enPedido = false, idExcluido = null } = {}) {
  const errores = [];
  const vacio = {
    factura_a: null, factura_cliente_id: null,
    factura_razon_social: null, factura_ruc: null, factura_email: null,
  };

  const crudo = body.factura_a;
  const sinValor = crudo === undefined || crudo === null || crudo === '';

  // Sin valor: en un pedido queda "según el cliente"; en un cliente, 'mismo'.
  if (sinValor) {
    return { datos: enPedido ? { ...vacio } : { ...vacio, factura_a: 'mismo' }, errores, aviso: null, destino: null };
  }

  const factura_a = String(crudo).trim();
  if (!MODOS.includes(factura_a)) {
    return { datos: { ...vacio }, errores: ['Destinatario de factura inválido'], aviso: null, destino: null };
  }

  // 'otros': los datos se escriben a mano, y razón social y RUC son
  // obligatorios — sin eso, elegir "otros datos" no registra nada y es igual a
  // no haber elegido nada.
  if (factura_a === 'otros') {
    const factura_razon_social = limpiar(body.factura_razon_social, MAX_RAZON_SOCIAL);
    const factura_ruc = limpiar(body.factura_ruc, MAX_RUC);
    const factura_email = limpiar(body.factura_email, MAX_EMAIL);

    if (!factura_razon_social) errores.push('La razón social es requerida cuando se factura a otros datos');
    if (!factura_ruc) errores.push('El RUC es requerido cuando se factura a otros datos');
    if (factura_email && !EMAIL_RE.test(factura_email)) {
      errores.push('El email de facturación no tiene un formato válido');
    }

    return {
      datos: { factura_a, factura_cliente_id: null, factura_razon_social, factura_ruc, factura_email },
      errores, aviso: null, destino: null,
    };
  }

  // 'otro_cliente': tiene que existir, y no puede ser el cliente excluido.
  if (factura_a === 'otro_cliente') {
    const id = Number(body.factura_cliente_id);
    if (!Number.isInteger(id) || id <= 0) {
      return { datos: { ...vacio }, errores: ['Elegí el cliente al que se le factura'], aviso: null, destino: null };
    }
    if (idExcluido !== null && id === Number(idExcluido)) {
      return {
        datos: { ...vacio },
        errores: ['Para facturar al mismo cliente, elegí "Mismo cliente"'],
        aviso: null, destino: null,
      };
    }

    const destino = await datosPropiosDe(id);
    if (!destino) {
      return { datos: { ...vacio }, errores: ['El cliente al que se le factura no existe'], aviso: null, destino: null };
    }

    // Sin RUC propio se permite igual: el dato se completa cuando ATC lo
    // consigue, y hasta entonces la ficha dice "sin RUC cargado". Lo que no
    // corresponde es frenar el alta por algo que no depende de quien la carga.
    const aviso = destino.ruc
      ? null
      : `${destino.nombre_completo} todavía no tiene RUC cargado: la factura va a su nombre pero sin RUC.`;

    return {
      // Al elegir un cliente se vacían los campos de "otros datos": si
      // quedaran cargados, la ficha mostraría un RUC escrito a mano que ya no
      // se usa y nadie sabría cuál de los dos manda.
      datos: {
        factura_a, factura_cliente_id: id,
        factura_razon_social: null, factura_ruc: null, factura_email: null,
      },
      errores, aviso, destino,
    };
  }

  // 'mismo': no hay nada más que guardar, y los campos de "otros datos" se
  // vacían por el mismo motivo que arriba.
  return { datos: { ...vacio, factura_a: 'mismo' }, errores, aviso: null, destino: null };
}

// ── Resolución ───────────────────────────────────────────────────

// Los datos PROPIOS de un cliente, que es lo único que se lee del
// destinatario cuando se factura a otro cliente.
async function datosPropiosDe(clienteId, ejecutor = pool) {
  if (!clienteId) return null;
  const r = await ejecutor.query(`
    SELECT id, nombre_completo, razon_social, ruc, email_facturacion
    FROM clientes WHERE id = $1
  `, [clienteId]);
  return r.rows[0] || null;
}

// Todo lo que hace falta de un cliente para resolver su facturación: sus datos
// propios Y a quién le factura.
//
// Es distinta de datosPropiosDe a propósito: del DESTINATARIO se leen solo los
// datos propios (así no hay cadenas), pero del cliente del que se parte hay
// que saber además su factura_a. Dos funciones, para que no se pueda usar por
// error la que trae de menos.
async function filaDeCliente(clienteId, ejecutor = pool) {
  if (!clienteId) return null;
  const r = await ejecutor.query(`
    SELECT id, nombre_completo,
           razon_social, ruc, email_facturacion,
           factura_a, factura_cliente_id, factura_razon_social, factura_ruc, factura_email
    FROM clientes WHERE id = $1
  `, [clienteId]);
  return r.rows[0] || null;
}

// Completa los dos campos que la vista necesita y que no están en la base:
//   nombre     → qué mostrar como destinatario
//   incompleto → falta razón social o RUC, así la vista puede decir
//                "sin RUC cargado" sin tener que repetir la regla
function conDerivados(f) {
  return {
    ...f,
    nombre: f.razon_social || f.cliente_nombre || null,
    incompleto: !f.razon_social || !f.ruc,
  };
}

// A nombre de quién se factura un cliente. `cliente` es la fila de clientes
// (alcanza con sus columnas de facturación, el id y el nombre).
async function resolverCliente(cliente, ejecutor = pool) {
  if (!cliente) return null;

  if (cliente.factura_a === 'otros') {
    return conDerivados({
      modo: 'otros',
      razon_social: cliente.factura_razon_social,
      ruc: cliente.factura_ruc,
      email: cliente.factura_email,
      cliente_id: null,
      cliente_nombre: null,
    });
  }

  if (cliente.factura_a === 'otro_cliente') {
    const otro = await datosPropiosDe(cliente.factura_cliente_id, ejecutor);
    // El cliente elegido no se puede haber borrado (la FK lo impide), pero si
    // alguna vez pasara, la ficha tiene que seguir abriéndose.
    if (!otro) {
      return conDerivados({
        modo: 'otro_cliente', razon_social: null, ruc: null, email: null,
        cliente_id: cliente.factura_cliente_id, cliente_nombre: null,
      });
    }
    return conDerivados({
      modo: 'otro_cliente',
      razon_social: otro.razon_social,
      ruc: otro.ruc,
      email: otro.email_facturacion,
      cliente_id: otro.id,
      cliente_nombre: otro.nombre_completo,
    });
  }

  // 'mismo' (y cualquier fila vieja que tuviera factura_a en NULL).
  return conDerivados({
    modo: 'mismo',
    razon_social: cliente.razon_social,
    ruc: cliente.ruc,
    email: cliente.email_facturacion,
    cliente_id: cliente.id,
    cliente_nombre: cliente.nombre_completo,
  });
}

// A nombre de quién se factura UN pedido.
//
// pedidos.factura_a en NULL es "según el cliente", y se resuelve al momento de
// leer en lugar de copiarse al crear el pedido: así, cuando mañana se carga el
// RUC del marido, los pedidos ya cargados salen con el RUC nuevo sin que nadie
// los toque. Es la misma decisión que la ventana de entrega de la fase 11.
//
// Cuando el pedido SÍ tiene su propio modo se aplica exactamente la misma
// regla, pero sobre los campos del pedido: un override 'mismo' factura al
// cliente del pedido con sus datos propios.
async function resolverPedido(pedido, cliente, ejecutor = pool) {
  if (!pedido || !cliente) return null;

  if (!pedido.factura_a) {
    return { ...(await resolverCliente(cliente, ejecutor)), segun_cliente: true };
  }

  const comoCliente = {
    id: cliente.id,
    nombre_completo: cliente.nombre_completo,
    razon_social: cliente.razon_social,
    ruc: cliente.ruc,
    email_facturacion: cliente.email_facturacion,
    factura_a: pedido.factura_a,
    factura_cliente_id: pedido.factura_cliente_id,
    factura_razon_social: pedido.factura_razon_social,
    factura_ruc: pedido.factura_ruc,
    factura_email: pedido.factura_email,
  };
  return { ...(await resolverCliente(comoCliente, ejecutor)), segun_cliente: false };
}

module.exports = {
  MODOS, MAX_RUC, MAX_RAZON_SOCIAL, MAX_EMAIL,
  limpiar, normalizarPropios, validarDestino,
  datosPropiosDe, filaDeCliente, resolverCliente, resolverPedido,
};
