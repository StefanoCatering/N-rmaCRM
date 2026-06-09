// Crea los usuarios iniciales y un set de clientes/pedidos de ejemplo
// para poder probar el sistema desde el primer arranque.
//
// IDEMPOTENTE: se puede correr múltiples veces sin duplicar datos ni tirar error.
//   - Usuarios:  se salta si el username ya existe.
//   - Clientes:  se salta si la cédula ya existe.
//   - Pedidos:   se insertan solo si el cliente fue insertado en esta ejecución.
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./models/db');

const SALT_ROUNDS = 10;

function isoDate(d) { return d.toISOString().slice(0, 10); }

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

// ── Migración de schema ───────────────────────────────────────────
// Amplía el CHECK constraint de usuarios.rol para incluir el rol 'visor'.
// Es idempotente: si el constraint ya incluye 'visor', no hace nada.

async function migrateSchema() {
  await pool.query(`
    DO $$
    DECLARE c record;
    BEGIN
      -- Dropear cualquier CHECK constraint sobre rol que no incluya 'visor'
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'usuarios'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%rol%'
          AND pg_get_constraintdef(oid) NOT LIKE '%visor%'
      LOOP
        EXECUTE format('ALTER TABLE usuarios DROP CONSTRAINT %I', c.conname);
      END LOOP;
      -- Agregar el nuevo constraint con visor si todavía no existe
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'usuarios'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%visor%'
      ) THEN
        ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
          CHECK (rol IN ('operador', 'admin', 'visor'));
      END IF;
    END $$
  `);
  console.log('  schema migrado: usuarios.rol incluye visor');
}

// ── Usuarios ──────────────────────────────────────────────────────

async function seedUsuarios() {
  const usuarios = [
    { username: 'NarmaAdmin', password: 'narma2025', rol: 'operador' },
    { username: 'Stefano',    password: 'narma2025', rol: 'admin'    },
    { username: 'Guadalupe',  password: 'narma2025', rol: 'admin'    },
    { username: 'Direccion',  password: 'narma2025', rol: 'visor'    },
  ];

  for (const u of usuarios) {
    const existe = (await pool.query('SELECT 1 FROM usuarios WHERE username = $1', [u.username])).rows.length > 0;
    if (existe) {
      console.log(`  usuario ya existe, se omite: ${u.username}`);
      continue;
    }
    const hash = bcrypt.hashSync(u.password, SALT_ROUNDS);
    await pool.query(
      'INSERT INTO usuarios (username, password_hash, rol) VALUES ($1, $2, $3)',
      [u.username, hash, u.rol]
    );
    console.log(`  usuario creado: ${u.username} (${u.rol})`);
  }
}

// ── Clientes y pedidos ────────────────────────────────────────────

async function seedClientes() {
  const clientes = [
    {
      nombre_completo: 'Lucía Benítez', cedula: '4123456', email: 'lucia.benitez@gmail.com',
      telefono: '0981123456', segmento: 'particular', empresa: null, canal_origen: 'whatsapp',
      codigo_embajador: null, estado: 'activo', fecha_ingreso: daysAgo(160),
      pedidos: [
        { dias: 3,  monto: 185000, monto_pagado: 185000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable semanal x5' },
        { dias: 17, monto: 185000, monto_pagado: 185000, estado_pago: 'pagado',   medio_pago: 'efectivo',      tipo_vianda: 'saludable', descripcion: 'Vianda saludable semanal x5' },
        { dias: 31, monto:  92000, monto_pagado:  92000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable x2 días' },
      ],
    },
    {
      nombre_completo: 'Carlos Domínguez', cedula: '3987654', email: 'cdominguez@yguazu.com.py',
      telefono: '0982234567', segmento: 'empresa', empresa: 'Yguazú S.A.', canal_origen: 'b2b',
      codigo_embajador: null, estado: 'activo', fecha_ingreso: daysAgo(220),
      pedidos: [
        { dias:  2, monto: 1450000, monto_pagado:    null, estado_pago: 'pendiente', medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 25 pax' },
        { dias: 16, monto: 1450000, monto_pagado: 1450000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 25 pax' },
        { dias: 30, monto: 1380000, monto_pagado: 1380000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 24 pax' },
        { dias: 44, monto: 1450000, monto_pagado: 1450000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC oficina — 25 pax' },
      ],
    },
    {
      nombre_completo: 'Marcela Acosta', cedula: '4556677', email: 'marcela.acosta@hotmail.com',
      telefono: '0983345678', segmento: 'particular', empresa: null, canal_origen: 'redes',
      codigo_embajador: null, estado: 'activo', fecha_ingreso: daysAgo(95),
      // sin pedido hace 22 días → debe disparar alerta
      pedidos: [
        { dias: 22, monto:  78000, monto_pagado:  78000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'low_carb', descripcion: 'Vianda low carb x2 días' },
        { dias: 36, monto: 117000, monto_pagado: 117000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'low_carb', descripcion: 'Vianda low carb x3 días' },
      ],
    },
    {
      nombre_completo: 'Marta Cuevas', cedula: '3998877', email: 'marta.cuevas@yguazu.com.py',
      telefono: '021556677', segmento: 'empresa', empresa: 'Yguazú S.A.', canal_origen: 'b2b',
      codigo_embajador: null, estado: 'activo', fecha_ingreso: daysAgo(310),
      pedidos: [
        { dias:   5, monto: 2100000, monto_pagado: 2100000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC evento corporativo' },
        { dias:  60, monto: 1980000, monto_pagado: 1980000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC evento corporativo' },
        { dias: 118, monto: 2050000, monto_pagado: 1500000, estado_pago: 'pendiente',medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC evento corporativo (pago parcial)' },
      ],
    },
    {
      nombre_completo: 'Diego Ramírez', cedula: '4778899', email: 'diego.ramirez@gmail.com',
      telefono: '0984456789', segmento: 'particular', empresa: null, canal_origen: 'embajador',
      codigo_embajador: 'EMB-014', estado: 'activo', fecha_ingreso: daysAgo(48),
      pedidos: [
        { dias:  6, monto: 65000, monto_pagado: 65000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'economico', descripcion: 'Vianda económica x1 día' },
        { dias: 12, monto: 65000, monto_pagado: 65000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'economico', descripcion: 'Vianda económica x1 día' },
      ],
    },
    {
      nombre_completo: 'Patricia Ovelar', cedula: '3456123', email: 'patricia.ovelar@outlook.com',
      telefono: '0985567890', segmento: 'particular', empresa: null, canal_origen: 'boca_a_boca',
      codigo_embajador: null, estado: 'pausado', fecha_ingreso: daysAgo(140),
      // pausada, último pedido hace 40 días → alerta
      pedidos: [
        { dias: 40, monto: 89000, monto_pagado: 89000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable x2 días' },
        { dias: 55, monto: 89000, monto_pagado: 89000, estado_pago: 'pagado', medio_pago: 'transferencia', tipo_vianda: 'saludable', descripcion: 'Vianda saludable x2 días' },
      ],
    },
    {
      nombre_completo: 'Javier Cantero', cedula: '4334455', email: 'javier.cantero@gmail.com',
      telefono: '0986678901', segmento: 'particular', empresa: null, canal_origen: 'whatsapp',
      codigo_embajador: null, estado: 'activo', fecha_ingreso: daysAgo(10),
      // cliente nuevo sin pedidos → no genera alerta
      pedidos: [],
    },
    {
      nombre_completo: 'Rodrigo Paredes', cedula: '4112233', email: 'rodrigo.paredes@medsalud.com.py',
      telefono: '021998877', segmento: 'empresa', empresa: 'Med-Salud S.R.L.', canal_origen: 'b2b',
      codigo_embajador: null, estado: 'activo', fecha_ingreso: daysAgo(75),
      pedidos: [
        { dias:  4, monto: 980000, monto_pagado: 980000, estado_pago: 'pagado',   medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC turno mañana — 18 pax' },
        { dias: 18, monto: 950000, monto_pagado:    null, estado_pago: 'pendiente',medio_pago: 'transferencia', tipo_vianda: null, descripcion: 'Buffet AYMAC turno mañana — 17 pax' },
      ],
    },
    {
      nombre_completo: 'Sofía Galeano', cedula: '4667788', email: 'sofia.galeano@gmail.com',
      telefono: '0987789012', segmento: 'particular', empresa: null, canal_origen: 'redes',
      codigo_embajador: null, estado: 'inactivo', fecha_ingreso: daysAgo(280),
      // inactiva, último pedido hace 95 días → alerta
      pedidos: [
        { dias: 95, monto: 70000, monto_pagado: 70000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'low_carb', descripcion: 'Vianda low carb x2 días' },
      ],
    },
    {
      nombre_completo: 'Andrés Villalba', cedula: '3221199', email: 'andres.villalba@gmail.com',
      telefono: '0988890123', segmento: 'particular', empresa: null, canal_origen: 'whatsapp',
      codigo_embajador: null, estado: 'baja', fecha_ingreso: daysAgo(200),
      pedidos: [
        { dias: 130, monto: 60000, monto_pagado: 60000, estado_pago: 'pagado', medio_pago: 'efectivo', tipo_vianda: 'economico', descripcion: 'Vianda económica x1 día' },
      ],
    },
  ];

  for (const c of clientes) {
    // Idempotencia: si la cédula ya existe se salta este cliente (y sus pedidos)
    const existe = (await pool.query('SELECT 1 FROM clientes WHERE cedula = $1', [c.cedula])).rows.length > 0;
    if (existe) {
      console.log(`  cliente ya existe, se omite: ${c.nombre_completo}`);
      continue;
    }

    const clienteResult = await pool.query(`
      INSERT INTO clientes
        (nombre_completo, cedula, email, telefono, segmento, empresa, canal_origen, codigo_embajador, estado, fecha_ingreso)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      c.nombre_completo, c.cedula, c.email, c.telefono,
      c.segmento, c.empresa, c.canal_origen, c.codigo_embajador, c.estado, c.fecha_ingreso,
    ]);
    const clienteId = clienteResult.rows[0].id;

    for (const p of c.pedidos) {
      await pool.query(`
        INSERT INTO pedidos
          (cliente_id, fecha_pedido, monto, monto_pagado, estado_pago, medio_pago, tipo_vianda, descripcion)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [clienteId, daysAgo(p.dias), p.monto, p.monto_pagado ?? null, p.estado_pago, p.medio_pago, p.tipo_vianda, p.descripcion]);
    }

    // Clientes dados de baja: sincronizar updated_at para que los KPIs sean coherentes
    if (c.estado === 'baja') {
      await pool.query(
        'UPDATE clientes SET updated_at = $1::timestamptz WHERE id = $2',
        [`${daysAgo(20)}T12:00:00.000Z`, clienteId]
      );
    }

    console.log(`  cliente creado: ${c.nombre_completo} (${c.pedidos.length} pedidos)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  try {
    console.log('Migrando schema...');
    await migrateSchema();
    console.log('Sembrando usuarios...');
    await seedUsuarios();
    console.log('Sembrando clientes y pedidos...');
    await seedClientes();
    console.log('Listo.');
  } catch (err) {
    console.error('Error durante el seed:', err.message || err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
