# Skyrena Community Library

An independent, mobile-first lending portal for Hallmark Skyrena residents. Residents share their own physical books, request books from neighbours, manage handovers and returns, and use owner-controlled waiting lists.

This project is intentionally separate from temporary community event registrations.

## Live URL

After deployment: <https://skyrena-library.hallmarkskyrena.workers.dev/library>

The Worker root redirects to `/library`.

## Technology

- Cloudflare Workers
- Cloudflare D1
- TypeScript with server-rendered HTML, CSS and JavaScript
- Progressive Web App assets for Android and iPhone

## Setup

```bash
npm install
npm run db:migrate:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put LIBRARY_SESSION_SECRET
npm run deploy
```

Use the same `LIBRARY_SESSION_SECRET` as the previous combined Worker if existing resident sessions should remain valid after the URL changes. Cookies are origin-specific, so residents will still need to sign in once on the new domain.

## Main URLs

- `/library` — browse the catalogue
- `/library/join` — create a resident account
- `/library/login` — resident sign-in
- `/library/dashboard` — resident books, requests and loans
- `/library/admin` — administrator console

## Database

The production database is `skyrena-community-library`. The standalone schema is created by `migrations/0001_library.sql`.

The old events database must remain untouched until member, book, request, loan and audit counts have been checked on the new Worker.

## Scheduled maintenance

The cron trigger runs every six hours and releases accepted reservations that have passed their collection deadline. It never automatically chooses a waiting resident; the book owner makes that decision.
