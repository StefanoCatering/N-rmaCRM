const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');

const config = require('./config');
const pool = require('./models/db');
const usuarios = require('./models/usuarios');
const clientesRouter = require('./routes/clientes');
const pedidosRouter = require('./routes/pedidos');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Vercel corre detrás de un reverse proxy — sin esto Express no confía en los
// headers X-Forwarded-* y las cookies con secure:true no se envían correctamente.
app.set('trust proxy', 1);

app.use(session({
  // Sesiones persistidas en Supabase (PostgreSQL) — necesario para Vercel
  // serverless donde el MemoryStore se descarta entre invocaciones frías.
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,      // requerido para cookies en HTTPS (Vercel siempre es HTTPS)
    sameSite: 'none',  // requerido cuando secure:true en contexto cross-site de Vercel
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

app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const usuario = await usuarios.findByUsername(username);
    if (!usuario || !bcrypt.compareSync(password, usuario.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    req.session.user = { id: usuario.id, username: usuario.username, rol: usuario.rol };
    res.json({ ok: true, user: req.session.user });
  } catch (err) { next(err); }
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

// ── Error handler global (captura errores de rutas async) ─────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Cuando se ejecuta directamente (`node server.js`) levanta el servidor HTTP.
// Cuando Vercel lo importa como módulo serverless, solo exporta el app sin escuchar.
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`Närma CRM corriendo en http://localhost:${config.PORT}`);
  });
}

module.exports = app;
