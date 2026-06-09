const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../models/db');

const router = express.Router();

// ── Constantes de formato ─────────────────────────────────────────

const SEGMENTO_LABEL = { particular: 'Particular', empresa: 'Empresa' };
const CANAL_LABEL = {
  whatsapp: 'WhatsApp', redes: 'Redes sociales', embajador: 'Embajador',
  boca_a_boca: 'Boca a boca', b2b: 'B2B', otro: 'Otro',
};
const ESTADO_LABEL = { activo: 'Activo', pausado: 'Pausado', inactivo: 'Inactivo', baja: 'Baja' };

function fmtFecha(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10).split('-').reverse().join('/');
}

// ── Helpers ExcelJS ───────────────────────────────────────────────

function styleHeaders(worksheet) {
  const row = worksheet.getRow(1);
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2E4A' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF2B4B7A' } },
    };
  });
  row.height = 22;
}

function autoWidth(worksheet) {
  worksheet.columns.forEach(col => {
    let maxLen = col.header ? String(col.header).length : 8;
    col.eachCell({ includeEmpty: false }, cell => {
      const v = cell.value != null ? String(cell.value) : '';
      if (v.length > maxLen) maxLen = v.length;
    });
    col.width = Math.min(maxLen + 4, 60);
  });
}

// ── Endpoint principal ────────────────────────────────────────────

/**
 * GET /api/export
 *
 * Parámetros de filtro (mismos que GET /api/clientes):
 *   estado, segmento, canal_origen, empresa, q
 *
 * Parámetros específicos de exportación:
 *   tipo = 'datos' | 'historial'
 *   fecha_desde, fecha_hasta (solo para historial, filtran la hoja Pedidos)
 */
router.get('/', async (req, res, next) => {
  try {
    const { tipo, estado, segmento, canal_origen, empresa, q, fecha_desde, fecha_hasta } = req.query;

    if (!['datos', 'historial'].includes(tipo)) {
      return res.status(400).json({ error: 'Parámetro "tipo" debe ser "datos" o "historial"' });
    }

    // ── Construir filtros de clientes ──────────────────────────
    const clienteConds = [];
    const clienteParams = [];
    let n = 1;

    if (estado)        { clienteConds.push(`c.estado = $${n++}`);       clienteParams.push(estado); }
    if (segmento)      { clienteConds.push(`c.segmento = $${n++}`);     clienteParams.push(segmento); }
    if (canal_origen)  { clienteConds.push(`c.canal_origen = $${n++}`); clienteParams.push(canal_origen); }
    if (empresa)       { clienteConds.push(`c.empresa = $${n++}`);      clienteParams.push(empresa); }
    if (q) {
      // Mismo $n para nombre y cédula — PostgreSQL permite reusar el mismo placeholder
      clienteConds.push(`(c.nombre_completo ILIKE $${n} OR c.cedula ILIKE $${n})`);
      clienteParams.push(`%${q}%`);
      n++;
    }

    const clienteWhere = clienteConds.length ? 'WHERE ' + clienteConds.join(' AND ') : '';

    // ── Consulta clientes con resumen de pedidos ───────────────
    const { rows: clientes } = await pool.query(`
      SELECT
        c.id,
        c.nombre_completo,
        c.cedula,
        c.email,
        c.telefono,
        c.segmento,
        c.empresa,
        c.canal_origen,
        c.estado,
        c.fecha_ingreso,
        COUNT(p.id)::integer                                         AS cantidad_pedidos,
        MAX(p.fecha_pedido)                                          AS ultimo_pedido,
        CASE WHEN MAX(p.fecha_pedido) IS NOT NULL
          THEN EXTRACT(DAY FROM NOW() - MAX(p.fecha_pedido)::timestamp)::integer
          ELSE NULL END                                              AS dias_sin_pedir,
        COALESCE(AVG(p.monto)::float,  0)                           AS ticket_promedio,
        COALESCE(SUM(p.monto)::float,  0)                           AS ticket_total
      FROM clientes c
      LEFT JOIN pedidos p ON p.cliente_id = c.id
      ${clienteWhere}
      GROUP BY c.id
      ORDER BY c.nombre_completo
    `, clienteParams);

    // ── Armar workbook ─────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Närma CRM';
    wb.created = new Date();

    const today = new Date().toISOString().slice(0, 10);
    const filename = tipo === 'datos'
      ? `narma-clientes-${today}.xlsx`
      : `narma-historial-${today}.xlsx`;

    // ── Hoja "Clientes" (tipo=datos) o "Resumen" (tipo=historial) ──
    const sheetName = tipo === 'datos' ? 'Clientes' : 'Resumen';
    const ws = wb.addWorksheet(sheetName);

    ws.columns = [
      { header: 'Nombre completo',     key: 'nombre_completo'   },
      { header: 'Cédula',              key: 'cedula'            },
      { header: 'Email',               key: 'email'             },
      { header: 'Teléfono',            key: 'telefono'          },
      { header: 'Segmento',            key: 'segmento'          },
      { header: 'Empresa',             key: 'empresa'           },
      { header: 'Canal de origen',     key: 'canal_origen'      },
      { header: 'Estado',              key: 'estado'            },
      { header: 'Fecha de ingreso',    key: 'fecha_ingreso'     },
      { header: 'Cantidad de pedidos', key: 'cantidad_pedidos'  },
      { header: 'Último pedido',       key: 'ultimo_pedido'     },
      { header: 'Días sin pedir',      key: 'dias_sin_pedir'    },
      { header: 'Ticket promedio (Gs.)',key: 'ticket_promedio'  },
      { header: 'Ticket total (Gs.)',  key: 'ticket_total'      },
    ];

    styleHeaders(ws);

    for (const c of clientes) {
      ws.addRow({
        nombre_completo:  c.nombre_completo,
        cedula:           c.cedula,
        email:            c.email || '',
        telefono:         c.telefono || '',
        segmento:         SEGMENTO_LABEL[c.segmento] || c.segmento,
        empresa:          c.empresa || '',
        canal_origen:     CANAL_LABEL[c.canal_origen] || c.canal_origen,
        estado:           ESTADO_LABEL[c.estado] || c.estado,
        fecha_ingreso:    fmtFecha(c.fecha_ingreso),
        cantidad_pedidos: c.cantidad_pedidos,
        ultimo_pedido:    fmtFecha(c.ultimo_pedido),
        dias_sin_pedir:   c.dias_sin_pedir != null ? c.dias_sin_pedir : '',
        ticket_promedio:  Math.round(c.ticket_promedio || 0),
        ticket_total:     Math.round(c.ticket_total    || 0),
      });
    }

    autoWidth(ws);

    // ── Hoja "Pedidos" (solo tipo=historial) ───────────────────
    if (tipo === 'historial') {
      // Los filtros de pedidos = mismos filtros de cliente + rango de fechas opcional
      const pedidosConds   = [...clienteConds];
      const pedidosParams  = [...clienteParams];
      let   pn             = n;

      if (fecha_desde) { pedidosConds.push(`p.fecha_pedido >= $${pn++}`); pedidosParams.push(fecha_desde); }
      if (fecha_hasta) { pedidosConds.push(`p.fecha_pedido <= $${pn++}`); pedidosParams.push(fecha_hasta); }

      const pedidosWhere = pedidosConds.length ? 'WHERE ' + pedidosConds.join(' AND ') : '';

      const { rows: pedidos } = await pool.query(`
        SELECT
          c.nombre_completo,
          c.cedula,
          p.fecha_pedido,
          p.monto,
          p.descripcion
        FROM pedidos p
        JOIN clientes c ON c.id = p.cliente_id
        ${pedidosWhere}
        ORDER BY c.nombre_completo, p.fecha_pedido DESC
      `, pedidosParams);

      const wsPedidos = wb.addWorksheet('Pedidos');
      wsPedidos.columns = [
        { header: 'Nombre cliente', key: 'nombre_completo' },
        { header: 'Cédula',         key: 'cedula'          },
        { header: 'Fecha pedido',   key: 'fecha_pedido'    },
        { header: 'Monto (Gs.)',    key: 'monto'           },
        { header: 'Descripción',    key: 'descripcion'     },
      ];

      styleHeaders(wsPedidos);

      for (const p of pedidos) {
        wsPedidos.addRow({
          nombre_completo: p.nombre_completo,
          cedula:          p.cedula,
          fecha_pedido:    fmtFecha(p.fecha_pedido),
          monto:           p.monto,
          descripcion:     p.descripcion || '',
        });
      }

      autoWidth(wsPedidos);
    }

    // ── Enviar respuesta ───────────────────────────────────────
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) { next(err); }
});

module.exports = router;
