-- =============================================================
-- Fase 8 — Auditoría de pedidos y usuarios desactivables (CRM)
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-crm (ref bjnwremoaooglpxrnzgi).
--
-- Idempotente: se puede correr más de una vez sin error y sin efectos
-- adicionales (IF NOT EXISTS / IF EXISTS + guardas sobre pg_constraint +
-- DROP NOT NULL, que ya es un no-op si la columna acepta NULL).
--
-- No crea tablas: solo agrega usuarios.activo, deja pedidos.recibido_por
-- declarada en el repo, y amplía los CHECK de pedidos_auditoria para que la
-- creación de un pedido y el cambio de estado de pago también queden
-- registrados. Como no hay tablas nuevas, no hay sección de RLS.
-- =============================================================


-- ── 1. usuarios.activo ───────────────────────────────────────
-- Baja lógica de un usuario: se desactiva, no se borra, porque su id está
-- referenciado por pedidos.recibido_por / verificado_por y por
-- grilla_celdas.updated_by — borrar la fila rompería esas FK y, sobre todo,
-- borraría de quién fue cada carga.
--
-- Se lee de la base en CADA request (requireAuth en server.js) y no del JWT:
-- desactivar a alguien tiene que cortarle el acceso en el acto y no cuando se
-- le vence el token de 8 horas. Mismo criterio que gestiona_grilla (fase 7).

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;


-- ── 2. pedidos.recibido_por ──────────────────────────────────
-- La columna YA EXISTE en la base del CRM (integer, nullable, con FK a
-- usuarios) pero nunca estuvo declarada en supabase/schema.sql ni en una
-- migración, así que un esquema armado desde el repo no la tenía. Acá queda
-- declarada: sobre producción estos dos bloques son un no-op.
--
-- Nullable a propósito: los 772 pedidos anteriores a esta fase no tienen con
-- qué completarla y no se inventa un responsable. La vista los muestra con "—".

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS recibido_por INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_recibido_por_fkey') THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT pedidos_recibido_por_fkey
      FOREIGN KEY (recibido_por) REFERENCES usuarios(id);
  END IF;
END $$;


-- ── 3. pedidos_auditoria.accion: + 'creacion' y 'pago' ───────
-- El CHECK original se creó inline en el CREATE TABLE (supabase/schema.sql y
-- supabase/schema_pedidos_auditoria.sql), así que Postgres lo nombró solo:
-- pedidos_auditoria_accion_check. Se dropea con IF EXISTS y se recrea con los
-- dos valores nuevos; recrearlo con el mismo nombre deja la segunda corrida
-- igual que la primera.

ALTER TABLE pedidos_auditoria DROP CONSTRAINT IF EXISTS pedidos_auditoria_accion_check;

ALTER TABLE pedidos_auditoria
  ADD CONSTRAINT pedidos_auditoria_accion_check
  CHECK (accion IN ('edicion', 'cancelacion', 'creacion', 'pago'));


-- ── 4. pedidos_auditoria.motivo pasa a aceptar NULL ──────────
-- motivo era NOT NULL, y tenía sentido mientras la tabla solo guardaba
-- ediciones y cancelaciones: ahí el motivo lo escribe un admin y es
-- obligatorio (lo exige también routes/pedidos.js antes de tocar la base).
--
-- 'creacion' y 'pago' no tienen motivo que pedir: nadie justifica por escrito
-- haber cargado un pedido. Sin este cambio, el INSERT de auditoría de la
-- creación fallaría con 23502 y —al ir en la misma transacción— se llevaría
-- puesto el pedido entero.
--
-- El CHECK nuevo conserva la garantía que daba el NOT NULL donde importa:
-- edicion y cancelacion siguen necesitando un motivo no vacío.

ALTER TABLE pedidos_auditoria ALTER COLUMN motivo DROP NOT NULL;

ALTER TABLE pedidos_auditoria DROP CONSTRAINT IF EXISTS pedidos_auditoria_motivo_check;

ALTER TABLE pedidos_auditoria
  ADD CONSTRAINT pedidos_auditoria_motivo_check
  CHECK (
    accion IN ('creacion', 'pago')
    OR (motivo IS NOT NULL AND btrim(motivo) <> '')
  );
