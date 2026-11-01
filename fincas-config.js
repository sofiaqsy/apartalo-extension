// Conexión con fincas (base de datos de operaciones en Supabase) — 31 octubre 2026.
// Son claves públicas: identifican el proyecto, no dan acceso. El acceso lo decide el login de
// Firebase (Apartalo) y las reglas de la base: sólo los miembros de la finca pueden guardar.
const FINCAS = {
  supabaseUrl: 'https://nrapvmbzovoimzepvinq.supabase.co',
  supabaseKey: 'sb_publishable_oqVVUMERHDsLjKfS_XnBDA_Pt_D3wPT',
  firebaseApiKey: 'AIzaSyC0SY-w9QCzEQSl7ffINUnH2FTtnVNPX2g', // proyecto Firebase apartalo-10146 (el mismo login de Apartalo)
  defaultFarmId: 'c1d391b2-31d0-4eb4-a3e5-6986490e4dd3', // Finca Rosal
};
