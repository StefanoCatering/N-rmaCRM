-- =============================================================
-- Fase 7 — Grilla semanal de comedor corporativo (CRM)
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-crm (ref bjnwremoaooglpxrnzgi).
--
-- Idempotente: se puede correr más de una vez sin error y sin efectos
-- adicionales (IF NOT EXISTS + guardas sobre pg_constraint +
-- ON CONFLICT DO NOTHING + WHERE que deja de matchear).
--
-- Reemplaza el Excel semanal de UENO / Kaitel / Itti: una grilla
-- colaborador × lunes-viernes donde ATC solo marca DIFERENCIAS, y el CRM
-- calcula los totales por (plato, fecha) y los manda a cocina como UN pedido
-- semanal por empresa (origen = 'grilla'), vía el sync de la fase 6.
--
-- Esta es la ÚNICA migración de la fase 7, y va toda en la base del CRM.
-- La tabla destino del sync (pedidos_crm_detalle) sigue siendo del proyecto
-- narma-pedidos: desde acá solo se la escribe, nunca se la migra.
--
-- NO inserta filas en grilla_empresas a propósito: el cliente "cuenta empresa"
-- de cada comedor se crea desde la UI y se vincula después con un INSERT
-- manual (ver el ejemplo comentado al final de la sección 2).
-- =============================================================


-- ── 1. usuarios.gestiona_grilla ──────────────────────────────
-- Permiso de EDICIÓN de la grilla. Es un eje distinto del rol: Admin1 es
-- 'operador' en la base, y es quien edita la grilla; los admin y el visor
-- solo la ven.
--
-- Se guarda en la base (y no solo en el JWT) a propósito: el backend lo lee en
-- cada request de escritura, así sacarle el permiso a alguien aplica en el
-- acto y no cuando se le vence el token.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS gestiona_grilla BOOLEAN NOT NULL DEFAULT false;

UPDATE usuarios SET gestiona_grilla = true WHERE username = 'Admin1' AND gestiona_grilla = false;


-- ── 2. grilla_empresas ───────────────────────────────────────
-- Qué empresas tienen comedor con grilla, y a qué cliente se le carga el
-- pedido semanal.
--
-- empresa: el MISMO valor que clientes.empresa (sin FK: clientes.empresa es
--   texto libre, no una tabla). Los valores vigentes al 2026-10-15 son
--   'UENO BANK', 'Kaitel', 'Itti SAE' y 'Bayer'.
-- cliente_pedido_id: el cliente "cuenta empresa", dueño del pedido semanal.
--   De él salen el nombre y el envase que ve cocina (clientes.tipo_envase).
--   Sin ON DELETE: borrar la cuenta empresa dejaría la grilla sin destino, y
--   es mejor que la base lo impida a que el pedido semanal quede huérfano.
-- ubicacion_id: dónde se entrega. Debería ser una de las ubicaciones de
--   cliente_pedido_id (no se puede exigir en un CHECK sin leer otra tabla; lo
--   valida la aplicación al enviar). ON DELETE SET NULL para que editar las
--   ubicaciones del cliente no bloquee nada.

CREATE TABLE IF NOT EXISTS grilla_empresas (
  empresa           TEXT PRIMARY KEY,
  cliente_pedido_id INTEGER NOT NULL REFERENCES clientes(id),
  ubicacion_id      INTEGER REFERENCES ubicaciones(id) ON DELETE SET NULL,
  activa            BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_grilla_empresas_cliente ON grilla_empresas(cliente_pedido_id);

-- Vinculación manual, una vez creado el cliente cuenta-empresa desde la UI:
--
--   INSERT INTO grilla_empresas (empresa, cliente_pedido_id, ubicacion_id)
--   VALUES ('UENO BANK', <id del cliente cuenta empresa>, <id de su ubicación>)
--   ON CONFLICT (empresa) DO UPDATE
--     SET cliente_pedido_id = EXCLUDED.cliente_pedido_id,
--         ubicacion_id      = EXCLUDED.ubicacion_id;


-- ── 3. grilla_planes ─────────────────────────────────────────
-- Un colaborador adherido al comedor, con su plato base.
--
-- La empresa del plan NO se duplica acá: es clientes.empresa. Un colaborador
-- tiene un solo plan (cliente_id es la PK), así que cambiar de empresa cambia
-- de grilla sin tocar esta tabla.
--
-- Vigencia: un colaborador está activo en una fecha si
--   fecha_alta <= fecha AND (fecha_baja IS NULL OR fecha < fecha_baja)
-- fecha_baja es EXCLUSIVA (el primer día que ya NO come), por eso el CHECK
-- permite fecha_baja = fecha_alta: es un alta que se deshace el mismo día.
--
-- observacion: nota fija del colaborador (ej. "no consume cerdo"). No cambia
-- lo que se cocina — sale impresa en la hoja del día, para armar en el banco.

CREATE TABLE IF NOT EXISTS grilla_planes (
  cliente_id    INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  plato_base_id INTEGER NOT NULL REFERENCES platos(id),
  observacion   TEXT,
  fecha_alta    DATE NOT NULL,
  fecha_baja    DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grilla_planes_fechas_check') THEN
    ALTER TABLE grilla_planes
      ADD CONSTRAINT grilla_planes_fechas_check
      CHECK (fecha_baja IS NULL OR fecha_baja >= fecha_alta);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_grilla_planes_plato_base ON grilla_planes(plato_base_id);


-- ── 4. grilla_celdas ─────────────────────────────────────────
-- UNA diferencia: este colaborador, este día, come otra cosa o no come.
-- SIN fila = plato base del plan. Esa es la regla central de la fase: por
-- defecto se cocina para todos los días hábiles, y ATC solo marca lo distinto.
--
-- CHECK exactamente uno de (plato_id, ausencia): una celda o cambia el plato o
-- marca una ausencia, nunca las dos ni ninguna. num_nonnulls() lo dice en una
-- línea y evita un OR de cuatro ramas.
--
-- comentario queda libre y es opcional, pero por el CHECK no puede ir solo:
-- siempre acompaña a un cambio de plato o a una ausencia.

CREATE TABLE IF NOT EXISTS grilla_celdas (
  id         SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha      DATE NOT NULL,
  plato_id   INTEGER REFERENCES platos(id),
  ausencia   TEXT,
  comentario TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES usuarios(id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grilla_celdas_ausencia_check') THEN
    ALTER TABLE grilla_celdas
      ADD CONSTRAINT grilla_celdas_ausencia_check
      CHECK (ausencia IN ('home_office','vacaciones','reposo','licencia','otro'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grilla_celdas_una_cosa_check') THEN
    ALTER TABLE grilla_celdas
      ADD CONSTRAINT grilla_celdas_una_cosa_check
      CHECK (num_nonnulls(plato_id, ausencia) = 1);
  END IF;

  -- Una sola celda por colaborador y fecha: hace determinístico el cálculo de
  -- totales (no hay dos diferencias compitiendo por el mismo día) y permite
  -- que PUT /celda sea un upsert.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grilla_celdas_unica') THEN
    ALTER TABLE grilla_celdas
      ADD CONSTRAINT grilla_celdas_unica UNIQUE (cliente_id, fecha);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_grilla_celdas_fecha ON grilla_celdas(fecha);


-- ── 5. grilla_sin_servicio ───────────────────────────────────
-- Día completo sin producción para una empresa (feriado, cierre, paro).
-- Gana sobre todo lo demás: ese día no se cocina nada para esa empresa, ni
-- platos por persona ni pedido general.

CREATE TABLE IF NOT EXISTS grilla_sin_servicio (
  empresa TEXT NOT NULL,
  fecha   DATE NOT NULL,
  motivo  TEXT,
  PRIMARY KEY (empresa, fecha)
);


-- ── 6. grilla_general ────────────────────────────────────────
-- Pedido general: lo que NO va por persona (sopa, ensalada mixta, jugo,
-- vinagreta). Cantidad suelta por empresa, fecha y plato.
--
-- CHECK (cantidad >= 0) y no (> 0): guardar un 0 es la forma de que la celda
-- quede visible en la grilla con el ítem ya elegido. El cálculo de totales
-- descarta las filas en 0, así que un 0 nunca llega a cocina.

CREATE TABLE IF NOT EXISTS grilla_general (
  empresa  TEXT NOT NULL,
  fecha    DATE NOT NULL,
  plato_id INTEGER NOT NULL REFERENCES platos(id),
  cantidad INTEGER NOT NULL,
  PRIMARY KEY (empresa, fecha, plato_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grilla_general_cantidad_check') THEN
    ALTER TABLE grilla_general
      ADD CONSTRAINT grilla_general_cantidad_check CHECK (cantidad >= 0);
  END IF;
END $$;


-- ── 7. grilla_auditoria ──────────────────────────────────────
-- Toda escritura de la grilla queda registrada acá automáticamente, SIN pedirle
-- motivo al usuario: la grilla se toca decenas de veces por semana y exigir un
-- motivo por celda (como sí hace pedidos_auditoria) la volvería inusable.
--
-- Sin FK a pedidos ni a clientes: es un log, tiene que poder escribirse y
-- conservarse aunque después se borre la fila a la que se refiere.
--
-- tabla  → 'grilla_celdas' | 'grilla_planes' | 'grilla_sin_servicio' |
--          'grilla_general' | 'grilla_envio'
-- clave  → qué fila, en texto legible (ej. 'cliente=312|fecha=2026-10-20')
-- antes  → NULL si es un alta · despues → NULL si es una baja

CREATE TABLE IF NOT EXISTS grilla_auditoria (
  id         SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  tabla      TEXT NOT NULL,
  clave      TEXT NOT NULL,
  antes      JSONB,
  despues    JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grilla_auditoria_creado_en ON grilla_auditoria(creado_en);
-- El estado del último envío de una semana se lee de acá (tabla='grilla_envio',
-- clave='<empresa>|<lunes>'), así que este índice no es decorativo.
CREATE INDEX IF NOT EXISTS idx_grilla_auditoria_tabla_clave ON grilla_auditoria(tabla, clave, creado_en DESC);


-- ── 8. pedidos.origen / pedidos.semana_lunes ─────────────────
-- Marca el pedido semanal que genera la grilla. Un pedido con origen='grilla'
-- NO se edita por los endpoints normales de /api/pedidos: lo gobierna la
-- grilla y cualquier cambio a mano quedaría pisado en el siguiente envío.
--
-- monto = 0 y estado_pago = 'pendiente': la facturación del comedor NO es
-- parte de esta fase. Verificado contra producción el 2026-10-15:
-- pedidos.monto es INTEGER NOT NULL y NO tiene ningún CHECK, así que acepta 0
-- sin tocar la tabla. Por eso este bloque no altera la columna monto.
--
-- origen con CHECK IN ('grilla') y no un BOOLEAN: deja lugar a otros orígenes
-- automáticos más adelante sin migrar los datos existentes (NULL = carga
-- manual por ATC, que es todo lo que hay hoy).

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origen       TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS semana_lunes DATE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_origen_check') THEN
    ALTER TABLE pedidos ADD CONSTRAINT pedidos_origen_check CHECK (origen IN ('grilla'));
  END IF;
END $$;

-- Un solo pedido de grilla por cuenta-empresa y semana. Índice único PARCIAL:
-- los pedidos manuales (origen NULL) no entran, así que esto no restringe nada
-- de lo que ya existe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_grilla_semana
  ON pedidos (cliente_id, semana_lunes) WHERE origen = 'grilla';


-- ── 9. Catálogo de platos de la fase 7 ───────────────────────
-- 9.a — Guarniciones reales de Pollo Grille. Hasta ahora la categoría tenía
--       una sola fila placeholder ('A definir'), cargada en la fase 6.
-- 9.b — Categoría 'General': lo que va en el pedido general, no por persona.
--       La aplicación la trata distinto (models/platos.js la excluye del
--       catálogo de líneas de pedido y de plato base/celda de la grilla), así
--       que el nombre de la categoría es parte del contrato: no renombrarla
--       sin tocar PLATOS_CATEGORIA_GENERAL en models/platos.js.

INSERT INTO platos (categoria, nombre) VALUES
  ('Pollo Grille', 'Papa'),
  ('Pollo Grille', 'Batata'),
  ('Pollo Grille', 'Arroz'),
  ('Pollo Grille', 'Fideo'),
  ('Pollo Grille', 'Verduras salteadas'),
  ('Pollo Grille', 'Puré de papa'),
  ('Pollo Grille', 'Puré de batata'),
  ('Pollo Grille', 'Sin guarnición'),
  ('General',      'Sopa de verduras'),
  ('General',      'Ensalada mixta'),
  ('General',      'Jugo'),
  ('General',      'Vinagreta')
ON CONFLICT (categoria, nombre) DO NOTHING;

-- 9.c — El placeholder de la fase 6 ya no va: ahora están las guarniciones
--       reales. Se desactiva (activo = 0) en lugar de borrarse, porque puede
--       estar referenciado por líneas de pedido ya cargadas.
UPDATE platos SET activo = 0
WHERE categoria = 'Pollo Grille' AND nombre = 'A definir' AND activo <> 0;


-- ── 10. RLS ──────────────────────────────────────────────────
-- Mismo patrón que el resto del proyecto: ENABLE (no FORCE) y sin políticas.
-- El backend entra con el rol postgres, que no está sujeto a RLS; esto solo
-- cierra la API REST de Supabase con las claves anon/publishable.

ALTER TABLE grilla_empresas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE grilla_planes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE grilla_celdas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE grilla_sin_servicio ENABLE ROW LEVEL SECURITY;
ALTER TABLE grilla_general      ENABLE ROW LEVEL SECURITY;
ALTER TABLE grilla_auditoria    ENABLE ROW LEVEL SECURITY;
