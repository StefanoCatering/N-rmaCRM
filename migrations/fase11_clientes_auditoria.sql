-- =============================================================
-- Fase 11 — Auditoría de estado de clientes (CRM)
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-crm (ref bjnwremoaooglpxrnzgi).
--
-- Idempotente: se puede correr más de una vez sin error y sin efectos
-- adicionales (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS y
-- ENABLE ROW LEVEL SECURITY, que ya es un no-op sobre una tabla con RLS
-- habilitado).
--
-- Qué agrega: la bitácora del activar / desactivar cliente que ahora hace ATC
-- (antes era un cambio de estado libre, solo admin y sin registro).
--
-- NO toca el CHECK de clientes.estado: los cuatro valores ('activo',
-- 'pausado', 'inactivo', 'baja') siguen siendo válidos en la base. Lo que se
-- angosta es el endpoint, que solo acepta 'activo' e 'inactivo' — 'pausado' y
-- 'baja' quedan como estados históricos que la ficha sabe mostrar (hoy no hay
-- ningún cliente en ninguno de los dos).
-- =============================================================


-- ── 1. clientes_auditoria ────────────────────────────────────
-- Una fila por cambio de estado: qué cliente, de qué estado a qué estado,
-- quién y por qué. Mismo patrón que pedidos_auditoria (fase 8): usuario es el
-- USERNAME, no el id, para que el historial siga siendo legible aunque
-- después se renombre o se desactive a la persona.
--
-- accion: hoy siempre 'cambio_estado'. Queda como texto libre y sin CHECK a
-- propósito: es el campo por el que van a entrar los próximos movimientos de
-- la ficha (una fusión de clientes, un cambio de empresa) sin necesitar otra
-- migración. Lo que se escribe lo decide routes/clientes.js.
--
-- motivo NOT NULL: acá el motivo SIEMPRE lo escribe una persona que está
-- desactivando o reactivando un cliente a mano, así que no hay un caso como
-- la 'creacion' de pedidos_auditoria (fase 8) que no tenga nada que
-- justificar. El endpoint además lo exige no vacío antes de tocar la base.
--
-- estado_antes / estado_despues nullable: no hacen falta para que la fila
-- tenga sentido y dejan lugar a futuras acciones que no cambien el estado.
--
-- cliente_id REFERENCES clientes(id) sin ON DELETE: los clientes no se
-- borran, justamente se desactivan — de eso se trata esta fase. Si algún día
-- hubiera que borrar uno de verdad, que la FK lo frene y obligue a decidir
-- qué hacer con su historial es mejor que perderlo en silencio.

CREATE TABLE IF NOT EXISTS clientes_auditoria (
  id             SERIAL PRIMARY KEY,
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
  accion         TEXT NOT NULL,
  usuario        TEXT NOT NULL,
  estado_antes   TEXT,
  estado_despues TEXT,
  motivo         TEXT NOT NULL,
  fecha          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La ficha del cliente lee SIEMPRE el historial de UN cliente ordenado por
-- fecha descendente (GET /api/clientes/:id/auditoria): el índice cubre el
-- filtro y el orden de una sola vez.
CREATE INDEX IF NOT EXISTS idx_clientes_auditoria_cliente_fecha
  ON clientes_auditoria(cliente_id, fecha DESC);


-- ── 2. RLS ───────────────────────────────────────────────────
-- Mismo patrón que el resto de las tablas public del proyecto (ver la
-- migración enable_rls_all_public_tables, ya aplicada en la base): ENABLE (no
-- FORCE) y sin políticas. El backend entra con el rol postgres, que no está
-- sujeto a RLS; esto solo cierra la API REST de Supabase con las claves
-- anon/publishable.

ALTER TABLE clientes_auditoria ENABLE ROW LEVEL SECURITY;
