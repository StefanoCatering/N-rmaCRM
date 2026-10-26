-- =============================================================
-- Fase 13 — Datos de facturación en cliente y en pedido (CRM)
-- Ejecutar manualmente en el SQL Editor de Supabase
-- → proyecto narma-crm (ref bjnwremoaooglpxrnzgi).
--
-- Idempotente: se puede correr más de una vez sin error y sin efectos
-- adicionales (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS y
-- constraints creados solo si no existen todavía, mirando pg_constraint).
--
-- Qué agrega: a nombre de quién se factura. Desde el CRM no se factura nada —
-- esto es el registro del dato, para que quien emite la factura no tenga que
-- preguntar. El caso que la motiva es el más común del negocio: la señora hace
-- el pedido y la factura va a nombre del marido, que también es cliente.
--
-- Tres bloques de columnas, y la diferencia entre los dos primeros es la que
-- hace que no haya cadenas de facturación:
--   1. clientes.razon_social / ruc / email_facturacion
--      → los datos PROPIOS del cliente. Son suyos, siempre.
--   2. clientes.factura_a (+ factura_cliente_id / factura_*)
--      → a quién se le facturan SUS pedidos por defecto.
--   3. pedidos.factura_a (+ factura_cliente_id / factura_*)
--      → el override de UN pedido. NULL = "según el cliente".
--
-- Cuando un cliente factura a otro cliente se leen los datos PROPIOS (bloque
-- 1) del elegido y NO se vuelve a mirar SU factura_a: si B factura a C, los
-- pedidos de A que facturan a B siguen saliendo con el RUC de B. Eso se
-- resuelve en models/facturacion.js, no acá, pero es el motivo por el que los
-- dos bloques son columnas distintas y no una sola.
--
-- NO hay backfill: los ~430 clientes existentes quedan en factura_a = 'mismo'
-- y sin RUC, que es exactamente lo que se sabe hoy de ellos. La vista muestra
-- "sin RUC cargado" y nada se bloquea por eso — el dato se va completando a
-- medida que ATC lo pregunta.
--
-- NO toca la facturación real, ni montos, ni el sync con cocina: ninguna de
-- estas columnas viaja a Narma Pedidos.
-- =============================================================


-- ── 1. clientes: datos de facturación propios ────────────────
-- Los tres nullables: hoy no se tiene el dato de casi nadie y pedirlo como
-- obligatorio frenaría el alta de un cliente que llama por WhatsApp y quiere
-- su vianda mañana. "Sin RUC cargado" es un estado válido del sistema.
--
-- ruc como TEXT y no numérico: los RUC paraguayos llevan guion y dígito
-- verificador ('80012345-6'), hay clientes extranjeros, y el CRM no emite
-- facturas, así que validar el dígito verificador acá sería inventar una
-- regla que nadie necesita. El endpoint lo limita a 20 caracteres.
--
-- email_facturacion aparte de clientes.email: el correo al que se manda la
-- factura muchas veces es el del contador o el administrativo de la empresa,
-- no el de la persona con la que ATC habla todos los días.

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS razon_social      TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ruc               TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email_facturacion TEXT;


-- ── 2. clientes: a quién se le facturan sus pedidos ──────────
-- factura_a NOT NULL DEFAULT 'mismo': el default es el caso mayoritario y deja
-- a los ~430 clientes existentes en el estado correcto sin UPDATE.
--   'mismo'         → se factura a él, con sus datos propios (bloque 1).
--   'otro_cliente'  → se factura a otro cliente del CRM (factura_cliente_id).
--   'otros'         → se factura a alguien que no es cliente: los datos se
--                     escriben a mano en factura_razon_social / _ruc / _email.
--
-- factura_cliente_id sin ON DELETE: los clientes no se borran, se desactivan
-- (fase 11). Si algún día hubiera que borrar uno de verdad, que la FK lo frene
-- y obligue a decidir qué pasa con quienes le facturaban es mejor que dejar
-- una factura apuntando al vacío.
--
-- Un cliente INACTIVO sigue sirviendo como destinatario de factura: el marido
-- puede no pedir nunca nada y estar inactivo, y la factura igual va a su
-- nombre. Por eso no hay ninguna restricción por estado.

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS factura_a            TEXT NOT NULL DEFAULT 'mismo';
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS factura_cliente_id   INTEGER REFERENCES clientes(id);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS factura_razon_social TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS factura_ruc          TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS factura_email        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clientes_factura_a_check'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT clientes_factura_a_check
      CHECK (factura_a IN ('mismo', 'otro_cliente', 'otros'));
  END IF;

  -- La columna y el modo no pueden contradecirse: hay un cliente elegido
  -- exactamente cuando el modo es 'otro_cliente'. Escrito como una igualdad
  -- de booleanos, cubre los dos errores de una vez — 'otro_cliente' sin
  -- cliente, y un cliente que quedó colgado al volver a 'mismo'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clientes_factura_cliente_coherente_check'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT clientes_factura_cliente_coherente_check
      CHECK ((factura_a = 'otro_cliente') = (factura_cliente_id IS NOT NULL));
  END IF;

  -- Facturarse a sí mismo por la vía de 'otro_cliente' no es un caso: para eso
  -- está 'mismo'. Permitirlo haría que resolver la facturación tuviera que
  -- cuidarse de un ciclo de largo 1.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clientes_factura_cliente_distinto_check'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT clientes_factura_cliente_distinto_check
      CHECK (factura_cliente_id IS NULL OR factura_cliente_id <> id);
  END IF;
END $$;


-- ── 3. pedidos: override por pedido ──────────────────────────
-- factura_a NULLABLE acá, a diferencia de clientes: NULL es un valor con
-- significado propio — "según el cliente", resuelto cada vez que se lee y no
-- copiado al crear el pedido. Así, si mañana se carga el RUC del marido, los
-- pedidos ya cargados salen con el RUC nuevo sin tocarlos.
--
-- Es la misma decisión que la ventana de entrega de la fase 11: el dato vive
-- en un solo lugar y las copias se evitan.

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS factura_a            TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS factura_cliente_id   INTEGER REFERENCES clientes(id);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS factura_razon_social TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS factura_ruc          TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS factura_email        TEXT;

DO $$
BEGIN
  -- Un CHECK con IN pasa cuando el valor es NULL, así que esto acepta los tres
  -- valores y el NULL ("según el cliente") sin necesitar un OR explícito.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_factura_a_check'
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT pedidos_factura_a_check
      CHECK (factura_a IN ('mismo', 'otro_cliente', 'otros'));
  END IF;

  -- Igual que en clientes, pero tratando el NULL de factura_a como "no es
  -- otro_cliente": sin el IS NOT TRUE, la igualdad daría NULL y el CHECK
  -- pasaría dejando entrar un factura_cliente_id sobre un pedido que dice
  -- "según el cliente".
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_factura_cliente_coherente_check'
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT pedidos_factura_cliente_coherente_check
      CHECK (((factura_a = 'otro_cliente') IS NOT TRUE) = (factura_cliente_id IS NULL));
  END IF;
END $$;


-- ── 4. Índices ───────────────────────────────────────────────
-- Los dos sirven a la misma pregunta, que la ficha hace siempre: "¿quiénes
-- facturan a nombre de este cliente?". Sin índice es un scan de clientes (y de
-- pedidos) por cada ficha que se abre.

CREATE INDEX IF NOT EXISTS idx_clientes_factura_cliente_id ON clientes(factura_cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_factura_cliente_id  ON pedidos(factura_cliente_id);
