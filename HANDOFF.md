# Närma CRM — Documento de Handoff

> Estado del proyecto para continuar en una nueva sesión.
> Última actualización: 2026-10-19 · `main` en `6986b0b` (fase 8 mergeada). Todas las migraciones del repo están aplicadas.

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
| Seguridad | `helmet ^8.3.0` (headers HTTP), `express-rate-limit ^8.7.0` (rate limit en `/api/login`) |
| Frontend | HTML + Vanilla JS (sin framework), CSS propio |
| Hosting | Vercel (serverless, auto-deploy desde `main`) |

**No hay build step.** El frontend son archivos estáticos servidos por Express (`express.static`) + vistas HTML servidas con `sendFile`.

**No hay tests automatizados en el repo.** Ver sección 13 para cómo se verifica a mano contra un Postgres descartable.

---

## 2. URLs y repos

- **Repo GitHub:** https://github.com/StefanoCatering/N-rmaCRM (branch `main`)
- **Producción:** Vercel, auto-deploy desde `main`.
- **Supabase CRM:** ref `bjnwremoaooglpxrnzgi`
  - Conexión directa: `db.bjnwremoaooglpxrnzgi.supabase.co:5432`
  - **Pooler (lo que usa producción): `aws-1-us-east-1.pooler.supabase.com:6543`**, requiere `DB_USER=postgres.bjnwremoaooglpxrnzgi`. Confirmado en los runtime logs de Vercel.

> ⚠️ **El CRM corre detrás del pooler en MODO TRANSACCIÓN: prohibido usar locks o estado de sesión.**
> En ese modo un statement suelto puede ejecutarse en cualquier backend del pool, y solo un `BEGIN…COMMIT` queda fijo a uno. Por lo tanto **nada** que viva a nivel de sesión es confiable: `pg_advisory_lock`/`pg_advisory_unlock`, `SET` sin `LOCAL`, `LISTEN`/`NOTIFY`, prepared statements con nombre, tablas temporales, `search_path` propio. El caso peligroso no es que no funcione, sino que *parezca* funcionar: un `pg_advisory_unlock` que cae en otro backend devuelve `false` sin error y deja el lock tomado para siempre en el backend original, colgando a todos los que vengan después hasta el timeout de Vercel.
> Si hace falta serializar, usar `pg_advisory_xact_lock` dentro de una transacción explícita: lo libera Postgres en el COMMIT/ROLLBACK, pase lo que pase.
> Ojo al probar en local contra un Postgres directo: **sin pooler, estos errores no se reproducen**.
- **Supabase Narma Pedidos:** ref `rgppcvqoephcjjcnqwnz` — **otro proyecto**. Acá vive `pedidos_crm_detalle`, destino del sync. Su esquema lo gestiona el repo narma-pedidos; este repo solo la escribe.

---

## 3. Variables de entorno (solo nombres)

| Variable | Uso |
|---|---|
| `JWT_SECRET` | **Obligatoria.** Firma de JWT. El server lanza error al arrancar si falta. |
| `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_PORT` | Postgres del CRM. `models/db.js` falla al arrancar si falta alguna. |
| `PEDIDOS_DATABASE_URL` | Connection string de la base de Narma Pedidos (fase 6). **Opcional**: si falta, el sync queda deshabilitado, el CRM sigue funcionando y cada intento se registra en `sync_errores`. |
| `NODE_ENV` | `development` / `production` |
| `PORT` | Puerto local (default 8765) |

---

## 4. Estructura de archivos

```
narma_crm/
├── server.js                  # App Express, auth JWT, rutas de páginas, montaje de routers
├── config.js                  # PORT, NODE_ENV, ALERT_DAYS=15
├── seed.js                    # Seed de usuarios + clientes/pedidos demo — NO correr contra prod
├── vercel.json                # builds @vercel/node + includeFiles public/**, views/**
│
├── models/
│   ├── db.js                  # Pool pg del CRM. Lee process.env, SSL rejectUnauthorized:false
│   ├── dbPedidos.js           # Pool pg de Narma Pedidos (fase 6). Si no hay URL, sync deshabilitado
│   ├── usuarios.js            # findByUsername, findById, create, gestionaGrilla
│   ├── clientes.js            # CRUD + KPIs. Los tickets excluyen pedidos origen='grilla'
│   ├── pedidos.js             # listByCliente, getById, getConDetalle, create, listFiltered, update, cancelar, auditar
│   ├── pedidoDetalle.js       # Líneas + excepciones + resolución de fechas (lun-vie). Helpers de fecha
│   ├── platos.js              # Catálogo. etiquetaPlato() = nombre único de plato en todo el sistema
│   ├── ubicaciones.js         # listByCliente, replaceForCliente (hasta 3), belongsToCliente
│   ├── syncPedidos.js         # Espejado CRM → Narma Pedidos. Nunca hace fallar el guardado
│   └── grilla.js              # Fase 7: cálculo de totales, envío semanal, hoja del día
│
├── routes/
│   ├── clientes.js            # /api/clientes/* (incluye /kpis, /alertas, /empresas)
│   ├── pedidos.js             # /api/pedidos/* (list, create, pago, editar, cancelar, líneas, excepciones)
│   ├── platos.js              # /api/platos (catálogo activo por categoría)
│   ├── grilla.js              # /api/grilla/* (fase 7)
│   └── export.js              # /api/export (Excel: datos | historial | pedidos)
│
├── views/                     # HTML servidos por sendFile (13 vistas)
│   ├── login.html · 403.html
│   ├── dashboard.html         # admin + visor
│   ├── inicio.html            # operador
│   ├── clientes.html · cliente-ficha.html · cliente-form.html
│   ├── pedidos.html · pedido-form.html · pedido-detalle.html
│   ├── grilla.html · grilla-dia.html     # fase 7
│   └── cuenta.html            # fase 8 — cambio de contraseña propia (todos los roles)
│
├── public/
│   ├── css/styles.css         # Estilos Närma. Incluye sección GRILLA y reglas @media print
│   └── js/common.js           # api(), ensureSession(), renderNav(), labels, fmt*
│
├── migrations/                # SQL que se corre A MANO en el SQL Editor de Supabase
│   ├── fase4_fix_monto_pagado.sql      ✅ aplicada
│   ├── fase4_drop_legacy_tables.sql    ✅ aplicada
│   ├── fase5_indices.sql               ✅ aplicada
│   ├── fase6_pedidos_estructurados.sql ✅ aplicada
│   ├── fase7_grilla_comedor.sql        ✅ aplicada
│   └── fase8_auditoria_usuarios.sql    ✅ aplicada
│
└── supabase/                  # Schema histórico (schema.sql es la base original)
```

---

## 5. Rutas API y permisos

Todas montadas bajo `requireAuth()` (JWT válido). Los permisos finos se aplican con middlewares definidos localmente en cada archivo de rutas.

### Auth (server.js)
| Método | Ruta | Permiso |
|---|---|---|
| POST | `/api/login` | Público (rate limit 8/15min por IP). **302** a `/dashboard` o `/inicio`, setea cookie `narma_token` |
| POST | `/api/logout` | Autenticado |
| GET | `/api/me` | Autenticado. `{ user: {id, username, rol, gestiona_grilla}, alertDays }` — todo sale de la base, no del JWT |
| POST | `/api/cuenta/password` | Autenticado, **cualquier rol incluido visor** (rate limit 8/15min por IP, con contador propio). Cambia la contraseña del usuario logueado |

> **`requireAuth` lee la base en cada request** (fase 8): una consulta por id que trae `activo`, `rol` y `gestiona_grilla`. Si el usuario no existe o está desactivado, limpia la cookie y devuelve 401 (API) o redirige a `/login` (páginas). El **rol sale de la base**, así que cambiarlo aplica en el acto y no al vencer el token de 8 h.

### Clientes (routes/clientes.js)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/clientes` | Autenticado (filtros: estado, segmento, canal_origen, empresa, q) |
| GET | `/api/clientes/empresas` | Autenticado |
| GET | `/api/clientes/alertas` · `/kpis` | **admin, visor** |
| GET | `/api/clientes/:id` | Autenticado (ficha + pedidos + ubicaciones) |
| POST/PUT | `/api/clientes` · `/:id` | admin, operador (visor bloqueado) |
| PUT | `/api/clientes/:id/estado` | **solo admin** |
| PATCH | `/api/clientes/:id/seguimiento` | **solo admin** |

### Pedidos (routes/pedidos.js)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/pedidos` | Autenticado. Filtros varios. Devuelve `origen` y `semana_lunes` |
| GET | `/api/pedidos/:id` | Autenticado. Pedido + líneas + excepciones |
| GET | `/api/pedidos/:id/auditoria` | Autenticado |
| GET | `/api/pedidos/sync/errores` | **solo admin**. Bitácora de syncs fallidos |
| POST | `/api/pedidos` | admin, operador. Acepta `lineas[]`. Guarda `recibido_por` y audita `creacion` **en la misma transacción** (fase 8) |
| PATCH | `/api/pedidos/:id/pago` | admin, operador. Audita `pago` con antes/después, en la misma transacción (fase 8) |
| PATCH | `/api/pedidos/:id` · `/:id/cancelar` | admin, operador (visor bloqueado), motivo obligatorio |
| POST/PATCH | `/:id/lineas` · `/:id/lineas/:lineaId` · `/cancelar` | admin, operador (visor bloqueado), motivo obligatorio |
| PUT/DELETE | `/:id/lineas/:lineaId/excepciones[/:excId]` | admin, operador (visor bloqueado), motivo obligatorio |

> **Editar y cancelar pedidos dejó de ser exclusivo del admin** (fase 8): lo hace cualquiera que no sea visor, con el **motivo obligatorio y la auditoría intactos**. Lo único que sigue pidiendo rol admin en este archivo es `GET /sync/errores`.

> **Los pedidos con `origen = 'grilla'` rechazan con 400 todos los endpoints de edición de arriba** (incluido `/pago`): los gobierna la grilla semanal y cualquier cambio manual sería pisado en el siguiente envío.

### Platos (routes/platos.js)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/platos` | Autenticado. Catálogo activo por categoría, con `etiqueta`. **Excluye la categoría `General`** |

### Grilla de comedor (routes/grilla.js — fase 7)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/grilla/empresas` · `/semana` · `/dia` · `/candidatos` | **admin, visor o `gestiona_grilla`** |
| PUT/DELETE | `/api/grilla/celda` | **solo `gestiona_grilla`** |
| PUT | `/api/grilla/celda/rango` | **solo `gestiona_grilla`** |
| PUT/DELETE | `/api/grilla/sin-servicio` | **solo `gestiona_grilla`** |
| PUT | `/api/grilla/general` | **solo `gestiona_grilla`** |
| POST | `/api/grilla/planes` · PATCH `/planes/:cliente_id` | **solo `gestiona_grilla`** |
| POST | `/api/grilla/enviar` · `/reintentar-sync` | **solo `gestiona_grilla`** |

### Export (routes/export.js)
`GET /api/export?tipo=datos|historial|pedidos` — autenticado. **Excluye los pedidos `origen='grilla'`** de las hojas y de los promedios/totales de monto.

### Páginas (server.js)
`/` (redirect por rol), `/login`, `/dashboard` (admin/visor), `/inicio` (operador), `/clientes`, `/clientes/nuevo`, `/clientes/:id/editar`, `/clientes/:id`, `/pedidos`, `/pedidos/nuevo`, `/pedidos/:id/editar`, `/cuenta` (cualquier usuario logueado), `/grilla` y `/grilla/dia` (admin, visor o `gestiona_grilla`).

---

## 6. Roles y permisos

| Rol | Dashboard/KPIs | Ver clientes/pedidos | Crear/editar cliente | Crear pedido | Editar pago | Editar/cancelar pedido, líneas | Estado/seguimiento cliente | Ver grilla | Editar grilla |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **operador** | ❌ (va a `/inicio`) | ✅ | ✅ | ✅ | ✅ | ✅ (fase 8) | ❌ | solo con permiso | solo con permiso |
| **visor** | ✅ (solo lectura) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (lectura) | ❌ |

- **`usuarios.gestiona_grilla` NO es un rol**: es un permiso aparte, en su propia columna. En producción lo tiene `Admin1`, que es **`operador`**. Editar la grilla depende solo de ese flag; ser admin no alcanza.
- Se lee de la base en cada request de escritura (`usuarios.gestionaGrilla`), no del JWT: sacarle el permiso a alguien aplica en el acto y no cuando se le vence el token de 8 h.
- Auth por JWT (8 h) en cookie `narma_token` (`httpOnly, secure, sameSite:lax`). El token solo dice **quién** es: `activo` y `rol` se leen de la base en cada request (fase 8).
- **`usuarios.activo = false`** corta el acceso en el acto: el login responde 401 `Usuario desactivado`, y un request con un token todavía vigente queda sin cookie y afuera. Se desactiva, no se borra: el id está referenciado por `pedidos.recibido_por`/`verificado_por` y `grilla_celdas.updated_by`.
- **Cada usuario cambia su propia contraseña** en `/cuenta` (visor incluido): pide la actual, exige 8 caracteres como mínimo y guarda un hash bcrypt. Nadie cambia la de otro desde la app.

**Usuarios en producción:** `Admin1` (operador, `gestiona_grilla` tras correr la fase 7), `Admin2` (operador), `Guadalupe` (admin), `Stefano` (admin), `Direccion` (visor).
`seed.js` usa los mismos usernames con contraseñas ficticias — **no correrlo contra producción**.

---

## 7. Tablas de base de datos

### Base del CRM (`bjnwremoaooglpxrnzgi`)

#### `usuarios`
`id` · `username` UNIQUE · `password_hash` · `rol` CHECK IN (`operador`,`admin`,`visor`) · **`gestiona_grilla` BOOLEAN NOT NULL default false** (fase 7) · **`activo` BOOLEAN NOT NULL default true** (fase 8) · `created_at`

#### `clientes`
`id` · `nombre_completo` · `cedula` UNIQUE · `email` · `telefono`/`telefono2`/`telefono3` · `observaciones` · `segmento` CHECK IN (`particular`,`empresa`,`embajador`) · `empresa` · `canal_origen` · `codigo_embajador` · `estado` · `fecha_ingreso` · `seguimiento_marcado`/`seguimiento_fecha` · **`tipo_envase` CHECK IN (`Narma`,`Venezia`) default `Venezia`** (fase 6) · `created_at`/`updated_at`

#### `pedidos`
`id` · `cliente_id` FK · `fecha_pedido` · `monto` INTEGER NOT NULL (**sin CHECK: acepta 0**) · `monto_pagado` · `estado_pago` · `medio_pago` · `tipo_vianda` · `descripcion` · `fecha_entrega_desde`/`hasta` · `detalle_modificacion` · `cancelado` · **`ubicacion_id` FK→ubicaciones ON DELETE SET NULL** (fase 6) · **`origen` CHECK IN (`grilla`)** y **`semana_lunes` DATE** (fase 7) · **`recibido_por` FK→usuarios** (quién lo cargó; NULL en los 772 pedidos anteriores a la fase 8 y en los que arma la grilla) · `verificado_por` FK→usuarios (sin uso en el código) · `created_at`
Índice único parcial `(cliente_id, semana_lunes) WHERE origen='grilla'`.

#### `ubicaciones`
Sin cambios desde la fase 3. Hasta 3 ubicaciones por cliente.

#### `pedidos_auditoria`
`pedido_id` FK · `accion` · `usuario` TEXT (username) · `detalle` JSONB · `motivo` · `fecha`.
**Fase 8**: `accion` pasa a CHECK IN (`edicion`,`cancelacion`,`creacion`,`pago`) y `motivo` deja de ser NOT NULL — `creacion` y `pago` van sin motivo, y un CHECK nuevo lo sigue exigiendo no vacío en `edicion` y `cancelacion`.

#### Fase 6
- **`platos`**: `id` · `categoria` · `nombre` · `activo` INTEGER (0/1). UNIQUE `(categoria, nombre)`.
- **`pedido_detalle`**: línea de pedido (`plato_id`, `cantidad`, `comentario`, `modo` puntual/recurrente, fechas, `tipo_envase_override`, `cancelado`).
- **`pedido_detalle_excepciones`**: pisa una fecha de una línea recurrente. UNIQUE `(pedido_detalle_id, fecha)`.
- **`sync_errores`**: bitácora local de syncs fallidos, con payload reenviable. Sin FK a propósito.

#### Fase 7
- **`grilla_empresas`**: `empresa` PK (= `clientes.empresa`) · `cliente_pedido_id` FK (cliente "cuenta empresa", dueño del pedido semanal) · `ubicacion_id` FK · `activa`.
- **`grilla_planes`**: `cliente_id` PK FK · `plato_base_id` FK · `observacion` · `fecha_alta` · `fecha_baja` (**exclusiva**: primer día que ya NO come).
- **`grilla_celdas`**: una diferencia por (`cliente_id`, `fecha`) UNIQUE. CHECK `num_nonnulls(plato_id, ausencia) = 1`. `ausencia` IN (`home_office`,`vacaciones`,`reposo`,`licencia`,`otro`). **Sin fila = plato base.**
- **`grilla_sin_servicio`**: PK (`empresa`, `fecha`). Ese día no se produce nada para esa empresa.
- **`grilla_general`**: PK (`empresa`, `fecha`, `plato_id`), `cantidad >= 0`. Ítems que no van por persona.
- **`grilla_auditoria`**: log automático de toda escritura de la grilla (`tabla`, `clave`, `antes`/`despues` JSONB). Sin FK. El estado del último envío de una semana se lee de acá (`tabla='grilla_envio'`).

### Base de Narma Pedidos (`rgppcvqoephcjjcnqwnz`)
**`pedidos_crm_detalle`** — NO se migra desde este repo. Su contrato (columnas, NOT NULLs, UNIQUE `(crm_pedido_detalle_id, fecha_entrega)`) está documentado en la cabecera de `models/syncPedidos.js`. Si cambia allá, hay que acompañar el cambio acá.

---

## 8. Módulos implementados y estado

| Módulo | Estado |
|---|---|
| Auth JWT, roles, rate limit en login | ✅ |
| Clientes: CRUD, filtros, búsqueda, ficha, colaboradores por empresa, hasta 3 ubicaciones | ✅ |
| Dashboard (admin/visor): KPIs, evolución 6 meses, ticket por segmento, alertas | ✅ |
| Pedidos: alta, estado de pago, historial con filtros, export Excel | ✅ |
| Pedidos: edición y cancelación con auditoría y motivo obligatorio | ✅ (fase 3; desde la fase 8 también el operador, visor no) |
| Hardening: helmet + CSP, rate limit, índices | ✅ (fase 5) |
| Pedidos estructurados: catálogo de platos, líneas puntuales/recurrentes, excepciones por fecha | ✅ (fase 6) |
| Sync CRM → Narma Pedidos (auto-reparador, nunca bloquea el guardado, bitácora de errores) | ✅ (fase 6) |
| Grilla semanal de comedor: planes, celdas, rangos, día sin servicio, pedido general | ✅ (fase 7) |
| Grilla: totales por plato/día calculados en el servidor y envío como pedido semanal | ✅ (fase 7) |
| Grilla: hoja del día imprimible | ✅ (fase 7) |
| Auditoría de creación y de cambio de pago, `recibido_por` en el detalle del pedido, usuarios desactivables, cambio de contraseña propia | ✅ (fase 8) |
| Facturación del comedor, control de retiro, importación de la planilla del banco | ❌ Fuera de alcance de la fase 7 |
| App de colaboradores | ❌ No existe |

---

## 9. Bugs conocidos / deuda técnica

1. **`listFiltered` no devuelve `monto_pagado`** → el modal "Editar pago" en `pedidos.html` arranca con el campo vacío al editar un pedido parcial. El backend lo exige igual, así que es solo UX.
2. **Export `tipo=pedidos` ignora los filtros nuevos** de la vista (`estado_pago`, `tipo_vianda`, `segmento`, `canal_origen`). Solo respeta `cliente_id`, fechas y `estado` del cliente.
3. **Los `<script>` inline de las 12 vistas** obligan a `script-src 'unsafe-inline'` en la CSP (ver sección 11). Sacarlos es un refactor grande.
4. **`grilla_empresas` se carga a mano.** No hay UI para vincular una empresa con su cliente cuenta-empresa; hoy es un INSERT en el SQL Editor. Sin esa fila la grilla no muestra ninguna empresa.
5. **La grilla no tiene vista de auditoría.** Todo queda en `grilla_auditoria`, pero solo se consulta por SQL. `pedido-detalle.html` de un pedido de grilla muestra "sin auditoría" porque su historial vive en la otra tabla.
6. **La semana por defecto de `/grilla` es la del lunes de hoy.** Un sábado o domingo eso cae en la semana que ya terminó y queda todo en solo lectura; hay que apretar "Semana siguiente". El aviso del jueves mitiga el caso real.
7. **Al desactivar un plato del catálogo** las celdas y planes que lo usaban siguen apuntándolo. Se muestra bien (la etiqueta se resuelve igual) pero no se puede volver a elegir.

### Resueltos desde el handoff anterior
`requireAdmin` muerto en `routes/pedidos.js` (ahora se usa), datos legacy de `monto_pagado` (migración corrida), `seed.js` desalineado (corregido), tabla `session` huérfana (dropeada en fase 4).

---

## 10. Próximos sprints (backlog sugerido — no comprometido)

- **Terminar de vincular los comedores en `grilla_empresas`** (estado al 2026-10-19): `UENO BANK` vinculada y activa, `Kaitel` vinculada pero con `activa = false`, e `Itti SAE` todavía sin fila. Se cargan con un INSERT manual (el ejemplo está comentado al final de la sección 2 de la migración de la fase 7).
- UI de administración de usuarios: hoy `usuarios.activo` y el reseteo de contraseña ajena se tocan por SQL. El usuario cambia la propia desde `/cuenta`.
- Completar `recibido_por` en el pedido semanal de la grilla (hoy queda NULL y el detalle muestra "—").
- Facturación del comedor: hoy el pedido semanal nace con `monto = 0` a propósito.
- Control de retiro e importación de la planilla del banco (quedaron fuera de la fase 7).
- UI para administrar `grilla_empresas` en lugar de SQL a mano.
- Vista de auditoría de la grilla (hoy solo por SQL).
- Ampliar `exportarPedidos` para respetar todos los filtros de `pedidos.html`.
- Devolver `monto_pagado` en `listFiltered`.
- Vista/gestión de usuarios y del permiso `gestiona_grilla` desde la UI (hoy solo por SQL).
- Mover los `<script>` inline a `public/js/` para poder sacar `'unsafe-inline'` de `script-src`.

---

## 11. Detalles técnicos importantes (no perder contexto)

### Generales
- **Serverless + JWT**: se migró de express-session a JWT porque en Vercel el store de sesión no persistía. El login responde **302 real** para que el `Set-Cookie` viaje en el redirect.
- **`models/db.js`** lee credenciales directo de `process.env` con validación de arranque: el driver `pg` hace fallback silencioso a `PGHOST`/`PGDATABASE` si algo es `undefined`.
- **Postgres es estricto con fechas**: nunca construir `'YYYY-MM-31'`. Ver `evolucionActivosPorMes`.
- **Migraciones**: se corren A MANO en el SQL Editor de Supabase. Claude no ejecuta DDL en prod. Patrón idempotente: `IF NOT EXISTS` + guardas sobre `pg_constraint` + `ON CONFLICT DO NOTHING`.
- **Helmet / CSP**: CSP por defecto salvo `script-src: ['self','unsafe-inline']`, porque las vistas cargan su lógica en un `<script>` inline. `style-src` y `font-src` ya traen lo necesario para los `style="..."` y Google Fonts.
  - La CSP por defecto incluye **`upgrade-insecure-requests`**: correcto en producción (HTTPS), pero si se sirve la app por HTTP plano para probar, el navegador reescribe los `fetch` a `https://` y el login falla con "Failed to fetch". Es esperable, no un bug.
- **CRLF/LF**: `core.autocrlf=true`. Git avisa `LF will be replaced by CRLF`; es normal.

### Fase 6 — pedidos estructurados y sync
- **Las líneas recurrentes solo producen lunes a viernes** (`DIAS_HABILES` en `models/pedidoDetalle.js`). Para entregar un fin de semana hay que cargar una línea puntual.
- **`tipo_vianda` y `descripcion` siguen existiendo** y no se tocaron: el dashboard histórico depende de ellos. Las líneas se suman a eso, no lo reemplazan.
- **El sync nunca hace fallar el guardado en el CRM.** Si falla, el pedido queda guardado, el intento va a `sync_errores` con payload completo y la respuesta lo informa.
- **El sync sincroniza el pedido COMPLETO en cada cambio**, no solo lo que se tocó. Es más tráfico pero es auto-reparador.
- **Nunca se borra nada del lado de Pedidos**: lo que deja de corresponder se marca `cancelado = true` con un UPDATE.
- **"Corporativo" es solo la etiqueta visible** de `segmento = 'empresa'`. A la base y al sync viaja el valor crudo.

### Fase 7 — grilla de comedor
- **El default es cocinar.** Todo colaborador con plan activo recibe su plato base todos los días hábiles. ATC solo marca diferencias; **sin fila en `grilla_celdas` = plato base**. Es la regla de la que sale todo el diseño.
- **`grilla_planes.fecha_baja` es EXCLUSIVA**: es el primer día que la persona ya NO come.
- **Los días anteriores a hoy son intocables.** No se pueden marcar celdas, no se acepta una `fecha_baja` pasada, no se envía una semana ya terminada y —lo más importante— `conciliarLineas` **no crea, no actualiza y no cancela** líneas con `fecha_entrega < hoy`. Sin esa guarda, un cambio de plato base reescribía días que cocina ya había producido, también del lado de Narma Pedidos.
- **"Hoy" se calcula en `America/Asuncion`**, no en UTC ni con la hora del server (`ZONA_HORARIA` en `models/grilla.js`). Con UTC, a partir de las 21:00 de Paraguay el día en curso quedaría en solo lectura antes de tiempo.
- **`platos.etiquetaPlato(categoria, nombre)` es la ÚNICA forma de nombrar un plato**: `Básicos` y `General` van sin prefijo (`Estándar`, `Jugo`), el resto con su categoría (`Pollo Grille · Papa`, `Ensaladas · César`). El nombre pelado no alcanza: `César` existe en Ensaladas y en Wraps, y `Papa` suelto no dice que es una guarnición. La etiqueta se arma **en el servidor** y viaja hecha a las vistas y a `pedidos_crm_detalle.plato_nombre`, que es lo único que ve cocina — las vistas no repiten la regla.
- **La categoría `General`** (sopa, ensalada mixta, jugo, vinagreta) es un eje aparte: `models/platos.js` la excluye del catálogo por persona y solo entra por el pedido general. **El nombre de la categoría es parte del contrato** (`CATEGORIA_GENERAL`): renombrarla rompe la separación.
- **`enviarSemana` está serializado por (empresa, semana) con `pg_advisory_xact_lock`** — un lock de **transacción**, nunca de sesión (ver la advertencia del pooler en la sección 2). Corre en dos transacciones, cada una abriendo con el mismo lock:
  1. **conciliación**: toma el lock, *después* lee la grilla con el client de esa transacción (`cargarSemana`/`getEmpresa` aceptan un `ejecutor`), calcula los totales, crea o reusa el pedido, concilia las líneas y COMMIT.
  2. **sync**: nueva transacción, mismo lock, y recién ahí `syncPedidos.sincronizarSinFallar`. Como el sync lee el estado ya commiteado del CRM solo cuando tiene el lock, el último en entrar es el que lee el estado final: no puede quedar una foto vieja pisando a una nueva en Narma Pedidos.
  Se separan en dos porque el sync habla con **otra base**, y dejarlo dentro de la transacción de conciliación la mantendría abierta durante una llamada de red a otro proyecto.
  La lectura tiene que ir **dentro** del lock: si quedara afuera, dos envíos podrían calcular sobre la misma foto y el segundo pisaría al primero. `POST /reintentar-sync` toma el mismo lock por el mismo motivo.
  El lock es por empresa y semana: no serializa envíos de semanas ni de empresas distintas.
- **El pedido semanal nace con `monto = 0`** y `estado_pago = 'pendiente'`: la facturación del comedor no pasa por el CRM en esta fase. Verificado que `pedidos.monto` no tiene CHECK.
- **Los pedidos `origen='grilla'` están fuera de toda métrica de monto**: `PEDIDOS_AGG` y los tickets de `models/clientes.js` usan `FILTER (WHERE origen IS DISTINCT FROM 'grilla')`, y `routes/export.js` los excluye de las hojas y de los promedios. En el listado sí aparecen, con etiqueta "Grilla" y el monto en `—`.
- **`grilla_empresas.ubicacion_id` tiene que ser una ubicación del cliente cuenta-empresa.** No se puede exigir con un CHECK, así que lo valida `enviarSemana`: si no corresponde, el envío se rechaza con un mensaje claro en vez de mandarle a producción la dirección de otro cliente.
- **La auditoría de la grilla NO pide motivo** (a diferencia de `pedidos_auditoria`): la grilla se toca decenas de veces por semana y un modal de motivo por celda la volvería inusable. Se registra sola en `grilla_auditoria`.
- **Toda escritura de una semana ya enviada dispara el reenvío automático** de esa semana. Si la semana todavía no se envió, el cambio solo se guarda.

---

## 12. Cómo arrancar el servidor localmente

```bash
cd C:\Users\HP\Desktop\narma_crm
npm install                 # primera vez
# Crear .env a partir de .env.example y completar JWT_SECRET, DB_* (y PEDIDOS_DATABASE_URL si se quiere el sync)
npm start                   # http://localhost:8765
```

> `.env` apunta a **producción**. No hay base de desarrollo: para probar escrituras, ver la sección 13.

---

## 13. Cómo verificar cambios sin tocar producción

No hay tests en el repo y la base de dev es la de prod, así que lo que se usó en la fase 7 fue levantar un **PostgreSQL real y descartable**:

- **Docker NO sirve en esta máquina**: Docker Desktop está instalado pero no arranca (`remove ...sailor-ingest.sock: The file cannot be accessed by the system`). No perder tiempo ahí.
- **Sí sirve** `npm install --no-save embedded-postgres@17.10.0-beta.17`. `node_modules/` está en `.gitignore` y `--no-save` deja `package.json`/`package-lock.json` intactos. Desinstalar al terminar.
  - La **18.x no anda**: `initdb` muere con `exception 0xC0000005`.
  - Es **ESM puro**: desde CJS hay que usar `await import(pathToFileURL(...))`.
  - Pasarle `initdbFlags: ['--encoding=UTF8', '--locale=C']` (el default de la máquina es WIN1252 y los platos tienen acentos).
- **Hay que habilitar SSL en el cluster de prueba**: los pools conectan con `ssl: { rejectUnauthorized: false }` y `pg` falla contra un servidor sin SSL. Generar un autofirmado con `openssl` en el data dir y agregar `ssl = on` + `ssl_cert_file` + `ssl_key_file` a `postgresql.conf` antes de arrancar.
- Montar **dos bases**: `crm_test` (aplicarle `supabase/schema.sql` + las migraciones en orden) y `pedidos_test` con `pedidos_crm_detalle` según el contrato de `models/syncPedidos.js`. Así se puede verificar qué filas vería cocina de verdad.
- **El entorno de prueba es un Postgres directo, sin pooler.** Todo lo que falle solo detrás de PgBouncer en modo transacción (ver la advertencia de la sección 2) es invisible acá. Para eso la suite incluye una guarda estática que revisa el código fuente: ningún archivo de `models/` ni `routes/` puede contener `pg_advisory_lock(` o `pg_advisory_unlock`.
- Para QA visual por navegador sobre HTTP plano hay que sacar `upgrade-insecure-requests` de la CSP **en el arnés de prueba**, nunca en `server.js`.
