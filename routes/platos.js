const express = require('express');
const platos = require('../models/platos');

const router = express.Router();

// GET /api/platos — catálogo activo agrupado por categoría, para armar el
// select de platos del form de pedido. Cualquier alta hecha directo en la
// tabla aparece acá sin necesidad de deploy.
router.get('/', async (req, res, next) => {
  try {
    res.json({ categorias: await platos.listActivosPorCategoria() });
  } catch (err) { next(err); }
});

module.exports = router;
