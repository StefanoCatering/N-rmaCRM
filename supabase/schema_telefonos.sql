-- =============================================================
-- Närma CRM — Migración: teléfonos adicionales por cliente
-- Ejecutar una sola vez en el SQL Editor de Supabase.
-- Idempotente (IF NOT EXISTS).
-- =============================================================

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefono2 TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefono3 TEXT;
