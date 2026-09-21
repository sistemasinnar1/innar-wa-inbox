# Bandeja WhatsApp (app aparte de Innar)

Sistema Node **independiente** para atender el WhatsApp de Twilio.  
No forma parte del menú de Innar; se despliega solo en un **subdominio**.

## URL sugerida

`https://wa.neurocienciasnarino.com`

Webhook Twilio:

`https://wa.neurocienciasnarino.com/api/webhook`

## Hostinger (pasos)

1. En DNS del dominio `neurocienciasnarino.com`, cree un subdominio `wa` (o el nombre que elijan) apuntando al hosting.
2. hPanel → **Advanced → Node.js** → **Create application**:
   - Application root: carpeta donde suban **solo** `wa-inbox/` (este directorio)
   - Application URL: el subdominio `wa.neurocienciasnarino.com`
   - Startup file: `server.js`
   - Node 18+
3. Suban **únicamente** el contenido de `wa-inbox/` (no hace falta subir Innar completo).
4. En el servidor: `npm install`
5. Variables de entorno (panel o `.env`): copie desde `.env.example`
   - `WA_USER` / `WA_PASSWORD` (login fijo)
   - Twilio + `GAS_WEBHOOK_URL` + MySQL
   - `FRONTEND_URL` y `TWILIO_WEBHOOK_URL` con el subdominio HTTPS
6. Reinicien la Node App.
7. Twilio → Messaging Service **Innar** → Incoming webhook →  
   `https://wa.neurocienciasnarino.com/api/webhook` (HTTP POST).
8. Abran `https://wa.neurocienciasnarino.com/login` con el usuario/clave del `.env`.

## Local (prueba)

```bash
cd wa-inbox
cp .env.example .env
# editar .env
npm install
npm start
```

Abra `http://localhost:7090/login`.

## Qué sube / qué no

| Subir a Hostinger (esta app) | Queda en local / Innar |
|------------------------------|-------------------------|
| Carpeta `wa-inbox/` completa | Agenda, recibos, XAMPP Innar |
| Variables Twilio en **esta** app | No hace falta menú WhatsApp en Innar |

Los recordatorios de citas siguen saliendo desde **Apps Script + Sheet**. Esta app solo recibe respuestas y chat libre.
