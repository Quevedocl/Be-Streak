-- ============================================================
-- BeStreak — MIGRACIÓN v3 (perfil editable: bio + avatar)
-- Pega esto en el SQL Editor de Supabase. Es seguro correrlo
-- sobre tu base de datos existente.
-- ============================================================

alter table profiles
  add column if not exists bio text,
  add column if not exists avatar_url text;

-- El bucket "daily-snaps" ya permite subir/actualizar archivos dentro
-- de tu propia carpeta (storage.foldername = tu user id), así que la
-- foto de perfil se guarda como "<tu_user_id>/avatar.webp" usando las
-- mismas policies que ya tienes — no se necesita nada más aquí.
