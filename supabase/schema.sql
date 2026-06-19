-- =============================================================
-- Närma CRM — Schema PostgreSQL (Supabase)
-- Ejecutar una sola vez en el SQL Editor de Supabase.
-- Todas las sentencias son idempotentes (IF NOT EXISTS).
-- =============================================================

-- ── Tablas ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('operador','admin','visor')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clientes (
  id                  SERIAL PRIMARY KEY,
  nombre_completo     TEXT NOT NULL,
  cedula              TEXT NOT NULL UNIQUE,
  email               TEXT,
  telefono            TEXT,
  segmento            TEXT NOT NULL CHECK (segmento IN ('particular','empresa')),
  empresa             TEXT,
  canal_origen        TEXT NOT NULL CHECK (canal_origen IN ('whatsapp','redes','embajador','boca_a_boca','b2b','otro')),
  codigo_embajador    TEXT,
  estado              TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado','inactivo','baja')),
  fecha_ingreso       DATE NOT NULL,
  seguimiento_marcado INTEGER NOT NULL DEFAULT 0,
  seguimiento_fecha   DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos (
  id            SERIAL PRIMARY KEY,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha_pedido  DATE NOT NULL,
  monto         INTEGER NOT NULL,
  monto_pagado  INTEGER,
  estado_pago   TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_pago IN ('pagado','pendiente','parcial')),
  medio_pago    TEXT CHECK (medio_pago IN ('efectivo','transferencia','tarjeta','pos')),
  tipo_vianda   TEXT CHECK (tipo_vianda IN ('economico','saludable','low_carb')),
  descripcion   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabla de sesiones (connect-pg-simple) ────────────────────
-- Estructura exacta que espera la librería connect-pg-simple.
-- Nota: el table.sql original de la librería usa WITH (OIDS=FALSE)
-- que fue eliminado en PostgreSQL 14 — aquí se omite para PG 15+.
-- La PRIMARY KEY va inline para que sea idempotente con IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar     NOT NULL,
  "sess"   json        NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ── Índices de negocio ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha       ON pedidos(fecha_pedido);
CREATE INDEX IF NOT EXISTS idx_clientes_estado     ON clientes(estado);
CREATE INDEX IF NOT EXISTS idx_clientes_segmento   ON clientes(segmento);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa    ON clientes(empresa);
