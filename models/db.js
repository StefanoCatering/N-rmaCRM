const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'narma_crm.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

// Schema diseñado con tipos/nombres compatibles con PostgreSQL
// (INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL/IDENTITY, TEXT con CHECK -> enum/CHECK,
//  fechas y timestamps en TEXT ISO 8601 -> DATE/TIMESTAMPTZ)
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol           TEXT NOT NULL CHECK (rol IN ('operador','admin')),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_completo   TEXT NOT NULL,
    cedula            TEXT NOT NULL UNIQUE,
    email             TEXT,
    telefono          TEXT,
    segmento          TEXT NOT NULL CHECK (segmento IN ('particular','empresa')),
    empresa           TEXT,
    canal_origen      TEXT NOT NULL CHECK (canal_origen IN ('whatsapp','redes','embajador','boca_a_boca','b2b','otro')),
    codigo_embajador  TEXT,
    estado            TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado','inactivo','baja')),
    fecha_ingreso     TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id    INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    fecha_pedido  TEXT NOT NULL,
    monto         INTEGER NOT NULL,
    monto_pagado  INTEGER,
    estado_pago   TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_pago IN ('pagado','pendiente')),
    medio_pago    TEXT CHECK (medio_pago IN ('efectivo','transferencia','tarjeta','pos')),
    tipo_vianda   TEXT CHECK (tipo_vianda IN ('economico','saludable','low_carb')),
    descripcion   TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id ON pedidos(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_pedidos_fecha ON pedidos(fecha_pedido);
  CREATE INDEX IF NOT EXISTS idx_clientes_estado ON clientes(estado);
  CREATE INDEX IF NOT EXISTS idx_clientes_segmento ON clientes(segmento);
  CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes(empresa);
`);

// ── Migraciones incrementales (ALTER TABLE) ──────────────────────
// Agregan columnas a bases ya existentes sin recrear tablas ni perder datos.
// Cada bloque verifica primero si la columna ya existe (PRAGMA table_info)
// para que sea seguro ejecutar esto en cada arranque del servidor.
function columnaExiste(tabla, columna) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
}

if (!columnaExiste('clientes', 'seguimiento_marcado')) {
  db.exec('ALTER TABLE clientes ADD COLUMN seguimiento_marcado INTEGER NOT NULL DEFAULT 0;');
}
if (!columnaExiste('clientes', 'seguimiento_fecha')) {
  db.exec('ALTER TABLE clientes ADD COLUMN seguimiento_fecha TEXT;');
}

module.exports = db;
