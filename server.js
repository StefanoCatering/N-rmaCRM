const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const config = require('./config');       // también llama a dotenv.config()
const usuarios = require('./models/usuarios');
const clientesRouter = require('./routes/clientes');
const pedidosRouter  = require('./routes/pedidos');
const platosRouter   = require('./routes/platos');
const grillaRouter   = require('./routes/grilla');
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

// Vercel corre server.js detrás de su proxy/edge — sin esto, express-rate-limit
// (y req.ip en general) verían siempre la IP interna del proxy, no la del cliente.
app.set('trust proxy', 1);

// ── Diagnóstico de arranque ───────────────────────────────────────
console.log('[server] NODE_ENV:', config.NODE_ENV);
console.log('[server] JWT_SECRET configurado: true');
console.log('[server] auth: JWT httpOnly cookie (narma_token)');

// Headers de seguridad (helmet). CSP con script-src 'unsafe-inline':
// las 8 vistas usan <script> inline (no hay build step) — ver decisión
// documentada en HANDOFF.md antes de endurecer script-src.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
    },
  },
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Middleware de autenticación / autorización ────────────────────
// requireAuth(rol?)
//   Sin argumento → sólo verifica que el usuario esté autenticado y activo.
//   Con 'admin' u 'operador' → también verifica el rol.
//   Rutas /api/* → respuesta JSON 401/403.
//   Páginas → redirect a /login.
//
// El JWT solo dice QUIÉN es (id). Lo demás —si sigue existiendo, si está
// activo, qué rol tiene— se lee de la base en cada request, en una sola
// consulta por clave primaria (fase 8). Así desactivar a alguien o cambiarle
// el rol aplica en el acto y no cuando se le vence el token de 8 horas, que
// era lo que pasaba cuando el middleware confiaba solo en el payload.
function requireAuth(rol) {
  return async (req, res, next) => {
    const token = req.cookies.narma_token;
    const isApi = req.originalUrl.startsWith('/api/');

    // Cookie afuera y 401 (API) o /login (páginas). Limpiar la cookie es lo
    // que corta el ciclo: sin ella, /login ya no rebota de vuelta a la página.
    const rechazar = () => {
      res.clearCookie('narma_token', { httpOnly: true, secure: true, sameSite: 'lax' });
      if (isApi) return res.status(401).json({ error: 'No autenticado' });
      return res.redirect('/login');
    };

    if (!token) {
      console.log('[requireAuth] sin token | path:', req.originalUrl);
      if (isApi) return res.status(401).json({ error: 'No autenticado' });
      return res.redirect('/login');
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      console.log('[requireAuth] token inválido:', e.message, '| path:', req.originalUrl);
      return rechazar();
    }

    try {
      const usuario = await usuarios.findForAuth(payload.id);
      if (!usuario) {
        console.log('[requireAuth] usuario inexistente | id:', payload.id, '| path:', req.originalUrl);
        return rechazar();
      }
      if (usuario.activo !== true) {
        console.log('[requireAuth] usuario desactivado | user:', usuario.username, '| path:', req.originalUrl);
        return rechazar();
      }

      // Todo sale de la base, no del token: el username también, así un
      // renombre se ve en el acto y la auditoría guarda el nombre vigente.
      req.user = {
        id: usuario.id,
        username: usuario.username,
        rol: usuario.rol,
        gestiona_grilla: usuario.gestiona_grilla === true,
      };
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
    } catch (err) { next(err); }
  };
}

const view = (name) => (req, res) => res.sendFile(path.join(__dirname, 'views', name));

// Rate limiting solo para /api/login: limita intentos de fuerza bruta por IP
// sin afectar al resto de la API.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 8,                 // intentos por IP en la ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Probá de nuevo en unos minutos.' },
});

// Mismo criterio que loginLimiter, con su propio contador: cambiar la
// contraseña exige la actual, así que es otro punto donde se puede probar a
// ciegas. Va en una instancia aparte para que los intentos de cambio no gasten
// la cuota de los de login (ni al revés).
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 8,                 // intentos por IP en la ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de cambio de contraseña. Probá de nuevo en unos minutos.' },
});

// ── Auth ──────────────────────────────────────────────────────────

app.post('/api/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const usuario = await usuarios.findByUsername(username);
    if (!usuario || !bcrypt.compareSync(password, usuario.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    // Usuario desactivado: se avisa con un mensaje propio y no con "usuario o
    // contraseña incorrectos", porque las credenciales están bien — el que no
    // va es el acceso. Va después de validar la contraseña a propósito: así el
    // mensaje no le revela a un desconocido qué usuarios existen.
    if (usuario.activo !== true) {
      console.log('[login] RECHAZADO usuario desactivado | user:', usuario.username);
      return res.status(401).json({ error: 'Usuario desactivado' });
    }

    const token = jwt.sign(
      { id: usuario.id, username: usuario.username, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('narma_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 horas
    });

    const dest = (usuario.rol === 'admin' || usuario.rol === 'visor') ? '/dashboard' : '/inicio';
    console.log('[login] JWT generado | user:', usuario.username, '| rol:', usuario.rol, '| redirect ->', dest);
    res.redirect(dest);
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('narma_token', { httpOnly: true, secure: true, sameSite: 'lax' });
  res.json({ ok: true });
});

// ── Mi cuenta ─────────────────────────────────────────────────────

const PASSWORD_MIN = 8;

// POST /api/cuenta/password — cada usuario cambia SU propia contraseña.
// Cualquier rol, visor incluido: es su cuenta, no un dato del negocio.
// Pide la contraseña actual, así una sesión ajena abierta no alcanza para
// quedarse con la cuenta. El limiter va antes de requireAuth para que un
// bombardeo no llegue ni a consultar la base.
app.post('/api/cuenta/password', passwordLimiter, requireAuth(), async (req, res, next) => {
  try {
    const body = req.body || {};
    // Sin trim: un espacio al principio o al final es parte de la contraseña.
    const actual = typeof body.actual === 'string' ? body.actual : '';
    const nueva = typeof body.nueva === 'string' ? body.nueva : '';
    const repetir = typeof body.repetir === 'string' ? body.repetir : '';

    if (!actual || !nueva || !repetir) {
      return res.status(400).json({ error: 'Completá la contraseña actual, la nueva y la repetición' });
    }
    if (nueva.length < PASSWORD_MIN) {
      return res.status(400).json({ error: `La contraseña nueva debe tener al menos ${PASSWORD_MIN} caracteres` });
    }
    if (nueva !== repetir) {
      return res.status(400).json({ error: 'La contraseña nueva y su repetición no coinciden' });
    }
    if (nueva === actual) {
      return res.status(400).json({ error: 'La contraseña nueva tiene que ser distinta de la actual' });
    }

    const hashActual = await usuarios.getPasswordHash(req.user.id);
    if (!hashActual || !bcrypt.compareSync(actual, hashActual)) {
      console.log('[cuenta] contraseña actual incorrecta | user:', req.user.username);
      return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    }

    const ok = await usuarios.updatePassword(req.user.id, bcrypt.hashSync(nueva, 10));
    if (!ok) return res.status(404).json({ error: 'Usuario no encontrado' });

    // El token sigue valiendo: no guarda nada de la contraseña, y cerrarle la
    // sesión a quien acaba de cambiarla a propósito sería ruido.
    console.log('[cuenta] contraseña cambiada | user:', req.user.username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// req.user ya viene entero de la base (requireAuth lo lee en cada request),
// gestiona_grilla incluido: así, si se le saca el permiso a alguien, el link de
// la grilla desaparece en la siguiente carga de página y no cuando se le vence
// el token de 8 horas. Los middlewares de routes/grilla.js hacen su propia
// lectura y son los que de verdad cortan el acceso.
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
    res.clearCookie('narma_token', { httpOnly: true, secure: true, sameSite: 'lax' });
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

// Su propia cuenta la ve cualquier usuario logueado, visor incluido.
app.get('/cuenta', requireAuth(), view('cuenta.html'));

app.get('/dashboard', requireAuth(['admin', 'visor']), view('dashboard.html'));
app.get('/inicio', requireAuth('operador'), view('inicio.html'));
app.get('/clientes', requireAuth(), view('clientes.html'));
app.get('/clientes/nuevo', requireAuth(['admin', 'operador']), view('cliente-form.html'));
app.get('/clientes/:id/editar', requireAuth(['admin', 'operador']), view('cliente-form.html'));
app.get('/clientes/:id', requireAuth(), view('cliente-ficha.html'));
app.get('/pedidos/nuevo', requireAuth(['admin', 'operador']), view('pedido-form.html'));
app.get('/pedidos', requireAuth(['admin', 'operador']), view('pedidos.html'));
// Vista de edición del pedido: líneas, ubicación y excepciones por fecha.
// Se registra después de /pedidos/nuevo para que esa ruta literal gane.
app.get('/pedidos/:id/editar', requireAuth(['admin', 'operador']), view('pedido-detalle.html'));

// Grilla semanal de comedor (fase 7). La ven admin, visor y quien tenga
// gestiona_grilla; la edita SOLO quien tenga gestiona_grilla, y eso lo
// verifica routes/grilla.js en cada request. Este guard es para la página:
// sin él, cualquier operador vería el cascarón de la grilla y recién al
// cargar los datos se encontraría con un 403.
//
// El permiso no se puede expresar con requireAuth(rol) porque no es un rol:
// Admin1, que es quien edita la grilla, tiene rol 'operador'.
function requireVistaGrilla(req, res, next) {
  if (req.user.rol === 'admin' || req.user.rol === 'visor') return next();
  if (req.user.gestiona_grilla) return next();
  return res.status(403).sendFile(path.join(__dirname, 'views', '403.html'));
}

app.get('/grilla/dia', requireAuth(), requireVistaGrilla, view('grilla-dia.html'));
app.get('/grilla', requireAuth(), requireVistaGrilla, view('grilla.html'));

// ── API de negocio ────────────────────────────────────────────────

app.use('/api/clientes', requireAuth(), clientesRouter);
app.use('/api/pedidos',  requireAuth(), pedidosRouter);
app.use('/api/platos',   requireAuth(), platosRouter);
app.use('/api/grilla',   requireAuth(), grillaRouter);
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
