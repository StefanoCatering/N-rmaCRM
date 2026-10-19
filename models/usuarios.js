const pool = require('./db');

async function findByUsername(username) {
  const result = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query(
    'SELECT id, username, rol, activo, created_at FROM usuarios WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

// Lo que requireAuth necesita saber en CADA request, en una sola consulta por
// clave primaria: si el usuario todavía existe, si sigue activo, qué rol tiene
// hoy y si gestiona la grilla.
//
// El rol sale de acá y no del JWT a propósito: cambiarle el rol a alguien
// aplica en el acto, sin esperar a que se le venza el token de 8 horas. Mismo
// motivo por el que ya se leía gestiona_grilla de la base (fase 7); ahora ese
// dato viene en esta misma fila y no en una segunda consulta.
async function findForAuth(id) {
  const result = await pool.query(
    'SELECT id, username, rol, activo, gestiona_grilla FROM usuarios WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

async function create({ username, password_hash, rol }) {
  const result = await pool.query(
    'INSERT INTO usuarios (username, password_hash, rol) VALUES ($1, $2, $3) RETURNING id',
    [username, password_hash, rol]
  );
  return findById(result.rows[0].id);
}

// ¿Este usuario tiene el permiso de edición de la grilla semanal de comedor?
// Se lee de la base en cada request de escritura (y no del JWT) a propósito:
// sacarle el permiso a alguien tiene que aplicar en el acto, sin esperar a que
// se le venza el token de 8 horas.
async function gestionaGrilla(id) {
  const result = await pool.query('SELECT gestiona_grilla FROM usuarios WHERE id = $1', [id]);
  return result.rows.length ? result.rows[0].gestiona_grilla === true : false;
}

// Hash actual, para poder validar la contraseña vigente antes de cambiarla.
// Va aparte de findById/findForAuth para que el hash no viaje en los objetos
// que terminan en req.user ni en respuestas JSON.
async function getPasswordHash(id) {
  const result = await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [id]);
  return result.rows.length ? result.rows[0].password_hash : null;
}

async function updatePassword(id, password_hash) {
  const result = await pool.query(
    'UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING id',
    [password_hash, id]
  );
  return result.rowCount === 1;
}

module.exports = {
  findByUsername, findById, findForAuth, create, gestionaGrilla,
  getPasswordHash, updatePassword,
};
