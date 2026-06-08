const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const config = require('./config');
const usuarios = require('./models/usuarios');
const clientesRouter = require('./routes/clientes');
const pedidosRouter = require('./routes/pedidos');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  },
}));

// ── Middlewares de autenticación / autorización ──────────────────

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  return res.redirect('/login');
}

function requireRole(rol) {
  return (req, res, next) => {
    if (!req.session.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
      return res.redirect('/login');
    }
    if (req.session.user.rol !== rol) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'No autorizado' });
      return res.status(403).sendFile(path.join(__dirname, 'views', '403.html'));
    }
    next();
  };
}

const view = (name) => (req, res) => res.sendFile(path.join(__dirname, 'views', name));

// ── Auth ──────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const usuario = usuarios.findByUsername(username);
  if (!usuario || !bcrypt.compareSync(password, usuario.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  req.session.user = { id: usuario.id, username: usuario.username, rol: usuario.rol };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'No autenticado' });
  res.json({ user: req.session.user, alertDays: config.ALERT_DAYS });
});

// ── Páginas ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.rol === 'admin' ? '/dashboard' : '/inicio');
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.rol === 'admin' ? '/dashboard' : '/inicio');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', requireRole('admin'), view('dashboard.html'));
app.get('/inicio', requireRole('operador'), view('inicio.html'));
app.get('/clientes', requireLogin, view('clientes.html'));
app.get('/clientes/nuevo', requireLogin, view('cliente-form.html'));
app.get('/clientes/:id', requireLogin, view('cliente-ficha.html'));
app.get('/pedidos/nuevo', requireLogin, view('pedido-form.html'));

// ── API de negocio ────────────────────────────────────────────────

app.use('/api/clientes', requireLogin, clientesRouter);
app.use('/api/pedidos', requireLogin, pedidosRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'No encontrado' });
});

app.listen(config.PORT, () => {
  console.log(`Närma CRM corriendo en http://localhost:${config.PORT}`);
});
