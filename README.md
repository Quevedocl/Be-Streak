# BeStreak v3 — rediseño estilo Instagram

## Qué se agregó en esta vuelta
- **Perfil editable**: en la pestaña "Perfil" puedes cambiar tu foto
  (toca tu avatar), tu nombre de usuario y tu biografía. Guarda con
  "Guardar cambios".
- **Tocar el nombre de cualquier usuario** (en el feed, el chat o el
  ranking) abre su perfil de solo lectura: avatar, bio, estadísticas y
  grid de sus publicaciones.
- **Fotos más chicas y más nítidas**: el feed ahora muestra las fotos
  en un cuadro 1:1 (como Instagram) con bordes redondeados y un ancho
  máximo, en vez de ocupar toda la pantalla. Además, la captura se
  guarda con más calidad (0.92 en vez de 0.85) y a una resolución
  máxima de 1280px por lado, para que no se vean "rascas" al escalarse.
- **Rediseño tipo Instagram**: barra inferior con 3 íconos (Inicio,
  Chat, Perfil — sin historias ni reels, como pediste). El Ranking y
  el Panel de administrador pasaron a ser pantallas propias
  accesibles desde el ícono 🏆 y desde el botón del Perfil,
  respectivamente, para no saturar la barra inferior.
- **Deslizar hacia la izquierda en el Inicio abre la cámara**
  automáticamente (gesto tipo Instagram/Snapchat).
- **Chat con más detalle**: burbujas con avatar del remitente, hora de
  cada mensaje, y nombre agrupado como en las apps de mensajería.
  Se agregó un sonido corto al enviar y otro al recibir un mensaje
  (generado en el momento, no son archivos de audio externos).
- **Sin zoom al doble-tap**: se bloqueó el "double-tap to zoom" del
  navegador (con `touch-action: manipulation` + una verificación en
  JS), manteniendo el pellizco para zoom (pinch-zoom) por accesibilidad.

## Nota honesta sobre "copia exacta de Instagram"
Hice un rediseño visual profundo (feed, perfil con grid, chat con
burbujas, nav inferior, gestos) inspirado 1:1 en los patrones de
Instagram, pero no es un clon pixel-perfect de su código — eso
implicaría reescribir la app desde cero con animaciones, transiciones
y detalles que no alcanzan en una sola pasada. Si hay algo puntual que
quieras que se vea más parecido (por ejemplo, doble-tap en la foto
para reaccionar con ❤️, o una vista de foto en pantalla completa),
dime cuál y lo afino en la próxima vuelta.

## Un paso nuevo que debes hacer
Corre `migration_v3.sql` en el SQL Editor de Supabase (agrega las
columnas `bio` y `avatar_url` a `profiles`). Es seguro, no borra nada.

---

# BeStreak v2 — mejoras añadidas

## Qué se agregó

- **Cámara**: la foto capturada ya NO se invierte (espejo) — se guarda y
  se ve tal cual la realidad. El visor en vivo sigue en modo espejo
  (para encuadrarte cómodamente), pero eso es solo visual.
- **Zoom real de cámara**: slider de zoom (1x–5x). Si el navegador
  expone zoom óptico/de hardware (Chrome/Android) lo usa; si no, hace
  zoom digital de calidad sobre el video.
- **Auto-envío**: ya no hay botón "Enviar". Al tomar la foto arranca
  una cuenta regresiva de 2 segundos y se sube sola; solo puedes
  cancelarla tocando "Repetir".
- **11 temas de diseño** (Mono, Oscuro, Atardecer, Océano, Bosque,
  Neón, Pastel, Retro, Oro rosa, Café, Cyberpunk, Lavanda) — pestaña
  "Yo" → "Tema de la app". Se guarda por usuario.
- **Freezes de racha** (2 al mes, como Duolingo): si te saltas UN día,
  se usa un freeze automático y no pierdes la racha ni se activa el
  castigo.
- **Racha grupal perfecta**: si todo el grupo sube foto el mismo día,
  sube un contador aparte (🌟 en el header).
- **Ranking del grupo** por racha actual y mejor racha histórica.
- **Heatmap de constancia** (calendario tipo GitHub) en tu perfil.
- **Insignias** por hitos de racha (7, 14, 30, 60, 100, 200, 365 días).
- **Reacciones** (🔥😂👀💀🥶🙌) y **comentarios** en cada foto del feed.
- **Muro de castigos**: historial de quién rompió la racha, con botón
  para marcar el castigo como cumplido.
- **Chat de grupo** en tiempo real (pestaña "Chat").
- **Notificaciones push a las 21:00**: si ya subiste tu foto, NO te
  llega nada; si no la has subido, te llega un recordatorio. Requiere
  configuración (ver abajo).
- **Rol admin automático** para `quevedotroncoso@icloud.com`: al
  iniciar sesión con ese correo aparece la pestaña "Admin" (ver todos
  los grupos/perfiles, resetear rachas).

## Pasos que TÚ debes hacer (una sola vez)

### 1. Base de datos
Corre `migration_v2.sql` completo en el SQL Editor de Supabase (es
seguro, no borra nada existente).

### 2. Notificaciones push (para que lleguen de verdad a las 21:00)
Esto requiere 4 pasos porque una notificación push real necesita un
servidor que las dispare — no puede hacerlo solo el navegador:

1. **Genera tus llaves VAPID** (una sola vez):
   ```bash
   npx web-push generate-vapid-keys
   ```
   Te da una llave pública y una privada.
2. **Pega la llave pública** en `config.js`, en `VAPID_PUBLIC_KEY`.
3. **Despliega la Edge Function** `functions/send-reminders` en tu
   proyecto Supabase (`npx supabase functions deploy send-reminders`)
   y configura sus secretos:
   ```bash
   npx supabase secrets set VAPID_PUBLIC_KEY=tu_llave_publica
   npx supabase secrets set VAPID_PRIVATE_KEY=tu_llave_privada
   ```
4. **Agenda el cron** a las 21:00 hora de Chile: en el SQL Editor,
   corre el bloque `cron.schedule(...)` que está comentado al final de
   `migration_v2.sql`, reemplazando la URL de tu proyecto y tu
   `service_role key`. Ojo con el horario de verano/invierno en Chile
   (ajusta la hora UTC del cron dos veces al año, o usa un cron cada
   hora que internamente solo dispare cuando sea 21:00 en
   `America/Santiago` — la función `send-reminders` ya calcula la
   fecha en esa zona horaria).

Si prefieres, dime y puedo desplegar directamente estos cambios (tabla,
políticas y Edge Function) a tu proyecto Supabase ya conectado — solo
dime que sí.

### 3. Admin
No requiere nada extra: apenas `quevedotroncoso@icloud.com` inicia
sesión, la app le da el rol automáticamente.

## Archivos nuevos/cambiados
- `index.html`, `main.js`, `config.js` — reescritos con todo lo de arriba
- `migration_v2.sql` — nuevo (tablas, columnas, políticas RLS, realtime)
- `sw.js` — nuevo (service worker para push)
- `functions/send-reminders/index.ts` — nuevo (Edge Function del cron)

## Limitación conocida
El cron de las 21:00 corre en horario fijo (UTC), así que en Chile hay
que reajustarlo cuando cambia el horario de verano — está documentado
en `migration_v2.sql`.
