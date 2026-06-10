-- =============================================================
-- Närma CRM — Migración: observaciones del cliente
-- Ejecutar una sola vez en el SQL Editor de Supabase.
-- Idempotente (IF NOT EXISTS).
-- =============================================================

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS observaciones TEXT;
