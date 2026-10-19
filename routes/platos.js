const express = require('express');
const platos = require('../models/platos');

const router = express.Router();

// GET /api/platos — catálogo activo agrupado por categoría, para armar el
// select de platos. Cualquier alta hecha directo en la tabla aparece acá sin
// necesidad de deploy.
//
// Por defecto deja afuera la categoría 'General' (sopa, ensalada mixta, jugo,
// vinagreta): es el catálogo "por persona" que usa la grilla de comedor para
// el plato base y las celdas, donde esos ítems no tienen sentido.
//
// Con ?incluir_general=1 devuelve TODO el catálogo activo. Lo piden el form de
// pedido y la vista de edición: desde la fase 9 los pedidos normales sí
// aceptan ítems generales (Matrix los pide como pedido normal), y la
// validación del backend acompaña con platos.idsActivosTodos.
router.get('/', async (req, res, next) => {
  try {
    const incluirGeneral = req.query.incluir_general === '1';
    const categorias = incluirGeneral
      ? await platos.listTodosActivosPorCategoria()
      : await platos.listActivosPorCategoria();
    res.json({ categorias });
  } catch (err) { next(err); }
});

module.exports = router;
