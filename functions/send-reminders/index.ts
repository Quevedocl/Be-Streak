// Supabase Edge Function: send-reminders
// Se ejecuta una vez al día (vía pg_cron, ver migration_v2.sql) a las
// 21:00 hora de Chile. Busca a todos los perfiles cuyo usuario todavía
// NO subió su foto de hoy, y les manda una notificación push. A quien
// ya subió, no le llega nada.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails(
  "mailto:soporte@bestreak.app",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

function todayStr() {
  // Fecha de hoy en horario de Chile (America/Santiago)
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const date = todayStr();

  // 1) Todos los perfiles con al menos una suscripción push
  const { data: profiles, error: profErr } = await sb
    .from("profiles")
    .select("id, username, push_subscriptions(endpoint, p256dh, auth)");

  if (profErr) {
    return new Response(JSON.stringify({ error: profErr.message }), { status: 500 });
  }

  // 2) Quiénes ya subieron foto hoy
  const { data: postedToday } = await sb.from("posts").select("user_id").eq("date", date);
  const postedSet = new Set((postedToday || []).map((p) => p.user_id));

  let sent = 0, skipped = 0, failed = 0;

  for (const profile of profiles || []) {
    if (postedSet.has(profile.id)) { skipped++; continue; } // ya subió → no molestar
    const subs = profile.push_subscriptions || [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({
            title: "🔥 BeStreak",
            body: `${profile.username}, aún no subes tu foto de hoy. ¡No rompas la racha!`,
            url: "/"
          })
        );
        sent++;
      } catch (err) {
        failed++;
        // Si la suscripción ya no es válida (410/404), la limpiamos.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        }
      }
    }
  }

  return new Response(JSON.stringify({ date, sent, skipped, failed }), {
    headers: { "Content-Type": "application/json" }
  });
});
