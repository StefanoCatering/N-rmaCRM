-- =============================================================
-- Fase 4 — Fix de datos legacy: monto_pagado en pedidos pagados
-- Ejecutar manualmente en el SQL Editor de Supabase (proyecto narma-crm).
-- Idempotente: correrlo más de una vez no tiene efecto adicional,
-- ya que después de la primera corrida la condición WHERE no matchea nada.
-- =============================================================

UPDATE pedidos
SET monto_pagado = monto
WHERE estado_pago = 'pagado'
  AND monto_pagado IS DISTINCT FROM monto;
