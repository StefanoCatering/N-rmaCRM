-- =============================================================
-- Närma CRM — Migración: cancelación y auditoría de pedidos
-- Ejecutar una sola vez en el SQL Editor de Supabase.
-- Idempotente (IF NOT EXISTS).
-- =============================================================

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS pedidos_auditoria (
  id          SERIAL PRIMARY KEY,
  pedido_id   INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  accion      TEXT NOT NULL CHECK (accion IN ('edicion','cancelacion')),
  usuario     TEXT NOT NULL,
  detalle     JSONB,
  motivo      TEXT NOT NULL,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_auditoria_pedido_id ON pedidos_auditoria(pedido_id);
