# Bandeja WhatsApp (app aparte de Innar)

Sistema Node **independiente** para:
- atender el WhatsApp de Twilio (bandeja),
- leer **Google Calendar** de las doctoras,
- enviar recordatorios (plantilla Twilio) y dejarlos en el chat.

No forma parte del menú de Innar; se despliega en un **subdominio**.

## URL sugerida

`https://wa.neurocienciasnarino.com`

Webhook Twilio:

`https://wa.neurocienciasnarino.com/api/webhook`

## Flujo calendario → chat

1. En la bandeja eligen fecha → **Cargar eventos** (lee Google Calendar).
2. **Enviar recordatorios** → plantilla Twilio a cada paciente con teléfono en el título del evento.
3. Cada envío crea/actualiza la conversación en la bandeja (queda como mensaje saliente).
4. Si el paciente responde Sí/No o texto → entra por el webhook y se ve en el mismo chat.
5. Sí/No también se reenvía a Apps Script (`GAS_WEBHOOK_URL`) si quieren seguir llenando el Sheet.

## Google Calendar (obligatorio para cargar/enviar)

1. [Google Cloud Console](https://console.cloud.google.com) → proyecto → habilitar **Google Calendar API**.
2. Crear **cuenta de servicio** → descargar JSON.
3. En Hostinger / `.env`:
   - `GOOGLE_CLIENT_EMAIL` = `client_email` del JSON
   - `GOOGLE_PRIVATE_KEY` = `private_key` del JSON (con `\n`)
4. En cada calendario de Google (Angela, Karen, Adriana, Valentina):
   **Compartir** con ese `client_email` → permiso **Hacer cambios en los eventos**
   (hace falta “cambios” para crear citas desde la web; “ver” solo alcanza para listar).
5. `TWILIO_CONTENT_SID` = plantilla Approved (variables 1–5 como en el Script).

Sin compartir los calendarios, la API devolverá error de acceso.

## Hostinger

1. Subdominio `wa.neurocienciasnarino.com` + Node.js App desde GitHub (`innar-wa-inbox`).
2. Startup: `server.js` · npm · root `./`.
3. Variables: ver `.env.example` (Twilio + MySQL + login + Google + ContentSid).
4. Reiniciar app.
5. Messaging Service → webhook `https://wa.neurocienciasnarino.com/api/webhook`.

## Apps Script

Pueden **dejar de enviar** desde Sheets (para no duplicar). El Sheet puede seguir solo como respaldo de confirmaciones vía `GAS_WEBHOOK_URL`.

## Local

```bash
cd innar-wa-inbox
cp .env.example .env
npm install
npm start
```
