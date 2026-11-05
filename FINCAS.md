# Envío de movimientos a fincas (31 de octubre de 2026; sólo fincas desde el 5 de noviembre de 2026)

La extensión guarda cada línea del archivo de BCP sólo en fincas, la base oficial
(`record_bank_movements_v2`); ya no escribe en la hoja Income-Outcome (General Manager, 5 nov 2026).
La base no repite líneas y las cruza sola con los pagos de la app, los pedidos de Apartalo y los retiros
a caja. En la app, Finanzas → Movimientos muestra cada línea con su estado: Conciliado, Falta en la app o
No está en el banco. Sin sesión de fincas el archivo no se procesa: la extensión pide iniciar sesión.

Desde el 5 de noviembre de 2026 (General Manager: la validación se hace en la app; sin campos que no hacen
falta) la extensión **sólo guarda**: ya no busca pedidos, no lee comprobantes (OCR), no verifica pagos ni
muestra coincidencias, y no tiene ⚙️. Arriba está la sesión (Iniciar sesión con Google / Salir); debajo, el
archivo. La finca es siempre Finca Rosal (`FINCAS.defaultFarmId`). Cada línea se concilia en la app, en
Finanzas → Movimientos: al conciliar un pedido, la app marca su comprobante como verificado.

## Configuración (una vez)

1. Google Cloud, proyecto **apartalo-10146** → APIs y servicios → Credenciales → Crear credenciales →
   ID de cliente de OAuth → tipo **Extensión de Chrome** → ID del elemento: el ID que muestra
   `chrome://extensions` para esta extensión.
2. Copiar el ID de cliente (termina en `.apps.googleusercontent.com`) en `manifest.json`, en
   `oauth2.client_id`, y recargar la extensión.
3. En Supabase, proyecto **fincas** → Authentication → Third-party auth → Firebase activado con el
   proyecto `apartalo-10146`.
4. En la extensión → **Iniciar sesión con Google** con una cuenta que sea dueña de Finca Rosal en Apartalo.

## Qué guarda

- `fincas-config.js`: URL y clave pública de fincas, clave web de Firebase (públicas: sólo identifican
  el proyecto) y el ID de Finca Rosal.
- En el navegador (`chrome.storage.local`): el token de la sesión y el de renovación. Ninguna clave maestra.

Desde el 1 de noviembre de 2026 la app nunca pide el número de operación: al llegar el archivo del BCP, la base cruza cada pago por número de operación o, si no lo tiene, por mismo monto, dirección y fecha (±3 días, sólo si hay un único candidato), y copia el número de operación del banco al pago.
