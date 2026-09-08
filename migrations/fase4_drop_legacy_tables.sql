-- =============================================================
-- Fase 4 — Drop de tablas legacy / huérfanas (proyecto narma-crm)
-- Ejecutar manualmente en el SQL Editor de Supabase.
-- Idempotente (IF EXISTS): correrlo más de una vez no da error.
--
-- Verificación previa (grep sobre todo el repo N-rmaCRM, 2026-09-08):
--   - "session" (connect-pg-simple): sin referencias a connect-pg-simple,
--     req.session ni express-session en el código. La auth es 100% JWT
--     (cookie narma_token) desde hace tiempo. Tabla sin uso.
--   - Las 6 tablas huérfanas de abajo: 0 filas, esquema idéntico a tablas
--     homónimas del proyecto narma-pedidos (que sí las usa con datos
--     reales) — son residuos de aprovisionamiento del proyecto narma-crm,
--     no están definidas en supabase/schema.sql y ningún archivo de
--     rutas/queries de este repo las referencia.
-- =============================================================

-- ── Sesiones legacy (connect-pg-simple, reemplazado por JWT) ────
DROP TABLE IF EXISTS "session";

-- ── Tablas huérfanas de aprovisionamiento ───────────────────────
-- Orden pensado para respetar FKs hacia usuarios/pedidos.
DROP TABLE IF EXISTS pedidos_items;
DROP TABLE IF EXISTS produccion_aymac;
DROP TABLE IF EXISTS sesiones;
DROP TABLE IF EXISTS menus_aymac;
DROP TABLE IF EXISTS catalogo;
DROP TABLE IF EXISTS catalogo_items;
