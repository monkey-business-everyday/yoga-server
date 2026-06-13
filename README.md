# yoga-server
# Evryday Evrywhr Yoga — Booking Server v2

## Local Setup
```bash
npm install
cp .env.example .env   # fill in credentials
npm run dev
```

## Deploy to Railway (free)

1. railway.app → New Project → Deploy from GitHub
2. Add PostgreSQL plugin (one click — DATABASE_URL auto-set)
3. Add env vars from .env.example
4. Railway gives you: https://your-app.railway.app

## Connect your domain later
1. Buy domain (Cloudflare recommended)
2. In Railway: Settings → Domains → Add custom domain
3. Point api.yourdomain.com → Railway
4. Point yourdomain.com → GitHub Pages

## API Reference

| Method | Endpoint              | Description                  |
|--------|-----------------------|------------------------------|
| GET    | /slots                | Available slots (next 4 wks) |
| POST   | /book                 | Create booking               |
| POST   | /cancel               | Cancel booking               |
| POST   | /admin/slots          | Add slot (admin key required)|
| DELETE | /admin/slots/:id      | Remove slot (admin)          |
| GET    | /admin/bookings       | All bookings (admin)         |
| GET    | /health               | Health check                 |

## Admin Dashboard
Visit https://your-app.railway.app/admin.html

## Update frontend fetch
```javascript
fetch('https://your-app.railway.app/book', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    slot_id:      slot.id,
    email:        email,
    whatsapp:     whatsapp,
    activity:     act.label.replace('\n', ' '),
    session_date: slot.date,
    session_time: slot.start_time
  })
});
```
