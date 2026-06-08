const db = require('./db');

function findByUsername(username) {
  return db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username);
}

function findById(id) {
  return db.prepare('SELECT id, username, rol, created_at FROM usuarios WHERE id = ?').get(id);
}

function create({ username, password_hash, rol }) {
  const stmt = db.prepare(
    'INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?)'
  );
  const info = stmt.run(username, password_hash, rol);
  return findById(Number(info.lastInsertRowid));
}

module.exports = { findByUsername, findById, create };
