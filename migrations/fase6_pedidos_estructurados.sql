-- =============================================================
-- Fase 6 — Pedidos estructurados (CRM)
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-crm (ref bjnwremoaooglpxrnzgi).
--
-- Idempotente: se puede correr más de una vez sin error y sin efectos
-- adicionales (IF NOT EXISTS + guardas sobre pg_constraint +
-- ON CONFLICT DO NOTHING + WHERE que deja de matchear).
--
-- IMPORTANTE: antes de esta migración quedan pendientes de correr
-- (ver HANDOFF.md):
--   migrations/fase4_fix_monto_pagado.sql
--   migrations/fase4_drop_legacy_tables.sql
--   migrations/fase5_indices.sql
-- Esta migración no depende de ellas, pero conviene correrlas en orden.
--
-- La tabla pedidos_crm_detalle del proyecto narma-pedidos va aparte:
--   migrations/fase6_pedidos_crm_detalle.sql
-- =============================================================


-- ── 1. platos ────────────────────────────────────────────────
-- Catálogo de platos que la ATC elige al cargar una línea de pedido.
-- Diseñada para recibir altas desde el SQL Editor sin tocar código:
-- cualquier INSERT de (categoria, nombre) nuevo aparece solo en el form.
-- activo INTEGER (0/1) por consistencia con clientes.seguimiento_marcado.

CREATE TABLE IF NOT EXISTS platos (
  id         SERIAL PRIMARY KEY,
  categoria  TEXT NOT NULL,
  nombre     TEXT NOT NULL,
  activo     INTEGER NOT NULL DEFAULT 1
);

-- (categoria, nombre) único: evita duplicados por recarga del seed y hace
-- idempotente el INSERT de abajo vía ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platos_categoria_nombre ON platos(categoria, nombre);
CREATE INDEX IF NOT EXISTS idx_platos_activo ON platos(activo);

-- Seed inicial. "Pollo Grille" queda como categoría con una fila placeholder:
-- la lista final de guarniciones se cierra después y se carga con INSERTs a
-- esta misma tabla, sin deploy.
INSERT INTO platos (categoria, nombre) VALUES
  ('Básicos',      'Saludable'),
  ('Básicos',      'Low carb'),
  ('Básicos',      'Estándar'),
  ('Ensaladas',    'César'),
  ('Ensaladas',    'Proteica'),
  ('Wraps',        'Bondiola'),
  ('Wraps',        'Carne'),
  ('Wraps',        'César'),
  ('Wraps',        'Bigpollo'),
  ('Pollo Grille', 'A definir')
ON CONFLICT (categoria, nombre) DO NOTHING;


-- ── 2. clientes.tipo_envase ──────────────────────────────────
-- Envase en el que se entrega el pedido del cliente.
-- NO toca clientes.segmento: son dos ejes distintos.

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_envase TEXT NOT NULL DEFAULT 'Venezia';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clientes_tipo_envase_check'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT clientes_tipo_envase_check CHECK (tipo_envase IN ('Narma','Venezia'));
  END IF;
END $$;

-- Migración de datos.
-- Estado real de clientes.empresa al 2026-10-13 (408 clientes):
--   'UENO BANK' 194 · 'Bayer' 100 · 'Kaitel' 30 · 'Itti SAE' 3 · 'UENO' 1
-- Los valores están limpios: sin espacios en los bordes y sin variantes de
-- mayúsculas. La única variante real es 'UENO' (1 cliente), que es la misma
-- empresa cargada corto.
--
-- 2.a — Normalizar 'UENO' → 'UENO BANK' para que la empresa no quede partida
--       en los filtros de /clientes ni en la ficha de colaboradores.
UPDATE clientes
SET empresa = 'UENO BANK'
WHERE regexp_replace(btrim(coalesce(empresa, '')), '\s+', ' ', 'g') ILIKE 'UENO'
  AND empresa <> 'UENO BANK';

-- 2.b — Marcar envase Narma. regexp_replace + btrim tolera espacios de más y
--       el ILIKE tolera mayúsculas, por si entran variantes nuevas antes de
--       correr esto. Si más adelante aparece otra empresa con envase Narma,
--       se agrega al ARRAY y se vuelve a correr este UPDATE.
UPDATE clientes
SET tipo_envase = 'Narma'
WHERE regexp_replace(btrim(coalesce(empresa, '')), '\s+', ' ', 'g')
      ILIKE ANY (ARRAY['UENO BANK', 'Kaitel', 'Itti SAE'])
  AND tipo_envase <> 'Narma';


-- ── 3. pedidos.ubicacion_id ──────────────────────────────────
-- Ubicación de entrega elegida entre las ubicaciones guardadas del cliente.
-- ON DELETE SET NULL: un pedido histórico no debe bloquear la edición de las
-- ubicaciones del cliente. La dirección concreta se denormaliza en
-- pedidos_crm_detalle.ubicacion_direccion, así que narma-pedidos conserva el
-- dato aunque después se borre la ubicación.
-- (models/ubicaciones.js replaceForCliente se cambió en esta misma fase para
-- actualizar por orden en vez de DELETE + INSERT, y así preservar los ids.)

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ubicacion_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_ubicacion_id_fkey'
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT pedidos_ubicacion_id_fkey
      FOREIGN KEY (ubicacion_id) REFERENCES ubicaciones(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pedidos_ubicacion_id ON pedidos(ubicacion_id);


-- ── 4. pedido_detalle ────────────────────────────────────────
-- Una fila por línea de pedido (plato + cantidad + comentario + modo + fechas).
-- Reemplaza la captura por texto libre (pedidos.descripcion / tipo_vianda),
-- que se mantiene intacta para no romper el dashboard histórico.
--
-- cancelado: no estaba en la lista de columnas pedida, pero hace falta para
-- poder cancelar UNA línea sin cancelar el pedido entero (requisito 9.d,
-- "al cancelar un pedido o una línea"). Es el espejo de pedidos.cancelado.

CREATE TABLE IF NOT EXISTS pedido_detalle (
  id                    SERIAL PRIMARY KEY,
  pedido_id             INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  plato_id              INTEGER NOT NULL REFERENCES platos(id),
  cantidad              INTEGER NOT NULL,
  comentario            TEXT,
  modo                  TEXT NOT NULL CHECK (modo IN ('puntual','recurrente')),
  fecha_entrega         DATE,
  fecha_desde           DATE,
  fecha_hasta           DATE,
  tipo_envase_override  TEXT,
  cancelado             BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_detalle_cantidad_check') THEN
    ALTER TABLE pedido_detalle
      ADD CONSTRAINT pedido_detalle_cantidad_check CHECK (cantidad > 0);
  END IF;

  -- tipo_envase_override: 'Narma', 'Venezia' o NULL (NULL = hereda el del
  -- cliente). Un CHECK con IN pasa cuando el valor es NULL, así que no hace
  -- falta un OR ... IS NULL explícito.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_detalle_tipo_envase_override_check') THEN
    ALTER TABLE pedido_detalle
      ADD CONSTRAINT pedido_detalle_tipo_envase_override_check
      CHECK (tipo_envase_override IN ('Narma','Venezia'));
  END IF;

  -- Las fechas que corresponden según el modo, y nada más:
  --   puntual    → fecha_entrega obligatoria, fecha_desde/hasta NULL
  --   recurrente → fecha_desde/hasta obligatorias y ordenadas, fecha_entrega NULL
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_detalle_fechas_check') THEN
    ALTER TABLE pedido_detalle
      ADD CONSTRAINT pedido_detalle_fechas_check CHECK (
        (modo = 'puntual'
           AND fecha_entrega IS NOT NULL
           AND fecha_desde IS NULL AND fecha_hasta IS NULL)
        OR
        (modo = 'recurrente'
           AND fecha_entrega IS NULL
           AND fecha_desde IS NOT NULL AND fecha_hasta IS NOT NULL
           AND fecha_hasta >= fecha_desde)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pedido_detalle_pedido_id ON pedido_detalle(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_detalle_plato_id  ON pedido_detalle(plato_id);


-- ── 5. pedido_detalle_excepciones ────────────────────────────
-- Pisa una fecha puntual de una línea RECURRENTE.
-- NULL en plato_id / cantidad / comentario = "sin cambio": se hereda de la línea.
-- omitir = true → ese día no se produce nada de esa línea.
--
-- "solo aplica si la línea es modo=recurrente" no se puede expresar en un CHECK
-- de tabla (necesitaría leer pedido_detalle). Se valida en la capa de aplicación:
-- routes/pedidos.js rechaza excepciones sobre líneas puntuales.

CREATE TABLE IF NOT EXISTS pedido_detalle_excepciones (
  id                 SERIAL PRIMARY KEY,
  pedido_detalle_id  INTEGER NOT NULL REFERENCES pedido_detalle(id) ON DELETE CASCADE,
  fecha              DATE NOT NULL,
  plato_id           INTEGER REFERENCES platos(id),
  cantidad           INTEGER,
  comentario         TEXT,
  omitir             BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_detalle_excepciones_cantidad_check') THEN
    ALTER TABLE pedido_detalle_excepciones
      ADD CONSTRAINT pedido_detalle_excepciones_cantidad_check
      CHECK (cantidad IS NULL OR cantidad > 0);
  END IF;

  -- Una sola excepción por línea y fecha: hace determinística la resolución de
  -- fechas del sync (no hay dos excepciones compitiendo por el mismo día).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_detalle_excepciones_unica') THEN
    ALTER TABLE pedido_detalle_excepciones
      ADD CONSTRAINT pedido_detalle_excepciones_unica UNIQUE (pedido_detalle_id, fecha);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pde_pedido_detalle_id ON pedido_detalle_excepciones(pedido_detalle_id);


-- ── 6. sync_errores ──────────────────────────────────────────
-- Bitácora local de intentos fallidos de escritura hacia narma-pedidos.
-- Sin FK a propósito: este log tiene que poder escribirse siempre, incluso si
-- el pedido se borró después o si el id que se intentó sincronizar ya no
-- existe. Es el insumo para reintentar a mano.

CREATE TABLE IF NOT EXISTS sync_errores (
  id                 SERIAL PRIMARY KEY,
  pedido_id          INTEGER,
  pedido_detalle_id  INTEGER,
  fecha              DATE,
  payload            JSONB,
  error              TEXT,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_errores_creado_en ON sync_errores(creado_en);
CREATE INDEX IF NOT EXISTS idx_sync_errores_pedido_id ON sync_errores(pedido_id);


-- ── 7. RLS ───────────────────────────────────────────────────
-- Mismo patrón que las tablas existentes del proyecto: ENABLE (no FORCE) y sin
-- políticas. El acceso real pasa por el backend con el rol postgres, que no
-- está sujeto a RLS; esto solo cierra la puerta de la API REST de Supabase con
-- las claves anon/publishable.

ALTER TABLE platos                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedido_detalle             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedido_detalle_excepciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_errores               ENABLE ROW LEVEL SECURITY;
