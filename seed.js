// Crea los usuarios iniciales y un set de clientes/pedidos de ejemplo
// para poder probar el sistema desde el primer arranque.
const bcrypt = require('bcrypt');
const db = require('./models/db');

const SALT_ROUNDS = 10;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function seedUsuarios() {
  const usuarios = [
    { username: 'NarmaAdmin', password: 'narma2025', rol: 'operador' },
    { username: 'Stefano', password: 'narma2025', rol: 'admin' },
    { username: 'Guadalupe', password: 'narma2025', rol: 'admin' },
  ];

  const insert = db.prepare(
    'INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?)'
  );

  for (const u of usuarios) {
    const existe = db.prepare('SELECT 1 FROM usuarios WHERE username = ?').get(u.username);
    if (existe) continue;
    const hash = bcrypt.hashSync(u.password, SALT_ROUNDS);
    insert.run(u.username, hash, u.rol);
    console.log(`  usuario creado: ${u.username} (${u.rol})`);
  }
}

function seedClientes() {
  if (db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n > 0) {
    console.log('  clientes ya existen, se omite el seed de clientes');
    return;
  }

  const insertCliente = db.prepare(`
    INSERT INTO clientes
      (nombre_completo, cedula, email, telefono, segmento, empresa, canal_origen, codigo_embajador, estado, fecha_ingreso)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPedido = db.prepare(`
    INSERT INTO pedidos (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const clientes = [
    {
      nombre_completo: 'Lucía Benítez', cedula: '4123456', email: 'lucia.benitez@gmail.com',
      telefono: '0981123456', segmento: 'particular', empresa: null, canal_origen: 'whatsapp', codigo_embajador: null,
      estado: 'activo', fecha_ingreso: daysAgo(160),
      pedidos: [
        { dias: 3, monto: 185000, monto_pagado: 185000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable semanal x5' },
        { dias: 17, monto: 185000, monto_pagado: 185000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'saludable', descripcion: 'Vianda saludable semanal x5' },
        { dias: 31, monto: 92000, monto_pagado: 92000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable x2 días' },
      ],
    },
    {
      nombre_completo: 'Carlos Domínguez', cedula: '3987654', email: 'cdominguez@yguazu.com.py',
      telefono: '0982234567', segmento: 'empresa', empresa: 'Yguazú S.A.', canal_origen: 'b2b', codigo_embajador: null,
      estado: 'activo', fecha_ingreso: daysAgo(220),
      pedidos: [
        { dias: 2, monto: 1450000, monto_pagado: null, estado_pago: 'pendiente', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 25 pax' },
        { dias: 16, monto: 1450000, monto_pagado: 1450000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 25 pax' },
        { dias: 30, monto: 1380000, monto_pagado: 1380000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 24 pax' },
        { dias: 44, monto: 1450000, monto_pagado: 1450000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 25 pax' },
      ],
    },
    {
      nombre_completo: 'Marcela Acosta', cedula: '4556677', email: 'marcela.acosta@hotmail.com',
      telefono: '0983345678', segmento: 'particular', empresa: null, canal_origen: 'redes', codigo_embajador: null,
      estado: 'activo', fecha_ingreso: daysAgo(95),
      // sin pedidos hace 22 días -> debe disparar alerta
      pedidos: [
        { dias: 22, monto: 78000, monto_pagado: 78000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'low_carb', descripcion: 'Vianda low carb x2 días' },
        { dias: 36, monto: 117000, monto_pagado: 117000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'low_carb', descripcion: 'Vianda low carb x3 días' },
      ],
    },
    {
      nombre_completo: 'Marta Cuevas', cedula: '3998877', email: 'marta.cuevas@yguazu.com.py',
      telefono: '021556677', segmento: 'empresa', empresa: 'Yguazú S.A.', canal_origen: 'b2b', codigo_embajador: null,
      estado: 'activo', fecha_ingreso: daysAgo(310),
      pedidos: [
        { dias: 5, monto: 2100000, monto_pagado: 2100000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC evento corporativo' },
        { dias: 60, monto: 1980000, monto_pagado: 1980000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC evento corporativo' },
        { dias: 118, monto: 2050000, monto_pagado: 1500000, estado_pago: 'pendiente', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC evento corporativo (pago parcial)' },
      ],
    },
    {
      nombre_completo: 'Diego Ramírez', cedula: '4778899', email: 'diego.ramirez@gmail.com',
      telefono: '0984456789', segmento: 'particular', empresa: null, canal_origen: 'embajador', codigo_embajador: 'EMB-014',
      estado: 'activo', fecha_ingreso: daysAgo(48),
      pedidos: [
        { dias: 6, monto: 65000, monto_pagado: 65000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'economico', descripcion: 'Vianda económica x1 día' },
        { dias: 12, monto: 65000, monto_pagado: 65000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'economico', descripcion: 'Vianda económica x1 día' },
      ],
    },
    {
      nombre_completo: 'Patricia Ovelar', cedula: '3456123', email: 'patricia.ovelar@outlook.com',
      telefono: '0985567890', segmento: 'particular', empresa: null, canal_origen: 'boca_a_boca', codigo_embajador: null,
      estado: 'pausado', fecha_ingreso: daysAgo(140),
      // pausada y sin pedido hace 40 días -> alerta
      pedidos: [
        { dias: 40, monto: 89000, monto_pagado: 89000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable x2 días' },
        { dias: 55, monto: 89000, monto_pagado: 89000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable x2 días' },
      ],
    },
    {
      nombre_completo: 'Javier Cantero', cedula: '4334455', email: 'javier.cantero@gmail.com',
      telefono: '0986678901', segmento: 'particular', empresa: null, canal_origen: 'whatsapp', codigo_embajador: null,
      estado: 'activo', fecha_ingreso: daysAgo(10),
      // cliente nuevo sin pedidos -> no genera alerta
      pedidos: [],
    },
    {
      nombre_completo: 'Rodrigo Paredes', cedula: '4112233', email: 'rodrigo.paredes@medsalud.com.py',
      telefono: '021998877', segmento: 'empresa', empresa: 'Med-Salud S.R.L.', canal_origen: 'b2b', codigo_embajador: null,
      estado: 'activo', fecha_ingreso: daysAgo(75),
      pedidos: [
        { dias: 4, monto: 980000, monto_pagado: 980000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC turno mañana — 18 pax' },
        { dias: 18, monto: 950000, monto_pagado: null, estado_pago: 'pendiente', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC turno mañana — 17 pax' },
      ],
    },
    {
      nombre_completo: 'Sofía Galeano', cedula: '4667788', email: 'sofia.galeano@gmail.com',
      telefono: '0987789012', segmento: 'particular', empresa: null, canal_origen: 'redes', codigo_embajador: null,
      estado: 'inactivo', fecha_ingreso: daysAgo(280),
      // inactiva, último pedido hace 95 días -> alerta
      pedidos: [
        { dias: 95, monto: 70000, monto_pagado: 70000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'low_carb', descripcion: 'Vianda low carb x2 días' },
      ],
    },
    {
      nombre_completo: 'Andrés Villalba', cedula: '3221199', email: 'andres.villalba@gmail.com',
      telefono: '0988890123', segmento: 'particular', empresa: null, canal_origen: 'whatsapp', codigo_embajador: null,
      estado: 'baja', fecha_ingreso: daysAgo(200),
      pedidos: [
        { dias: 130, monto: 60000, monto_pagado: 60000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'economico', descripcion: 'Vianda económica x1 día' },
      ],
    },
  ];

  for (const c of clientes) {
    const info = insertCliente.run(
      c.nombre_completo, c.cedula, c.email, c.telefono,
      c.segmento, c.empresa, c.canal_origen, c.codigo_embajador, c.estado, c.fecha_ingreso
    );
    const clienteId = Number(info.lastInsertRowid);
    for (const p of c.pedidos) {
      insertPedido.run(clienteId, daysAgo(p.dias), p.monto, p.monto_pagado, p.estado_pago, p.medio_pago, p.tipo_vianda, p.descripcion);
    }

    // Si el cliente terminó dado de baja, dejamos su updated_at coherente con el seed
    if (c.estado === 'baja') {
      db.prepare(`
        UPDATE clientes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?) WHERE id = ?
      `).run(`${daysAgo(20)}T12:00:00.000`, clienteId);
    }

    console.log(`  cliente creado: ${c.nombre_completo} (${c.pedidos.length} pedidos)`);
  }
}

console.log('Sembrando usuarios...');
seedUsuarios();
console.log('Sembrando clientes y pedidos...');
seedClientes();
console.log('Listo.');
