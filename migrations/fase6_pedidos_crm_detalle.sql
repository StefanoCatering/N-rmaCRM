-- =============================================================
-- Fase 6 — Tabla destino del sync CRM → Narma Pedidos
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-pedidos (ref rgppcvqoephcjjcnqwnz).
--
-- OJO: esta migración NO va en la base del CRM. Es la única de esta fase
-- que se corre en el proyecto de Pedidos.
--
-- Idempotente (IF NOT EXISTS + guarda sobre pg_constraint).
-- =============================================================


-- ── pedidos_crm_detalle ──────────────────────────────────────
-- Espejo, ya resuelto fecha por fecha, de las líneas de pedido del CRM.
-- El CRM escribe acá con upsert cada vez que se crea/edita/cancela un
-- pedido, una línea o una excepción. Narma Pedidos solo lee.
--
-- Todo viene denormalizado a propósito (cliente_nombre, plato_nombre,
-- ubicacion_direccion, tipo_envase): las dos bases son proyectos Supabase
-- distintos, no hay FK posible entre ellas, y así una fila de producción
-- sigue siendo legible aunque el dato de origen cambie o se borre en el CRM.
--
-- Las columnas crm_* son las claves de origen, para poder re-sincronizar y
-- para rastrear de dónde salió cada fila:
--   crm_pedido_id          → pedidos.id del CRM
--   crm_pedido_detalle_id  → pedido_detalle.id del CRM (la línea)
--   crm_excepcion_id       → pedido_detalle_excepciones.id, si esa fecha
--                            puntual la pisó una excepción; NULL si no.

CREATE TABLE IF NOT EXISTS pedidos_crm_detalle (
  id                     SERIAL PRIMARY KEY,
  crm_pedido_id          INTEGER NOT NULL,
  crm_pedido_detalle_id  INTEGER NOT NULL,
  crm_excepcion_id       INTEGER,
  cliente_nombre         TEXT,
  segmento               TEXT,
  tipo_envase            TEXT,
  plato_nombre           TEXT,
  cantidad               INTEGER,
  fecha_entrega          DATE NOT NULL,
  ubicacion_direccion    TEXT,
  comentario             TEXT,
  cancelado              BOOLEAN NOT NULL DEFAULT false,
  actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- Clave de conflicto del upsert que hace el CRM:
  -- INSERT ... ON CONFLICT (crm_pedido_detalle_id, fecha_entrega) DO UPDATE.
  -- Una línea del CRM produce como máximo una fila por fecha de entrega.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_crm_detalle_unica'
  ) THEN
    ALTER TABLE pedidos_crm_detalle
      ADD CONSTRAINT pedidos_crm_detalle_unica
      UNIQUE (crm_pedido_detalle_id, fecha_entrega);
  END IF;
END $$;

-- Consulta típica de producción: "qué hay que producir tal día".
CREATE INDEX IF NOT EXISTS idx_pedidos_crm_detalle_fecha
  ON pedidos_crm_detalle(fecha_entrega)
  WHERE cancelado = false;

-- Para los UPDATE de cancelación por pedido completo (requisito 9.d).
CREATE INDEX IF NOT EXISTS idx_pedidos_crm_detalle_crm_pedido_id
  ON pedidos_crm_detalle(crm_pedido_id);


-- ── RLS ──────────────────────────────────────────────────────
-- Mismo patrón que el resto de las tablas de narma-pedidos: ENABLE (no FORCE)
-- y sin políticas. El CRM escribe por conexión directa de Postgres con el rol
-- postgres, que no está sujeto a RLS.

ALTER TABLE pedidos_crm_detalle ENABLE ROW LEVEL SECURITY;
