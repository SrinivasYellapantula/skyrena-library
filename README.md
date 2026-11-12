# Skyrena Community Library

A mobile-first lending portal for Hallmark Skyrena residents. The library has no central stock: residents share physical books they own, other residents request them, and the portal tracks reservations, handovers, loans, returns and waiting lists.

This is an independent application, Worker and database. It is not coupled to temporary community-event registrations.

## Live Portal

- Resident portal: <https://skyrena-library.hallmarkskyrena.workers.dev/library>
- Administrator portal: <https://skyrena-library.hallmarkskyrena.workers.dev/library/admin>

The Worker root redirects to `/library`.

## Implemented Requirements

### Membership and access

- Residents create individual accounts using name, block, flat number, mobile number and a 4–6 digit PIN.
- Mobile number is the login ID.
- Multiple residents from the same flat can have separate accounts.
- PINs are stored as secure hashes, never as readable text.
- A library administrator verifies each account before library actions become available.
- Pending residents see only their approval status; they cannot add or request books.
- Suspended residents lose access and their available books are temporarily hidden.
- Signed sessions last for up to 30 days.
- The navigation adapts for visitors, pending residents, approved residents and administrators.

### Adding and maintaining books

- A resident can add several books in one submission.
- Residents can return later and add more books.
- Online suggestions appear after four characters of an ISBN, title or author.
- Google Books public search is used first, with Open Library as the free fallback.
- No paid Google Books key or billing account is required.
- Results are restricted to English, Hindi and Telugu.
- Duplicate suggestions are combined so residents do not see the same edition repeatedly.
- Suggestions show useful edition details instead of requiring residents to compare ISBNs alone.
- Selecting a result fills title, author, ISBN, language, genre and cover image.
- Residents can correct the suggested information before saving.
- Language is limited to English, Hindi and Telugu.
- Genres are normalised into clear catalogue choices such as Fiction, Romance, Historical, Regency, and Suspense & Thriller.
- Every physical copy records its owner, condition and optional notes.
- Multiple owners can contribute different copies of the same title.
- Owners can pause a book, make it available again, or remove it from their shelf.
- A reserved or borrowed copy cannot be removed accidentally.
- After adding books, the owner receives a one-tap WhatsApp announcement containing a direct link to the new book.

### Browsing and discovery

- Residents can search by title, author or ISBN.
- Catalogue filters cover genre and availability.
- Filters apply automatically without a separate Apply button.
- Results can be sorted by recently added, title or author.
- Desktop supports grid and table views.
- Mobile always uses compact cards and avoids horizontal scrolling.
- Cards show cover, title, author, genre, language, availability, copy count and owner as `Name Block-Flat`.
- Pagination limits the catalogue to 24 titles per page.
- A signed-in resident does not see their own copies in Browse Books.
- A resident also does not see a title they currently have on loan.

### Requests and owner approval

- An approved resident can request an available book.
- A resident cannot keep multiple active requests for the same title.
- A resident can have a maximum of two active loans.
- Requesting a book keeps the resident on the catalogue page and shows confirmation instead of unexpectedly redirecting.
- The owner can approve or decline a request.
- The requester can cancel an open request.
- When no copy is available, residents can join the waiting list.
- More than one resident can wait for the same title.
- Waiting residents cannot see other residents’ names or contact details.
- The owner sees interested residents and has the final choice.
- The owner may select any interested resident; selection is not forced to follow request order.
- Returning or resuming a book makes it available but does not automatically assign it to the first person waiting.

### Reservations, loans and returns

- Owner approval reserves the physical copy for 48 hours.
- The collection deadline is visible to both owner and reader.
- The owner can extend the reservation once by another 24 hours.
- A scheduled job runs every six hours and releases expired reservations.
- Expiry processing is limited to 50 records per run to protect free-tier usage.
- A loan begins only when the owner confirms **Book handed over**.
- The normal loan period is 14 days.
- The borrower sees the due date and owner contact details.
- The owner sees the current borrower and due date.
- The owner confirms the return, after which the copy becomes available again.
- Completed request records disappear from active resident views after the borrow-return cycle.
- Audit records remain for accountability.

### Resident dashboard

The **My Library** screen separates work into focused tabs:

- **Borrowed Books** — books currently with the resident, due dates and return reminders
- **Books I Requested** — pending, waiting, reserved, declined or cancelled requests
- **Requests for My Books** — approval, decline, handover and waiting-reader selection
- **Books I’m Sharing** — availability, pause, resume, return confirmation and removal
- **Add Books** — add one or more new physical books

Only one section is shown at a time on mobile to avoid an overwhelming screen.

### WhatsApp assistance

- Notifications use one-tap prepared WhatsApp messages, with no paid WhatsApp Business API.
- A requester can notify the owner after requesting a book.
- An owner can notify a selected reader that a book is ready for collection.
- A borrower can contact the owner about returning a book.
- A borrower can open a personal WhatsApp return reminder.
- An owner can share a newly added book with the community group using its direct catalogue link.
- Administrators have a reminder queue for books due soon, due today or overdue.
- Administrators can record that a reminder was sent.
- Messages are deliberately user-initiated; the application cannot silently post to a WhatsApp group or automatically message residents without WhatsApp API approval and cost.

### Administration and accountability

- Administrator access is protected by a Cloudflare secret.
- Administrators can approve or suspend member accounts.
- Administrators can review current loans, due dates, overdue books, open requests and waiting lists.
- The reminder queue shows reminder history.
- Membership, catalogue, request, reservation, loan, return, reminder and shelf-removal actions are audited.
- Production exports, secrets and personal-data backups are excluded from Git.

### Mobile application

- The portal is installable as a Progressive Web App on Android and iPhone.
- It includes app icons, a web manifest, an install prompt, service worker and offline fallback page.
- Sign in and Join Library remain visible in the mobile header.
- Catalogue statistics are compact on mobile so books and search appear quickly.
- Filters open in a mobile-friendly panel.
- Dashboard tabs wrap without horizontal scrolling.

### Cloudflare free-tier safeguards

- Catalogue data is paginated and query results are bounded.
- Database indexes cover member, copy, request, loan and reservation lookups.
- Catalogue statistics are maintained incrementally instead of repeatedly scanning all rows.
- External metadata results are cached for 24 hours.
- Search waits until four characters and uses a short debounce to avoid a request per keystroke.
- Scheduled expiry cleanup processes a maximum of 50 reservations per run.
- Completed requests are removed from active operational views while compact audit history is retained.
- The application uses a single Worker request for each normal page or action and has no polling loop.

## Resident-Facing Statuses

| Status | Meaning |
|---|---|
| Available | The copy can be requested |
| Requested | A resident has requested it and the owner must respond |
| Waiting list | No copy is currently available |
| Reserved | The owner selected a reader; collection is pending |
| Borrowed | Handover is confirmed and the 14-day loan is active |
| Overdue | The active loan is past its due date |
| Paused | The owner has temporarily hidden the copy |
| Returned | The owner confirmed that the book came back |

Declined and cancelled requests remain visible only where needed to explain the outcome; they do not block future borrowing.

## Technology

| Layer | Technology |
|---|---|
| Runtime and hosting | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Application | TypeScript with server-rendered HTML, CSS and JavaScript |
| Metadata | Google Books public search and Open Library fallback |
| Mobile installation | Progressive Web App |
| Deployment | Wrangler |

There is no separate frontend framework or application server.

## Project Structure

```text
skyrena-library/
├── migrations/          # Standalone library database schema
├── public/library/      # PWA icons, manifest, service worker and offline page
├── src/index.ts         # Worker entry point and scheduled handler
├── src/library.ts       # Pages, workflows and APIs
├── package.json
└── wrangler.jsonc
```

## Local Setup

```bash
npm install
npx wrangler d1 migrations apply skyrena-community-library --local --config wrangler.jsonc
npm run dev
```

For local secrets, use an untracked `.dev.vars` file.

## Production Setup

```bash
npm install
npx wrangler login
npm run db:migrate:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put LIBRARY_SESSION_SECRET
npm run deploy
```

- The administrator username is `admin`.
- Use a long random value for `LIBRARY_SESSION_SECRET`.
- Never commit passwords, session secrets, exports or production data.

## Main Routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/library` | Browse and search |
| `GET/POST` | `/library/join` | Create a resident account |
| `GET/POST` | `/library/login` | Resident sign-in |
| `GET` | `/library/dashboard` | Resident loans, requests and shelf |
| `GET` | `/library/admin` | Administrator console |
| `GET` | `/api/library/metadata` | Cached online book search |
| `POST` | `/api/library/books` | Add physical books |
| `POST` | `/api/library/requests` | Request a title or join its waiting list |
| `POST` | `/api/library/requests/:id/action` | Approve, decline, cancel, extend, select or hand over |
| `POST` | `/api/library/copies/:id/action` | Pause, resume, return or remove a copy |

## Database and Scheduled Maintenance

The production D1 database is `skyrena-community-library`. The complete standalone schema is in `migrations/0001_library.sql`.

The cron trigger runs every six hours and releases approved reservations that passed their collection deadline. It never assigns the next reader automatically; the book owner always decides.

The previous events database is retained temporarily as rollback protection. The standalone Worker reads and writes only the new library database.

## Common Commands

```bash
npm run dev
npm run db:migrate:remote
npm run deploy
npx wrangler whoami
```
