const pool = require('./db');

async function findByUsername(username) {
  const result = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query(
    'SELECT id, username, rol, created_at FROM usuarios WHERE id = $1',
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

module.exports = { findByUsername, findById, create };
