const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const config = require('./config');       // también llama a dotenv.config()
const usuarios = require('./models/usuarios');
const clientesRouter = require('./routes/clientes');
const pedidosRouter  = require('./routes/pedidos');
const exportRouter   = require('./routes/export');

// Validación de arranque: JWT_SECRET es obligatorio
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET no está configurado.\n' +
    'Agregá JWT_SECRET en Vercel (Settings → Environment Variables) ' +
    'o en tu archivo .env local.'
  );
}

const app = express();

// ── Diagnóstico de arranque ───────────────────────────────────────
console.log('[server] NODE_ENV:', config.NODE_ENV);
console.log('[server] JWT_SECRET configurado: true');
console.log('[server] auth: JWT httpOnly cookie (narma_token)');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Middleware de autenticación / autorización ────────────────────
// requireAuth(rol?)
//   Sin argumento → sólo verifica que haya un JWT válido.
//   Con 'admin' u 'operador' → también verifica el rol.
//   Rutas /api/* → respuesta JSON 401/403.
//   Páginas → redirect a /login.
function requireAuth(rol) {
  return (req, res, next) => {
    const token = req.cookies.narma_token;
    const isApi = req.originalUrl.startsWith('/api/');

    if (!token) {
      console.log('[requireAuth] sin token | path:', req.originalUrl);
      if (isApi) return res.status(401).json({ error: 'No autenticado' });
      return res.redirect('/login');
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.id, username: payload.username, rol: payload.rol };
      console.log(
        '[requireAuth] OK | user:', req.user.username,
        '| rol requerido:', rol || 'cualquiera',
        '| path:', req.originalUrl
      );

      // rol puede ser string ('admin'), array (['admin','visor']), o falsy (cualquiera)
      const rolesPermitidos = Array.isArray(rol) ? rol : (rol ? [rol] : null);
      if (rolesPermitidos && !rolesPermitidos.includes(req.user.rol)) {
        console.log('[requireAuth] FORBIDDEN | user.rol:', req.user.rol, '| permitidos:', rolesPermitidos);
        if (isApi) return res.status(403).json({ error: 'No autorizado' });
        return res.status(403).sendFile(path.join(__dirname, 'views', '403.html'));
      }

      next();
    } catch (e) {
      console.log('[requireAuth] token inválido:', e.message, '| path:', req.originalUrl);
      res.clearCookie('narma_token', { httpOnly: true, secure: true, sameSite: 'none' });
      if (isApi) return res.status(401).json({ error: 'No autenticado' });
      return res.redirect('/login');
    }
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

    const token = jwt.sign(
      { id: usuario.id, username: usuario.username, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('narma_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 8 * 60 * 60 * 1000, // 8 horas
    });

    const dest = (usuario.rol === 'admin' || usuario.rol === 'visor') ? '/dashboard' : '/inicio';
    console.log('[login] JWT generado | user:', usuario.username, '| rol:', usuario.rol, '| redirect ->', dest);
    res.redirect(dest);
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('narma_token', { httpOnly: true, secure: true, sameSite: 'none' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth(), (req, res) => {
  res.json({ user: req.user, alertDays: config.ALERT_DAYS });
});

// ── Páginas ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const token = req.cookies.narma_token;
  if (!token) return res.redirect('/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.redirect((payload.rol === 'admin' || payload.rol === 'visor') ? '/dashboard' : '/inicio');
  } catch {
    res.clearCookie('narma_token', { httpOnly: true, secure: true, sameSite: 'none' });
    return res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  const token = req.cookies.narma_token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      return res.redirect((payload.rol === 'admin' || payload.rol === 'visor') ? '/dashboard' : '/inicio');
    } catch { /* token inválido → mostrar login */ }
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', requireAuth(['admin', 'visor']), view('dashboard.html'));
app.get('/inicio', requireAuth('operador'), view('inicio.html'));
app.get('/clientes', requireAuth(), view('clientes.html'));
app.get('/clientes/nuevo', requireAuth(['admin', 'operador']), view('cliente-form.html'));
app.get('/clientes/:id/editar', requireAuth(['admin', 'operador']), view('cliente-form.html'));
app.get('/clientes/:id', requireAuth(), view('cliente-ficha.html'));
app.get('/pedidos/nuevo', requireAuth(['admin', 'operador']), view('pedido-form.html'));
app.get('/pedidos', requireAuth(['admin', 'operador']), view('pedidos.html'));

// ── API de negocio ────────────────────────────────────────────────

app.use('/api/clientes', requireAuth(), clientesRouter);
app.use('/api/pedidos',  requireAuth(), pedidosRouter);
app.use('/api/export',   requireAuth(), exportRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'No encontrado' });
});

// ── Error handler global ──────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Cuando se ejecuta directamente (`node server.js`) levanta el servidor HTTP.
// Cuando Vercel lo importa como módulo serverless, solo exporta el app.
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`Närma CRM corriendo en http://localhost:${config.PORT}`);
  });
}

module.exports = app;
