-- ============================================================
-- BeStreak — MIGRACIÓN v2 (mejoras)
-- Pega esto completo en el SQL Editor de Supabase.
-- Es seguro correrlo sobre tu base de datos existente (usa
-- IF NOT EXISTS / OR REPLACE en todo).
-- ============================================================

-- 1) COLUMNAS NUEVAS ------------------------------------------------

alter table groups
  add column if not exists group_streak_count integer not null default 0,
  add column if not exists last_perfect_date date;

alter table profiles
  add column if not exists is_admin boolean not null default false,
  add column if not exists best_streak integer not null default 0,
  add column if not exists freezes_available integer not null default 2,
  add column if not exists last_freeze_reset_month text, -- 'YYYY-MM'
  add column if not exists theme text not null default 'mono',
  add column if not exists last_seen_chat_at timestamptz;

alter table posts
  add column if not exists caption text,
  add column if not exists is_late boolean not null default false,
  add column if not exists used_freeze boolean not null default false;

-- 2) FUNCIÓN AUXILIAR: ¿el usuario actual es admin? -----------------

create or replace function is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (select is_admin from profiles where id = (select auth.jwt()->>'sub')),
    false
  );
$$;

-- 3) TABLAS NUEVAS ---------------------------------------------------

create table if not exists post_reactions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (post_id, user_id) -- una reacción activa por persona por foto
);

create table if not exists post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);

create table if not exists punishment_log (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  broken_date date not null,
  punishment_text text not null,
  evidence_url text,
  fulfilled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

-- 4) ROW LEVEL SECURITY ------------------------------------------------

alter table post_reactions enable row level security;
alter table post_comments enable row level security;
alter table punishment_log enable row level security;
alter table group_messages enable row level security;
alter table push_subscriptions enable row level security;

-- reacciones: ver/crear/editar/borrar las de tu grupo, siempre que
-- la fila sea tuya para escribir
create policy "reactions: leer del grupo" on post_reactions for select
  to authenticated using (
    post_id in (select id from posts where group_id in
      (select group_id from profiles where id = (select auth.jwt()->>'sub')))
  );
create policy "reactions: crear propia" on post_reactions for insert
  to authenticated with check (user_id = (select auth.jwt()->>'sub'));
create policy "reactions: actualizar propia" on post_reactions for update
  to authenticated using (user_id = (select auth.jwt()->>'sub'));
create policy "reactions: borrar propia" on post_reactions for delete
  to authenticated using (user_id = (select auth.jwt()->>'sub'));

-- comentarios
create policy "comments: leer del grupo" on post_comments for select
  to authenticated using (
    post_id in (select id from posts where group_id in
      (select group_id from profiles where id = (select auth.jwt()->>'sub')))
  );
create policy "comments: crear propio" on post_comments for insert
  to authenticated with check (user_id = (select auth.jwt()->>'sub'));
create policy "comments: borrar propio" on post_comments for delete
  to authenticated using (user_id = (select auth.jwt()->>'sub'));

-- muro de castigos
create policy "punishments: leer del grupo" on punishment_log for select
  to authenticated using (
    group_id in (select group_id from profiles where id = (select auth.jwt()->>'sub'))
  );
create policy "punishments: crear del sistema (propio)" on punishment_log for insert
  to authenticated with check (
    group_id in (select group_id from profiles where id = (select auth.jwt()->>'sub'))
  );
create policy "punishments: marcar cumplido (propio)" on punishment_log for update
  to authenticated using (user_id = (select auth.jwt()->>'sub'));

-- chat de grupo
create policy "chat: leer del grupo" on group_messages for select
  to authenticated using (
    group_id in (select group_id from profiles where id = (select auth.jwt()->>'sub'))
  );
create policy "chat: escribir en mi grupo" on group_messages for insert
  to authenticated with check (
    user_id = (select auth.jwt()->>'sub')
    and group_id in (select group_id from profiles where id = (select auth.jwt()->>'sub'))
  );

-- suscripciones push: cada quien ve/administra solo la suya
create policy "push: leer propia" on push_subscriptions for select
  to authenticated using (user_id = (select auth.jwt()->>'sub'));
create policy "push: crear propia" on push_subscriptions for insert
  to authenticated with check (user_id = (select auth.jwt()->>'sub'));
create policy "push: borrar propia" on push_subscriptions for delete
  to authenticated using (user_id = (select auth.jwt()->>'sub'));

-- 5) ACCESO TOTAL PARA ADMIN (además de las políticas de siempre) -----

create policy "admin: todo en groups" on groups for all
  to authenticated using (is_admin()) with check (is_admin());
create policy "admin: todo en profiles" on profiles for all
  to authenticated using (is_admin()) with check (is_admin());
create policy "admin: todo en posts" on posts for all
  to authenticated using (is_admin()) with check (is_admin());
create policy "admin: todo en punishment_log" on punishment_log for all
  to authenticated using (is_admin()) with check (is_admin());
create policy "admin: todo en group_messages" on group_messages for all
  to authenticated using (is_admin()) with check (is_admin());

-- 6) REALTIME para el chat de grupo ------------------------------------
-- (Habilita replicación en tiempo real para que los mensajes lleguen
--  sin recargar. Si ya existe la publicación, esto no falla.)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'group_messages'
  ) then
    alter publication supabase_realtime add table group_messages;
  end if;
end $$;

-- 7) HABILITAR EXTENSIONES PARA EL CRON DE NOTIFICACIONES --------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- El cron real (que llama a la Edge Function todos los días a las
-- 21:00 hora de Chile) se agrega en un paso aparte, una vez que
-- despliegues la función `send-reminders` — mira functions/README.md.
-- Ejemplo (ajusta la URL y el bearer token del proyecto):
--
-- select cron.schedule(
--   'bestreak-recordatorio-21h',
--   '0 0 * * *', -- 00:00 UTC = 21:00 Chile en horario de invierno (UTC-3)
--                -- usa '0 1 * * *' en horario de verano (UTC-4 → 21:00)
--   $$
--   select net.http_post(
--     url := 'https://<TU-PROYECTO>.supabase.co/functions/v1/send-reminders',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <TU-SERVICE-ROLE-KEY>'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
