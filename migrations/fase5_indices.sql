-- =============================================================
-- Fase 5 — Hardening: índices de negocio en pedidos
-- Ejecutar manualmente en el SQL Editor de Supabase (proyecto narma-crm).
-- Idempotente (IF NOT EXISTS): correrlo más de una vez no da error.
--
-- Volumen actual chico (557 pedidos) — no es un problema hoy, pero el
-- costo de crear estos índices es prácticamente nulo y ambas columnas
-- se usan como filtro en /api/pedidos (estado_pago, tipo_vianda).
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_pedidos_estado_pago ON pedidos(estado_pago);
CREATE INDEX IF NOT EXISTS idx_pedidos_tipo_vianda  ON pedidos(tipo_vianda);
