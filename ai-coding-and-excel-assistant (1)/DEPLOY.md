# Deploying AI Code Studio

The app is a standard Next.js 16 project with one external requirement: a PostgreSQL database.

## Requirements

- Node.js **20.9 or newer** (Next.js 16 does not run on Node 18).
- A PostgreSQL database. Free tiers that work: Neon, Supabase, Railway, Render.
- One environment variable on the host: `DATABASE_URL`.

The tables are created automatically the first time the app touches the database, so no
migration step is needed. SSL is switched on automatically for any non-local database host.

## Vercel

1. Push the repository to GitHub/GitLab (make sure `.env` is **not** committed; `.gitignore` handles it).
2. In Vercel: **Add New → Project**, import the repo. Framework is detected as Next.js.
3. Under **Environment Variables**, add `DATABASE_URL` with your database connection string.
4. Deploy. Check `https://<your-app>.vercel.app/api/health`; it should return `{"ok":true,"database":"connected"}`.

If you use Vercel Postgres / Neon integration, the variable it creates is usually named
`POSTGRES_URL`. Either rename it to `DATABASE_URL` or add `DATABASE_URL` with the same value.

## Render / Railway / Fly / any Node host

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment: `DATABASE_URL=postgresql://...`, `NODE_ENV=production`
- Health check path: `/api/health`

## Docker (optional)

```Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
```

Run with `docker run -p 3000:3000 -e DATABASE_URL=postgresql://... image-name`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails: `DATABASE_URL is required` | Older version of `src/db/index.ts` connected at import time | Fixed: the connection is now lazy; the build no longer needs the database. |
| `/api/health` returns `"database":"missing"` | `DATABASE_URL` not set on the host | Add it in the provider's environment settings and redeploy. |
| `self signed certificate` / `SSL required` | Hosted databases need SSL | Automatic for non-local hosts. Force with `DATABASE_SSL=true`. |
| `relation "projects" does not exist` | Tables missing | Created automatically on first request. To create manually: `npx drizzle-kit push`. |
| `ECONNREFUSED 127.0.0.1:5432` | `DATABASE_URL` still points to localhost | Use the hosted database's connection string. |
| `Unsupported engine` / syntax errors at build | Node older than 20.9 | Set the Node version to 20 or 22 in the host settings (Vercel: Project → Settings → Node.js Version). |

## VS Code extension

The `vscode-extension/` folder is not part of the web deployment. After deploying, set
`aiStudio.serverUrl` in VS Code to your public URL (for example `https://your-app.vercel.app`).
