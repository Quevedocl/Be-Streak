// Credenciales de tu proyecto Supabase "BeStreak" (base de datos + storage)
const SUPABASE_URL = "https://qkjcccoghvchwygdyzvh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFramNjY29naHZjaHd5Z2R5enZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0NjMzNjUsImV4cCI6MjEwNjAzOTM2NX0.1oFKWJdtfvCLURz6Hry8jc8lutbPWsDwVwFbufqSyD8";

// Credenciales de tu app en Clerk (autenticación / login)
const CLERK_PUBLISHABLE_KEY = "pk_test_aW1tZW5zZS16ZWJyYS02MzM4LmNsZXJrLmFjY291bnRzLmRldiQ";

// Email al que se le da automáticamente el rol de administrador
// (panel Admin dentro de la app) apenas inicia sesión.
const ADMIN_EMAIL = "quevedotroncoso@icloud.com";

// Clave pública VAPID para notificaciones push (genera tu par de claves
// con `npx web-push generate-vapid-keys` y pega aquí la pública; la
// privada va como secreto de la Edge Function, nunca aquí).
const VAPID_PUBLIC_KEY = "PON_AQUI_TU_VAPID_PUBLIC_KEY";
