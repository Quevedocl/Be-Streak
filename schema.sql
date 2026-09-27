-- ============================================================
-- BeStreak — esquema de base de datos para Supabase
-- Auth: Clerk (third-party auth). Datos/Storage: Supabase.
-- Pega esto completo en el SQL Editor de tu proyecto Supabase
-- ============================================================

-- 1) TABLAS -----------------------------------------------------
-- Nota: profiles.id y posts.user_id son TEXT porque guardan el ID
-- de usuario de Clerk (formato "user_xxxxx"), no un uuid.

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  punishment text not null,
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id text primary key, -- Clerk user id
  username text not null,
  group_id uuid not null references groups(id) on delete cascade,
  streak_count integer not null default 0,
  status text not null default 'active' check (status in ('active', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade, -- Clerk user id
  group_id uuid not null references groups(id) on delete cascade,
  image_url text not null,
  date date not null,
  created_at timestamptz not null default now(),
  unique (user_id, date) -- una sola foto por usuario por día
);

-- 2) ROW LEVEL SECURITY (basada en el JWT de Clerk) --------------

alter table groups enable row level security;
alter table profiles enable row level security;
alter table posts enable row level security;

create policy "groups: leer" on groups for select
  to authenticated using (true);

create policy "groups: crear" on groups for insert
  to authenticated with check (true);

create policy "profiles: leer propio y del grupo" on profiles for select
  to authenticated using (
    id = (select auth.jwt()->>'sub')
    or group_id in (select group_id from profiles where id = (select auth.jwt()->>'sub'))
  );

create policy "profiles: crear propio" on profiles for insert
  to authenticated with check (id = (select auth.jwt()->>'sub'));

create policy "profiles: actualizar propio" on profiles for update
  to authenticated using (id = (select auth.jwt()->>'sub'));

create policy "posts: leer del grupo" on posts for select
  to authenticated using (
    group_id in (select group_id from profiles where id = (select auth.jwt()->>'sub'))
  );

create policy "posts: crear propio" on posts for insert
  to authenticated with check (user_id = (select auth.jwt()->>'sub'));

-- 3) STORAGE -------------------------------------------------------
-- Crea manualmente un bucket PÚBLICO llamado "daily-snaps" desde
-- Storage → New bucket (marca "Public bucket"). Luego corre esto:

create policy "daily-snaps: lectura publica"
  on storage.objects for select
  using (bucket_id = 'daily-snaps');

create policy "daily-snaps: solo subir a tu propia carpeta"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'daily-snaps'
    and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
  );

create policy "daily-snaps: solo reemplazar tu propia foto"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'daily-snaps'
    and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
  );

-- 4) AUTH DE TERCEROS ----------------------------------------------
-- Además de este script, en el dashboard de Supabase debes:
--   Authentication → Sign In / Providers → Third Party Auth → Add
--   provider → Clerk → pegar tu dominio de Clerk.
-- Y en Clerk: dashboard.clerk.com/setup/supabase para conectar tu
-- instancia de Clerk con este proyecto de Supabase.
