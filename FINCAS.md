# Envío de movimientos a fincas (31 de octubre de 2026)

Además de guardar el archivo de BCP en la hoja Income-Outcome, la extensión envía las mismas filas a
fincas (`record_bank_movements_v2`). La base no repite líneas y las cruza sola con los pagos de los
formularios, los pedidos de Apartalo y los retiros a caja. Lo que queda aparece en
`finance_bank_to_match`. Si fincas falla o no hay sesión, la hoja y la validación de pedidos siguen igual.

## Configuración (una vez)

1. Google Cloud, proyecto **apartalo-10146** → APIs y servicios → Credenciales → Crear credenciales →
   ID de cliente de OAuth → tipo **Extensión de Chrome** → ID del elemento: el ID que muestra
   `chrome://extensions` para esta extensión.
2. Copiar el ID de cliente (termina en `.apps.googleusercontent.com`) en `manifest.json`, en
   `oauth2.client_id`, y recargar la extensión.
3. En Supabase, proyecto **fincas** → Authentication → Third-party auth → Firebase activado con el
   proyecto `apartalo-10146`.
4. En la extensión → ⚙️ → **Iniciar sesión con Google** con una cuenta que sea miembro de Finca Rosal
   en Apartalo. "Finca en fincas (ID)" ya trae Finca Rosal.

## Qué guarda

- `fincas-config.js`: URL y clave pública de fincas, clave web de Firebase (públicas: sólo identifican
  el proyecto) y el ID de Finca Rosal.
- En el navegador (`chrome.storage.local`): el token de la sesión y el de renovación. Ninguna clave maestra.

Desde el 1 de noviembre de 2026 la app nunca pide el número de operación: al llegar el archivo del BCP, la base cruza cada pago por número de operación o, si no lo tiene, por mismo monto, dirección y fecha (±3 días, sólo si hay un único candidato), y copia el número de operación del banco al pago.
