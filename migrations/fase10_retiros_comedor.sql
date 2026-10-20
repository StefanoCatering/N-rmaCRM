-- =============================================================
-- Fase 10 — Retiros en el comedor (CRM)
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-crm (ref bjnwremoaooglpxrnzgi).
--
-- Idempotente: se puede correr más de una vez sin error y sin efectos
-- adicionales (DROP CONSTRAINT IF EXISTS + recreación con el mismo nombre,
-- CREATE TABLE IF NOT EXISTS, ENABLE ROW LEVEL SECURITY que ya es un no-op
-- sobre una tabla con RLS habilitado).
--
-- Qué agrega: la planilla con la que la persona de atención del comedor
-- (Matrix) marca, día por día, quién RETIRÓ su vianda. Es un registro de
-- ENTREGA, no de producción: nada de esto cambia los totales que ve cocina,
-- ni los pedidos, ni la grilla, ni se sincroniza a narma-pedidos.
--
-- Por eso no toca ninguna tabla existente salvo el CHECK del rol: la lista de
-- quién debe retirar sale de la grilla (grilla_planes + grilla_celdas), no se
-- copia acá.
-- =============================================================


-- ── 1. usuarios.rol: + 'comedor' ─────────────────────────────
-- Rol nuevo para la persona que entrega las viandas en el comedor del banco.
-- Solo ve la pantalla de Retiros y su propia cuenta; el bloqueo real es una
-- lista blanca de rutas en requireAuth (server.js), que deniega por defecto.
--
-- El CHECK original se creó inline en el CREATE TABLE, así que Postgres lo
-- nombró solo: usuarios_rol_check. Se dropea con IF EXISTS y se recrea con el
-- mismo nombre, así la segunda corrida queda igual que la primera.
--
-- 'visor' ya estaba en el CHECK vigente (fase 5): se conserva.

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;

ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('operador', 'admin', 'visor', 'comedor'));


-- ── 2. grilla_retiros ────────────────────────────────────────
-- Una fila por vianda retirada. QUE EXISTA LA FILA = retiró; desmarcar es
-- BORRAR la fila, no guardar un false. Así no hay un tercer estado ("marcado
-- como no retirado") que nadie usaría y que habría que distinguir de "todavía
-- sin marcar".
--
-- cliente_id: el colaborador, el mismo id que usa grilla_planes. ON DELETE
--   CASCADE porque esto es un registro de entrega: si se borra la persona, sus
--   marcas no tienen a quién referirse (a diferencia de grilla_auditoria, que
--   es un log y se conserva).
-- marcado_por: quién puso la marca. Nullable y sin ON DELETE: los usuarios se
--   desactivan, no se borran (fase 8).
-- PK (cliente_id, fecha): una sola marca por persona y día, y hace que
--   PUT /api/retiros/marca sea un upsert simple.
--
-- Sin FK a grilla_planes: el plan vive en (cliente_id) con fecha_alta /
-- fecha_baja y puede cambiar; que el colaborador deba retirar ese día lo
-- valida la aplicación contra la grilla antes de escribir.

CREATE TABLE IF NOT EXISTS grilla_retiros (
  cliente_id  INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha       DATE NOT NULL,
  marcado_por INTEGER REFERENCES usuarios(id),
  marcado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cliente_id, fecha)
);

-- La pantalla siempre lee UN día entero: la PK arranca por cliente_id, así que
-- no sirve para ese filtro.
CREATE INDEX IF NOT EXISTS idx_grilla_retiros_fecha ON grilla_retiros(fecha);


-- ── 3. grilla_retiros_notas ──────────────────────────────────
-- El comentario libre del día ("vino Fulano, no figura en la lista"). Una nota
-- por empresa y fecha; texto vacío = se borra la fila.
--
-- empresa: el MISMO valor que clientes.empresa y grilla_empresas.empresa (sin
--   FK: clientes.empresa es texto libre, no una tabla). Mismo criterio que
--   grilla_sin_servicio y grilla_general.

CREATE TABLE IF NOT EXISTS grilla_retiros_notas (
  empresa    TEXT NOT NULL,
  fecha      DATE NOT NULL,
  texto      TEXT NOT NULL,
  updated_by INTEGER REFERENCES usuarios(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (empresa, fecha)
);


-- ── 4. RLS ───────────────────────────────────────────────────
-- Mismo patrón que el resto de las tablas public del proyecto (ver la
-- migración enable_rls_all_public_tables, ya aplicada en la base): ENABLE (no
-- FORCE) y sin políticas. El backend entra con el rol postgres, que no está
-- sujeto a RLS; esto solo cierra la API REST de Supabase con las claves
-- anon/publishable.

ALTER TABLE grilla_retiros       ENABLE ROW LEVEL SECURITY;
ALTER TABLE grilla_retiros_notas ENABLE ROW LEVEL SECURITY;
