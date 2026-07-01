# Närma CRM — Documento de Handoff

> Estado del proyecto para continuar en una nueva sesión.
> Última actualización: 2026-07-01 · Último commit: `13ab996`

---

## 1. Stack técnico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js `>=22.5.0` |
| Framework | Express 4 (`^4.21.0`) |
| Base de datos | PostgreSQL (Supabase) vía `pg` (`^8.21.0`, Pool) |
| Auth | JWT (`jsonwebtoken ^9.0.3`) en cookie httpOnly + `cookie-parser` |
| Hash de passwords | `bcrypt ^5.1.1` |
| Export Excel | `exceljs ^4.4.0` |
| Env | `dotenv ^16.4.5` |
| Frontend | HTML + Vanilla JS (sin framework), CSS propio |
| Hosting | Vercel (serverless, auto-deploy desde `main`) |

**No hay build step.** El frontend son archivos estáticos servidos por Express (`express.static`) + vistas HTML servidas con `sendFile`.

---

## 2. URLs y repos

- **Repo GitHub:** https://github.com/StefanoCatering/N-rmaCRM (branch `main`)
- **Producción:** Vercel, auto-deploy desde `main`. La URL exacta está en el dashboard de Vercel (no fue capturada en esta sesión).
- **Supabase project ref:** `bjnwremoaooglpxrnzgi`
  - Conexión directa: `db.bjnwremoaooglpxrnzgi.supabase.co:5432`
  - Pooler (recomendado en Vercel): `aws-0-us-east-1.pooler.supabase.com:6543`, requiere `DB_USER=postgres.bjnwremoaooglpxrnzgi`

---

## 3. Variables de entorno (solo nombres)

| Variable | Uso |
|---|---|
| `JWT_SECRET` | **Obligatoria.** Firma de JWT. El server lanza error al arrancar si falta. |
| `DB_HOST` | Host de Postgres/Supabase |
| `DB_NAME` | Nombre de la DB (`postgres`) |
| `DB_USER` | Usuario (directo: `postgres`; pooler: `postgres.<project-ref>`) |
| `DB_PASSWORD` | Password de la DB |
| `DB_PORT` | Puerto (directo `5432`, pooler `6543`) |
| `NODE_ENV` | `development` / `production` |
| `PORT` | Puerto local (default 8765) |

> Las credenciales de DB se leen **directamente de `process.env`** en `models/db.js`, con validación de arranque (falla si falta alguna). No pasan por `config.js`.
> `SESSION_SECRET` quedó obsoleta (se migró de express-session a JWT) — ya no se usa.

---

## 4. Estructura de archivos

```
narma_crm/
├── server.js                  # App Express, auth JWT, rutas de páginas, montaje de routers
├── config.js                  # PORT, SESSION_SECRET (legacy), NODE_ENV, ALERT_DAYS=15
├── seed.js                    # Seed idempotente de usuarios + clientes/pedidos demo
├── package.json
├── vercel.json                # builds @vercel/node + includeFiles public/**, views/**
├── .env.example
├── INICIAR.bat                # Launcher Windows
├── INICIAR_SILENCIOSO.vbs     # Launcher silencioso Windows
├── HANDOFF.md                 # Este documento
│
├── models/
│   ├── db.js                  # Pool pg, lee process.env, SSL rejectUnauthorized:false
│   ├── usuarios.js            # findByUsername, findById, create
│   ├── clientes.js            # CRUD + KPIs (activos, alertas, altas/bajas mes, tickets, evolución)
│   ├── pedidos.js             # listByCliente, getById, create, listFiltered, updatePago, count*
│   └── ubicaciones.js         # listByCliente, replaceForCliente (hasta 3 por cliente)
│
├── routes/
│   ├── clientes.js            # /api/clientes/* (incluye /kpis, /alertas, /empresas)
│   ├── pedidos.js             # /api/pedidos/* (list, create, PATCH pago)
│   └── export.js              # /api/export (Excel: datos | historial | pedidos)
│
├── views/                     # HTML servidos por sendFile
│   ├── login.html
│   ├── dashboard.html         # admin + visor
│   ├── inicio.html            # operador
│   ├── clientes.html          # listado + filtros + export
│   ├── cliente-ficha.html     # ficha + historial pedidos + editar pago (modal)
│   ├── cliente-form.html      # alta/edición cliente
│   ├── pedido-form.html       # alta de pedido
│   ├── pedidos.html           # historial global + filtros + editar pago (modal)
│   └── 403.html
│
├── public/
│   ├── css/styles.css         # Estilos (identidad Närma). Incluye .badge-pago-*, .metric-*
│   └── js/common.js           # api(), ensureSession(), renderNav(), labels, fmt*
│
└── supabase/
    ├── schema.sql             # Schema completo actual (fuente de verdad)
    ├── schema_ubicaciones.sql # Migración: tabla ubicaciones
    ├── schema_telefonos.sql   # Migración: clientes.telefono2, telefono3
    └── schema_obs.sql         # Migración: clientes.observaciones
```

---

## 5. Rutas API y permisos

Todas montadas bajo `requireAuth()` (JWT válido). Los permisos por rol se aplican con middlewares internos.

### Auth (server.js)
| Método | Ruta | Permiso |
|---|---|---|
| POST | `/api/login` | Público. Devuelve **302** a `/dashboard` (admin/visor) o `/inicio` (operador), setea cookie `narma_token` |
| POST | `/api/logout` | Autenticado. Borra cookie |
| GET | `/api/me` | Autenticado. Devuelve `{ user, alertDays }` |

### Clientes (routes/clientes.js)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/clientes` | Cualquier rol autenticado (filtros: estado, segmento, canal_origen, empresa, q) |
| GET | `/api/clientes/empresas` | Autenticado |
| GET | `/api/clientes/alertas` | **admin, visor** |
| GET | `/api/clientes/kpis` | **admin, visor** |
| GET | `/api/clientes/:id` | Autenticado (ficha + pedidos + ubicaciones) |
| POST | `/api/clientes` | admin, operador (visor bloqueado) |
| PUT | `/api/clientes/:id` | admin, operador (visor bloqueado) |
| PUT | `/api/clientes/:id/estado` | **solo admin** |
| PATCH | `/api/clientes/:id/seguimiento` | **solo admin** |

### Pedidos (routes/pedidos.js)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/pedidos` | admin, operador (ruta de página); filtros: cliente_id, fecha_desde/hasta, estado, estado_pago, tipo_vianda (incl. `sin_vianda`), segmento, canal_origen |
| POST | `/api/pedidos` | admin, operador (visor bloqueado) |
| PATCH | `/api/pedidos/:id/pago` | admin, operador (`requireEscritura`) |

### Export (routes/export.js)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/export?tipo=datos` | Autenticado. Excel de clientes (14 columnas) |
| GET | `/api/export?tipo=historial` | Autenticado. Excel 2 hojas (Resumen + Pedidos) |
| GET | `/api/export?tipo=pedidos` | Autenticado. Excel de pedidos filtrado |

### Páginas (server.js, sirven HTML)
`/` (redirect por rol), `/login`, `/dashboard` (admin/visor), `/inicio` (operador), `/clientes`, `/clientes/nuevo` (admin/operador), `/clientes/:id/editar` (admin/operador), `/clientes/:id`, `/pedidos/nuevo` (admin/operador), `/pedidos` (admin/operador).

---

## 6. Roles y permisos

| Rol | Dashboard/KPIs | Ver clientes/pedidos | Crear/editar cliente | Crear pedido | Editar pago pedido | Cambiar estado / seguimiento cliente |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **operador** | ❌ (va a `/inicio`) | ✅ | ✅ | ✅ | ✅ | ❌ |
| **visor** | ✅ (solo lectura) | ✅ | ❌ | ❌ | ❌ | ❌ |

- Auth por JWT (8h de expiración) en cookie `narma_token` (`httpOnly, secure, sameSite:none`).
- `trust proxy` no aplica (ya no se usa express-session); las cookies secure funcionan porque Vercel es HTTPS.

**Usuarios en producción** (verificado en DB): `Admin1` (operador), `Admin2` (operador), `Guadalupe` (admin), `Stefano` (admin), `Direccion` (visor).
**⚠️ `seed.js` define un set distinto** (`NarmaAdmin`/operador, `Stefano`/admin, `Guadalupe`/admin, `Direccion`/visor) — no correr el seed contra producción sin revisar, difiere de los usuarios reales.

---

## 7. Tablas de base de datos

### `usuarios`
`id` SERIAL PK · `username` TEXT UNIQUE · `password_hash` TEXT · `rol` TEXT CHECK IN (`operador`,`admin`,`visor`) · `created_at` TIMESTAMPTZ

### `clientes`
`id` SERIAL PK · `nombre_completo` TEXT · `cedula` TEXT UNIQUE · `email` TEXT · `telefono` TEXT · `telefono2` TEXT · `telefono3` TEXT · `observaciones` TEXT · `segmento` TEXT CHECK IN (`particular`,`empresa`,`embajador`) · `empresa` TEXT · `canal_origen` TEXT CHECK IN (`whatsapp`,`redes`,`embajador`,`boca_a_boca`,`b2b`,`otro`) · `codigo_embajador` TEXT · `estado` TEXT CHECK IN (`activo`,`pausado`,`inactivo`,`baja`) default `activo` · `fecha_ingreso` DATE · `seguimiento_marcado` INTEGER default 0 · `seguimiento_fecha` DATE · `created_at` / `updated_at` TIMESTAMPTZ

### `pedidos`
`id` SERIAL PK · `cliente_id` INTEGER FK→clientes ON DELETE CASCADE · `fecha_pedido` DATE · `monto` INTEGER · `monto_pagado` INTEGER · `estado_pago` TEXT CHECK IN (`pagado`,`pendiente`,`parcial`) default `pendiente` · `medio_pago` TEXT CHECK IN (`efectivo`,`transferencia`,`tarjeta`,`pos`,`cortesia`) · `tipo_vianda` TEXT CHECK IN (`economico`,`saludable`,`low_carb`,`modificacion_menu`) · `descripcion` TEXT · `fecha_entrega_desde` DATE · `fecha_entrega_hasta` DATE · `detalle_modificacion` TEXT · `created_at` TIMESTAMPTZ

### `ubicaciones`
`id` SERIAL PK · `cliente_id` INTEGER FK→clientes ON DELETE CASCADE · `orden` INTEGER default 1 · `direccion` TEXT · `zona` TEXT · `referencia` TEXT · `created_at` TIMESTAMPTZ (hasta 3 por cliente)

### `session`
Legacy de connect-pg-simple (`sid`, `sess`, `expire`). **Ya no se usa** (se migró a JWT) — se puede dropear en una limpieza futura.

---

## 8. Módulos implementados y estado

| Módulo | Estado |
|---|---|
| Auth JWT (login/logout/me, cookie httpOnly) | ✅ Funcionando |
| Roles (admin, operador, visor) | ✅ |
| Clientes: CRUD, filtros, búsqueda (nombre/cédula/teléfonos), contador "Mostrando X" | ✅ |
| Clientes: teléfonos múltiples, observaciones, hasta 3 ubicaciones de entrega | ✅ |
| Ficha de cliente: datos, ubicaciones, colaboradores por empresa, historial de pedidos | ✅ |
| Dashboard (admin/visor): KPIs, evolución 6 meses, ticket por segmento, alertas | ✅ |
| KPI cards: activos, alertas, altas/bajas mes, ticket general, pedidos recepcionados semana, viandas entregadas semana, cortesías mes | ✅ |
| Pedidos: alta con vianda, medio de pago, estado de pago (pagado/pendiente/parcial) | ✅ |
| Pedidos: fechas de entrega, modificación de menú (detalle), cortesía (solo embajador) | ✅ |
| Pedidos: historial global con filtros + contador + editar estado de pago (modal) | ✅ |
| Editar estado de pago desde ficha de cliente y desde lista de pedidos | ✅ |
| Export Excel (datos / historial / pedidos) con headers estilizados | ✅ |
| Seguimiento de alertas (marcar, solo admin) | ✅ |

---

## 9. Bugs conocidos / deuda técnica

1. **`listFiltered` no devuelve `monto_pagado`** → el modal "Editar pago" (en `pedidos.html` y también en `cliente-ficha.html`, cuyo `listByCliente` sí lo trae) arranca el campo "Monto abonado" **vacío** al editar un pedido que ya era parcial. El usuario reingresa el monto. Backend lo exige igual → consistente pero no ideal de UX.
2. **Export `tipo=pedidos` ignora los filtros nuevos** de la vista de pedidos (`estado_pago`, `tipo_vianda`, `segmento`, `canal_origen`). El botón "Exportar Excel" en `pedidos.html` solo respeta `cliente_id`, `fecha_desde/hasta` y `estado` del cliente. Si se quiere que el Excel refleje todos los filtros, hay que ampliar `exportarPedidos` en `routes/export.js`.
3. **`requireAdmin` sin uso en `routes/pedidos.js`** — quedó como código muerto tras cambiar el PATCH de pago a `requireEscritura`. Se puede eliminar en una limpieza.
4. **Datos legacy inconsistentes**: algunos pedidos `pagado` tienen `monto_pagado = 0` (ej. pedido id 2) en vez de `= monto`. No afecta KPIs (se basan en `monto`), pero el dato de pagado es incorrecto. Se podría normalizar con un UPDATE.
5. **`seed.js` desalineado con usuarios de producción** (ver sección 6). No correr el seed contra prod sin revisar.
6. **Tabla `session` huérfana** en Supabase (legacy de express-session). Segura de dropear.

---

## 10. Próximos sprints (backlog sugerido — no comprometido)

> No hay un backlog formal definido por el usuario. Estas son mejoras naturales derivadas de la deuda técnica y el dominio:

- Ampliar `exportarPedidos` para respetar todos los filtros de `pedidos.html`.
- Devolver `monto_pagado` en `listFiltered` para prefilltear el modal de pago.
- Editar/eliminar pedidos existentes (hoy solo se pueden crear y cambiar el pago).
- Normalizar datos legacy de `monto_pagado`.
- Alinear `seed.js` con usuarios reales, o separar seed de demo vs. seed de usuarios.
- Vista/gestión de usuarios desde la UI (hoy se crean solo por SQL/seed).
- Dropear tabla `session` y limpiar `SESSION_SECRET`/`requireAdmin` muerto.

---

## 11. Detalles técnicos importantes (no perder contexto)

- **Serverless + JWT**: se migró de express-session/connect-pg-simple a JWT porque en Vercel serverless el store de sesión no persistía de forma confiable. El login responde **302 real** (no JSON) para que el `Set-Cookie` viaje en el redirect y no haya race condition con la navegación del frontend.
- **`models/db.js`** lee credenciales directo de `process.env` con validación de arranque, porque el driver `pg` hace fallback silencioso a `PGHOST`/`PGDATABASE` si algún valor es `undefined` (causaba conexión al host equivocado en Vercel).
- **Postgres es estricto con fechas**: nunca construir fechas tipo `'YYYY-MM-31'` (SQLite las toleraba, PG tira error). Ver `evolucionActivosPorMes` en `models/clientes.js` (usa `new Date(año, mes+1, 0)` para el último día real). Fue un bug ya corregido (commit `2aac6dc`).
- **Semana corriente** = `date_trunc('week', CURRENT_DATE)` (lunes ISO) a +6 días (domingo). Usado en `countRecepcionadasEstaSemana` y `countEntregadasEstaSemana` (esta última con lógica de solape de rango).
- **Cortesía** (`medio_pago='cortesia'`) se valida en backend: solo permitida si el cliente es `segmento='embajador'`. En el frontend la opción se oculta/deshabilita si el cliente no es embajador.
- **Modificación de menú** (`tipo_vianda='modificacion_menu'`) exige `detalle_modificacion` no vacío.
- **Normalización de `monto_pagado`** (tanto en POST como en PATCH de pago): `pagado`→`monto` completo, `pendiente`→`null`, `parcial`→monto ingresado (entero > 0).
- **CSS**: badges de pago `.badge-pago-{pagado|pendiente|parcial}`; métricas `.metric-{blue|green|orange|yellow|pink}`. `common.js` tiene los mapas de labels (`SEGMENTO_LABEL`, `CANAL_LABEL`, `MEDIO_PAGO_LABEL`, `TIPO_VIANDA_LABEL`, `ESTADO_PAGO_LABEL`).
- **Migraciones SQL**: se aplican manualmente en el SQL Editor de Supabase (patrón idempotente: DROP constraint viejo si no incluye el valor nuevo, ADD el nuevo). El usuario las ejecuta; Claude no ejecuta DDL en prod.
- **CRLF/LF**: git avisa `LF will be replaced by CRLF` en Windows — es normal, no rompe nada.

---

## 12. Cómo arrancar el servidor localmente

```bash
cd C:\Users\HP\Desktop\narma_crm

# 1. Instalar dependencias (primera vez)
npm install

# 2. Crear .env a partir de .env.example y completar:
#    JWT_SECRET, DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, DB_PORT, NODE_ENV, PORT
#    (para generar un JWT_SECRET:)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. (Opcional) sembrar datos demo — OJO: revisar usuarios antes contra prod
npm run seed

# 4. Arrancar
npm start            # node server.js
```

Acceder en `http://localhost:8765` (o el `PORT` configurado).
En Windows también: `INICIAR.bat` o `INICIAR_SILENCIOSO.vbs`.

El server loguea al arrancar: `NODE_ENV`, si `JWT_SECRET` está configurado, y el host de DB al que conecta (`[db] Conectando a PostgreSQL → host=...`).

---

## 13. Historial de commits reciente

```
13ab996 feat: editar estado de pago desde la lista de pedidos (admin y operador)
cc9ff88 feat: permitir a operador editar estado de pago de pedidos
2cef6ba feat: edición de estado de pago en pedidos ya cargados (solo admin)
ce0252a feat: fechas de entrega, modificación de menú y segmento embajador/cortesía
4c17b38 feat: KPI pedidos esta semana, contadores, filtros de pedidos, pago parcial
18dd6bd feat: ubicaciones, telefonos, obs, historial pedidos operador
8a6a3bd feat: exportación a Excel (tipo=datos y tipo=historial)
d2f2288 feat: agregar rol visor (solo lectura)
2aac6dc fix: fechas inválidas en evolucionActivosPorMes para PostgreSQL
83d2340 feat: reemplazar express-session con autenticación JWT
```
