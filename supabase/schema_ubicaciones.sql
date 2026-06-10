-- =============================================================
-- Närma CRM — Migración: ubicaciones de entrega por cliente
-- Ejecutar una sola vez en el SQL Editor de Supabase.
-- Idempotente (IF NOT EXISTS).
-- =============================================================

CREATE TABLE IF NOT EXISTS ubicaciones (
  id          SERIAL PRIMARY KEY,
  cliente_id  INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  orden       INTEGER NOT NULL DEFAULT 1,
  direccion   TEXT,
  zona        TEXT,
  referencia  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ubicaciones_cliente_id ON ubicaciones(cliente_id);
