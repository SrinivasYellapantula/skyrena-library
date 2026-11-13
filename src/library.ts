export interface LibraryEnv {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  LIBRARY_SESSION_SECRET?: string;
}

type Member = {
  id: string; display_name: string; block_no: string; flat_no: string;
  mobile_number: string; status: string;
};

const LOAN_DAYS = 14;
const RESERVATION_HOURS = 48;
const RESERVATION_EXTENSION_HOURS = 24;
const CATALOGUE_PAGE_SIZE = 24;
const PIN_HASH_ITERATIONS = 100000; // Cloudflare Workers production maximum for PBKDF2.
const ONLINE_SEARCH_LANGUAGES = new Set(["English", "Hindi", "Telugu"]);
const CATALOGUE_GENRES = ["Fiction", "Romance", "Historical", "Regency", "Suspense & Thriller"] as const;
const enc = new TextEncoder();
const clean = (value: unknown, max = 160) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const formValue = (form: FormData, key: string, max = 160) => clean(form.get(key), max);
const id = () => crypto.randomUUID();

function base64url(bytes: Uint8Array) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function pinHash(pin: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PIN_HASH_ITERATIONS }, material, 256);
  return base64url(new Uint8Array(bits));
}

function secureEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

async function signingKey(env: LibraryEnv) {
  const secret = env.LIBRARY_SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!secret) throw new Error("Library authentication is not configured.");
  return crypto.subtle.importKey("raw", enc.encode(`skyrena-library:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sessionToken(memberId: string, env: LibraryEnv) {
  const payload = base64url(enc.encode(JSON.stringify({ memberId, expires: Date.now() + 30 * 86400000 })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

async function sessionMember(request: Request, env: LibraryEnv): Promise<Member | null> {
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)skyrena_library=([^;]+)/)?.[1];
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await signingKey(env), fromBase64url(signature), enc.encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { memberId?: string; expires?: number };
    if (!parsed.memberId || !parsed.expires || parsed.expires < Date.now()) return null;
    return await env.DB.prepare("SELECT id,display_name,block_no,flat_no,mobile_number,status FROM library_members WHERE id=?").bind(parsed.memberId).first<Member>();
  } catch { return null; }
}

function flatFor(blockValue: unknown, flatValue: unknown) {
  const block = clean(blockValue, 1).toUpperCase();
  let flat = clean(flatValue, 12).toUpperCase().replace(/[\s-]/g, "");
  if (/^[A-E]/.test(flat)) {
    if (flat[0] !== block) throw new Error("The block letter in the flat number does not match the selected block.");
    flat = flat.slice(1);
  }
  if (!/^(G\d{1,3}|\d{2,4})$/.test(flat)) throw new Error("Enter a valid flat number.");
  return flat;
}

function isAdmin(request: Request, env: LibraryEnv) {
  if (!env.ADMIN_PASSWORD) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const [username, password] = atob(header.slice(6)).split(":", 2);
    return username === "admin" && password === env.ADMIN_PASSWORD;
  } catch { return false; }
}

const formatDate = (value: unknown, withTime = false) => {
  const raw = String(value ?? "");
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(date);
};

function loanTiming(value: unknown) {
  const raw = String(value ?? "");
  const due = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  const dayNumber = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value || 0);
    return Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000;
  };
  const days = dayNumber(due) - dayNumber(new Date());
  if (days < 0) return { key: "overdue", label: "Overdue", days };
  if (days === 0) return { key: "today", label: "Due today", days };
  if (days <= 2) return { key: "soon", label: `Due in ${days} ${days === 1 ? "day" : "days"}`, days };
  return { key: "upcoming", label: "Upcoming", days };
}

function languageName(value: unknown) {
  const raw = clean(value, 30).toLowerCase();
  const languages: Record<string, string> = {
    en: "English", eng: "English", english: "English",
    te: "Telugu", tel: "Telugu", telugu: "Telugu",
    hi: "Hindi", hin: "Hindi", hindi: "Hindi",
    ta: "Tamil", tam: "Tamil", tamil: "Tamil",
    kn: "Kannada", kan: "Kannada", kannada: "Kannada",
    ml: "Malayalam", mal: "Malayalam", malayalam: "Malayalam",
    bn: "Bengali", ben: "Bengali", bengali: "Bengali",
    mr: "Marathi", mar: "Marathi", marathi: "Marathi",
    sa: "Sanskrit", san: "Sanskrit", sanskrit: "Sanskrit",
    gu: "Gujarati", guj: "Gujarati", gujarati: "Gujarati",
    ur: "Urdu", urd: "Urdu", urdu: "Urdu",
    de: "German", deu: "German", ger: "German", german: "German",
    fr: "French", fra: "French", fre: "French", french: "French",
    es: "Spanish", spa: "Spanish", spanish: "Spanish",
    ja: "Japanese", jpn: "Japanese", japanese: "Japanese",
    zh: "Chinese", zho: "Chinese", chi: "Chinese", chinese: "Chinese"
  };
  return languages[raw] || (raw.length > 3 ? raw.replace(/\b\w/g, letter => letter.toUpperCase()) : "Other");
}

type BookMetadata = { title: string; author: string; genre: string; language: string; isbn: string; cover: string };

function uniqueMetadata(items: BookMetadata[]) {
  const results = new Map<string, BookMetadata>();
  const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[.,:;!?"'()[\]{}_–—-]+/g, " ").replace(/\s+/g, " ").trim();
  const score = (item: BookMetadata) => Number(Boolean(item.cover)) * 4 + Number(Boolean(item.isbn)) * 3 + Number(Boolean(item.genre)) * 2;
  for (const item of items) {
    const key = `${normalized(item.title)}|${normalized(item.author)}|${item.language}`;
    const existing = results.get(key);
    if (!existing || score(item) > score(existing)) results.set(key, item);
  }
  return [...results.values()].slice(0, 8);
}

function page(title: string, body: string, member?: Member | null, script = "", adminView = false) {
  const navLinks = adminView
    ? `<span class="nav-status">Administrator</span>`
    : member?.status === "active"
    ? `<a class="mobile-main-link" href="/library">Browse</a><a class="mobile-main-link" href="/library/dashboard">My Library</a><a class="button compact" href="/library/logout">Sign out</a>`
    : member
      ? `<span class="nav-status">${member.status === "pending" ? "Approval pending" : "Account unavailable"}</span><a class="button compact" href="/library/logout">Sign out</a>`
      : `<a class="mobile-auth-link" href="/library/login">Sign in</a><a class="button compact" href="/library/join">Join library</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#214b3e"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Skyrena Library"><link rel="manifest" href="/library/manifest.webmanifest"><link rel="apple-touch-icon" href="/library/apple-touch-icon.png"><title>${esc(title)} · Skyrena Library</title><style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap');
  :root{--ink:#1d2924;--muted:#66736d;--green:#315b4a;--green2:#477b65;--cream:#f7f3e9;--paper:#fffdf8;--line:#d8d4c9;--gold:#c39138;--red:#a63a32;--shadow:0 14px 35px #1d292415}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}a{color:inherit}.nav{position:sticky;top:0;z-index:20;background:#fffdf8ed;backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}.nav-inner{max-width:1180px;margin:auto;padding:13px 22px;display:flex;align-items:center;gap:18px}.brand{font-family:Georgia,serif;font-size:1.25rem;font-weight:800;color:var(--green);text-decoration:none}.nav-links{margin-left:auto;display:flex;gap:15px;align-items:center}.nav-links a{text-decoration:none;font-weight:700;font-size:.92rem}.button,.button-secondary,.button-danger{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;padding:11px 16px;font:inherit;font-weight:800;cursor:pointer;text-decoration:none}.button{background:var(--green);color:white}.button:hover{background:var(--green2)}.button-secondary{background:white;border:1px solid var(--line);color:var(--ink)}.button-danger{background:#fff1ef;color:var(--red);border:1px solid #e5b7b1}.wrap{max-width:1180px;margin:auto;padding:32px 22px 72px}.hero{padding:38px;border-radius:24px;background:linear-gradient(130deg,#254b3b,#3d715b);color:white;box-shadow:var(--shadow);position:relative;overflow:hidden}.hero:after{content:"📚";position:absolute;right:4%;bottom:-25px;font-size:8rem;opacity:.14;transform:rotate(-7deg)}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.75rem;font-weight:900;color:#f1d49b}.hero h1,.section-title,h1{font-family:Georgia,serif}.hero h1{font-size:clamp(2.3rem,6vw,4.8rem);line-height:.95;margin:10px 0 14px;max-width:760px}.hero p{font-size:1.08rem;max-width:680px;color:#e8f2ed}.hero-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}.hero .button{background:#f5d99e;color:#25352e}.hero .button-secondary{background:#ffffff18;border-color:#ffffff55;color:white}.section{margin-top:30px}.section-title{font-size:2rem;margin:0 0 16px}.panel,.card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 24px #1d29240a}.panel{padding:24px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}.book-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.book-card{display:grid;grid-template-columns:90px 1fr;gap:16px;padding:17px}.cover{width:90px;aspect-ratio:2/3;border-radius:7px;object-fit:cover;background:#d9ded8;box-shadow:0 5px 12px #0002}.cover-placeholder{display:flex;align-items:center;justify-content:center;font-size:2rem;background:linear-gradient(145deg,#4d7663,#203f32);color:white}.book-card h3{font-family:Georgia,serif;font-size:1.18rem;line-height:1.16;margin:2px 0 5px}.meta{font-size:.86rem;color:var(--muted)}.owners{font-size:.78rem;color:var(--muted);margin:8px 0}.badge{display:inline-block;border-radius:999px;padding:4px 9px;font-size:.72rem;font-weight:900;text-transform:uppercase;letter-spacing:.04em}.available{background:#dceee4;color:#21573f}.reserved{background:#fff0c9;color:#795100}.borrowed{background:#e8e4f4;color:#4b3d75}.unavailable,.overdue{background:#f5ddda;color:#8d2e28}.filters{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:10px;margin:22px 0}.field{display:grid;gap:7px}.field label{font-size:.88rem;font-weight:800}.field small,.help{color:var(--muted);font-size:.82rem}.required{color:var(--red)}input,select,textarea{width:100%;border:1px solid #c9c7be;border-radius:10px;background:white;padding:12px 13px;font:inherit;color:var(--ink)}textarea{min-height:90px;resize:vertical}input:focus,select:focus,textarea:focus{outline:3px solid #b9d5c8;border-color:var(--green)}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.full{grid-column:1/-1}.notice{padding:13px 15px;border-radius:10px;background:#eef5f0;border-left:4px solid var(--green);margin:13px 0}.notice.error{background:#fff0ee;border-color:var(--red);color:#7f2923}.notice.success{background:#e5f4eb;border-color:#2e7b52}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}.stat{padding:18px}.stat strong{font:800 2rem Georgia,serif;color:var(--green);display:block}.stat span{font-size:.82rem;color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.74rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.table-wrap{overflow:auto}.actions{display:flex;gap:7px;flex-wrap:wrap}.actions form{margin:0}.compact{padding:7px 10px;font-size:.82rem}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.tabs a{padding:8px 12px;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-weight:700;background:white}.stack{display:grid;gap:14px}.empty{text-align:center;padding:36px;color:var(--muted)}.queue{font-size:.84rem;color:var(--gold);font-weight:800}.member-line{font-size:.86rem;color:var(--muted)}
  .filters{grid-template-columns:2fr 1fr 1fr 1fr auto}.lookup-field,.title-field{max-width:760px}.compact-field{max-width:360px}.language-field{max-width:220px}.condition-field{max-width:180px}.lookup-status{min-height:1.25rem}.results{margin-top:4px}
  select{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%231d2924' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3 6 5 5 5-5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;background-size:16px 16px;padding-right:42px}
  .catalogue-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:20px}.catalogue-head h1{font-size:clamp(2rem,4vw,3.3rem);line-height:1;margin:5px 0 8px}.catalogue-head p{margin:0;color:var(--muted);max-width:680px}.catalogue-actions{display:flex;gap:9px;flex-wrap:wrap}.catalogue-tools{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 14px}.results-count{font-weight:800}.view-switch{display:inline-flex;border:1px solid var(--line);border-radius:10px;padding:3px;background:white}.view-switch a{padding:7px 12px;border-radius:7px;text-decoration:none;font-size:.85rem;font-weight:800;color:var(--muted)}.view-switch a.active{background:var(--green);color:white}.book-list{overflow:hidden}.book-list table{table-layout:fixed}.book-list th:nth-child(1){width:80px}.book-list th:nth-child(2){width:21%}.book-list th:nth-child(3){width:16%}.book-list th:nth-child(4){width:17%}.book-list th:nth-child(5){width:22%}.book-list th:nth-child(6){width:115px}.book-list th:nth-child(7){width:145px}.list-cover{width:54px;aspect-ratio:2/3;border-radius:5px;object-fit:cover;background:#d9ded8;box-shadow:0 3px 8px #0002}.list-cover.cover-placeholder{display:flex}.title-cell strong{display:block;font-family:Georgia,serif;font-size:1rem;line-height:1.25}.title-cell small{color:var(--muted)}.book-list td{font-size:.88rem}.book-list .button,.book-list .button-secondary{white-space:nowrap}
  :root{--ink:#1b2d27;--muted:#6d716b;--green:#214b3e;--green2:#2d6652;--cream:#f2ede3;--paper:#fffdf7;--line:#d9d0bf;--gold:#d39a3b;--terracotta:#bd674c;--sage:#dbe7db;--red:#a94a3c;--shadow:0 18px 48px #372d1d12}body{background:radial-gradient(circle at 8% 4%,#fffaf0 0,transparent 27%),linear-gradient(180deg,#f7f2e8 0,#f1ecdf 100%);font-family:"Manrope",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.008em}.nav{background:#fffdf7e8;border-color:#d9d0bfaa;box-shadow:0 1px 0 #fff inset}.nav-inner{max-width:1240px;padding:15px 24px}.brand{font-family:"Fraunces",Georgia,serif;font-size:1.38rem;font-weight:700;letter-spacing:-.025em}.brand:before{content:"◧";display:inline-grid;place-items:center;width:31px;height:31px;margin-right:10px;border-radius:10px 10px 4px 10px;background:var(--terracotta);color:white;font-family:"Manrope",sans-serif;font-size:.92rem;vertical-align:-2px}.nav-links{gap:9px}.nav-links a:not(.button){padding:8px 11px;border-radius:999px}.nav-links a:not(.button):hover{background:#e8e1d5}.wrap{max-width:1240px;padding-top:42px}.hero h1,.section-title,h1,.catalogue-head h1,.book-card h3,.title-cell strong{font-family:"Fraunces",Georgia,serif;font-weight:700;letter-spacing:-.025em}.catalogue-head{padding:0 2px 22px;border-bottom:1px solid var(--line);margin-bottom:18px}.catalogue-head h1{color:var(--green);font-size:clamp(2.5rem,5vw,4rem);line-height:.98}.catalogue-head p{font-size:1.02rem}.eyebrow{color:var(--terracotta);font-weight:800;letter-spacing:.18em}.button,.button-secondary,.button-danger{border-radius:999px;min-height:44px;padding:10px 18px;transition:transform .18s ease,box-shadow .18s ease,background .18s ease}.button{background:var(--green);box-shadow:0 7px 16px #214b3e20}.button:hover{background:var(--green2);transform:translateY(-1px);box-shadow:0 10px 22px #214b3e2b}.button-secondary{background:#fffdf9;border-color:#cfc5b3}.button-secondary:hover{background:#f6eee1;transform:translateY(-1px)}.compact{min-height:36px;padding:7px 13px}.panel,.card{background:rgba(255,253,247,.9);border-color:#d9d0bf;border-radius:22px;box-shadow:0 10px 34px #372d1d0c}.panel{padding:27px}.stats{gap:12px;margin:18px 0}.stat{position:relative;min-height:112px;padding:19px 21px;border:0;overflow:hidden}.stat:nth-child(1){background:#e8eee7}.stat:nth-child(2){background:#f3e5d8}.stat:nth-child(3){background:#e6ede1}.stat:nth-child(4){background:#eee6d4}.stat:after{content:"";position:absolute;width:74px;height:74px;right:-22px;bottom:-27px;border-radius:50%;background:#ffffff70}.stat strong{font-family:"Fraunces",Georgia,serif;font-size:2.35rem;color:var(--green);font-variant-numeric:tabular-nums;line-height:1}.stat span{display:block;margin-top:8px;color:#555f59;font-weight:700}.filters{padding:10px;background:#e8e1d5;border:1px solid #d8cebc;border-radius:20px;box-shadow:0 8px 28px #372d1d0a;margin:20px 0 16px}.field{gap:8px}.field label{color:#36433d;font-weight:800}input,select,textarea{min-height:48px;border:1px solid transparent;border-radius:14px;background:#fffdf9;box-shadow:inset 0 0 0 1px #cfc6b7;color:var(--ink);transition:box-shadow .18s ease,background .18s ease}input::placeholder,textarea::placeholder{color:#96958f}input:focus,select:focus,textarea:focus{outline:0;border-color:transparent;box-shadow:inset 0 0 0 2px var(--green),0 0 0 4px #a9c9ba66;background:white}.book-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.book-card{grid-template-columns:102px 1fr;gap:18px;padding:19px;border-radius:24px 24px 9px 24px;transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease}.book-card:hover{transform:translateY(-4px);border-color:#c6b9a3;box-shadow:0 18px 40px #372d1d18}.cover{width:102px;border-radius:4px 11px 11px 4px;box-shadow:8px 9px 18px #372d1d24;transition:transform .22s ease}.book-card:hover .cover{transform:rotate(-1deg) scale(1.015)}.cover-placeholder{background:linear-gradient(145deg,#567766,#214b3e)}.book-card h3{font-size:1.3rem;line-height:1.12;margin:7px 0 6px;color:#20362e}.meta{line-height:1.5}.owners{font-size:.82rem;margin:10px 0 13px;color:#5e645f;font-weight:600}.badge{padding:5px 9px;font-size:.66rem;letter-spacing:.09em}.available{background:#dcebdc;color:#20523e}.reserved{background:#f7e7bf;color:#735111}.borrowed{background:#e8e1ee;color:#59446c}.view-switch{border-color:#cec4b1;border-radius:999px;padding:4px;background:#e8e1d5}.view-switch a{border-radius:999px;padding:7px 13px}.results-count{font-family:"Fraunces",Georgia,serif;font-size:1.1rem;color:var(--green)}.book-list{border-radius:24px}.book-list th{padding-top:15px;padding-bottom:15px;background:#eee8dd;color:#59625c}.book-list tbody tr{transition:background .15s ease}.book-list tbody tr:hover{background:#faf3e8}.book-list td{padding-top:15px;padding-bottom:15px}.list-cover{border-radius:3px 8px 8px 3px;box-shadow:5px 6px 12px #372d1d20}.title-cell strong{font-size:1.05rem;color:#20362e}.tabs{gap:7px}.tabs a{border-color:#d1c7b5;background:#fffdf9;transition:background .15s ease,transform .15s ease}.tabs a:hover{background:#eee5d8;transform:translateY(-1px)}.notice{border-radius:14px;background:#e8f0e9}.empty{font-family:"Fraunces",Georgia,serif;font-size:1.1rem}
  .brand:before{content:"S";font-family:"Fraunces",Georgia,serif;font-size:1.08rem}
  .dashboard-pane[hidden]{display:none}.dashboard-tabs a.active{background:var(--green);border-color:var(--green);color:white}.dashboard-tabs{padding-bottom:2px}.pagination{display:flex;align-items:center;justify-content:center;gap:10px;margin:24px 0}.pagination .current{color:var(--muted);font-size:.86rem;font-weight:700}
  .field{align-content:start;grid-auto-rows:max-content}
  .approval-pending{display:inline-flex;align-items:center;min-height:34px;padding:6px 11px;border-radius:999px;background:#f5e8c9;color:#765413;font-size:.75rem;font-weight:800;white-space:nowrap}.membership-notice{margin:0 0 16px}
  .request-inline:empty{display:none}.request-inline.notice{margin:9px 0 0;padding:10px;font-size:.78rem}.request-inline strong{display:block}.request-inline .button{margin-top:8px;white-space:normal;text-align:center}
  .nav-status{display:inline-flex;align-items:center;padding:7px 11px;border-radius:999px;background:#f5e8c9;color:#765413;font-size:.78rem;font-weight:800;white-space:nowrap}
  select,select:focus{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%231b2d27' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3 6 5 5 5-5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;background-size:16px 16px}select{background-color:#fffdf9}select:focus{background-color:white}
  .mobile-search,.mobile-summary,.mobile-filter-dialog{display:none}.mobile-filter-dialog::backdrop{background:#17282099;backdrop-filter:blur(2px)}.mobile-filter-sheet{background:var(--paper)}.mobile-filter-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.mobile-filter-head h2{font-family:"Fraunces",Georgia,serif;margin:3px 0 0;font-size:1.8rem}.filter-close{display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--line);border-radius:50%;background:white;color:var(--ink);font-size:1.65rem;line-height:1;cursor:pointer}.mobile-filter-form{display:grid;gap:15px;margin-top:20px}
  .install-app{position:fixed;z-index:80;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));border:0;border-radius:999px;padding:12px 18px;background:var(--green);color:white;font:800 .86rem "Manrope",sans-serif;box-shadow:0 12px 30px #17282044;cursor:pointer}.install-hint{position:fixed;z-index:90;left:14px;right:14px;bottom:max(14px,env(safe-area-inset-bottom));max-width:480px;margin:auto;padding:18px;border:1px solid var(--line);border-radius:22px;background:var(--paper);box-shadow:0 20px 60px #17282055}.install-hint strong{display:block;font-family:"Fraunces",Georgia,serif;font-size:1.25rem;color:var(--green)}.install-hint p{margin:7px 0 14px;color:var(--muted);font-size:.9rem}.install-hint button{border:0;background:transparent;color:var(--green);font:800 .85rem "Manrope",sans-serif;cursor:pointer;padding:4px}
  @media(max-width:650px){body{background:#f5f0e6}.brand-name{display:none}.nav-inner{gap:8px}.nav-status{padding:6px 9px;font-size:.7rem}.wrap{padding:15px 13px 48px}.dashboard h1{font-size:2rem;margin-bottom:8px}.dashboard-tabs{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:12px 0 18px;padding:0}.dashboard-tabs a{display:flex;align-items:center;justify-content:center;min-width:0;padding:8px 9px;text-align:center;white-space:normal;font-size:.8rem}.dashboard-tabs a:last-child{grid-column:1/-1}.dashboard .section{margin-top:14px}.dashboard .panel{padding:16px}.dashboard .section-title{font-size:1.55rem}.catalogue-head{padding:0 1px 12px;margin-bottom:10px;border:0}.catalogue-head .eyebrow,.catalogue-head p,.catalogue-actions{display:none}.catalogue-head h1{font-size:2rem;line-height:1.05;margin:0}.stats,.desktop-filters,.catalogue-tools{display:none!important}.mobile-search{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin:0 0 10px}.mobile-search input{min-width:0}.mobile-search .button{padding-inline:15px}.mobile-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 1px 13px;color:var(--muted);font-size:.82rem}.mobile-summary strong{color:var(--green);font-variant-numeric:tabular-nums}.mobile-summary .button-secondary{min-height:38px;padding:7px 12px;font-size:.78rem}.mobile-filter-dialog[open]{display:block;position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent}.mobile-filter-sheet{position:absolute;left:0;right:0;bottom:0;padding:22px 18px calc(22px + env(safe-area-inset-bottom));border-radius:26px 26px 0 0;box-shadow:0 -18px 50px #13231d33}.book-grid{grid-template-columns:1fr!important;gap:10px}.book-card{grid-template-columns:76px minmax(0,1fr)!important;gap:13px;padding:12px;border-radius:18px 18px 7px 18px;transform:none!important}.book-card .cover{width:76px!important;border-radius:3px 8px 8px 3px;box-shadow:5px 6px 13px #372d1d20}.book-card h3{font-size:1.08rem;margin:4px 0}.book-card .meta{font-size:.76rem;line-height:1.35}.book-card .owners{font-size:.74rem;line-height:1.35;margin:6px 0 9px}.book-card .badge{font-size:.58rem;padding:4px 7px}.book-card .button,.book-card .button-secondary{min-height:34px;padding:6px 11px;font-size:.75rem}.book-list{overflow:visible!important;padding:0;border:0;background:transparent;box-shadow:none}.book-list table,.book-list tbody{display:block;min-width:0!important}.book-list thead{display:none}.book-list tr{display:grid;grid-template-columns:70px minmax(0,1fr);column-gap:13px;margin-bottom:10px;padding:12px;border:1px solid var(--line);border-radius:18px 18px 7px 18px;background:var(--paper)}.book-list td{display:block;grid-column:2;border:0;padding:2px 0;font-size:.78rem}.book-list td:first-child{grid-column:1;grid-row:1/8;padding:0}.book-list .list-cover{width:70px}.book-list td:nth-child(3),.book-list td:nth-child(4){color:var(--muted)}.book-list td:nth-child(6){margin-top:3px}.book-list td:last-child{margin-top:5px}}
  @media(max-width:900px){.book-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.stats{grid-template-columns:repeat(2,1fr)}.catalogue-head{align-items:flex-start;flex-direction:column}.book-list{overflow:auto}.book-list table{min-width:900px}}@media(max-width:650px){.nav-inner{padding:11px 15px}.nav-links{gap:4px}.nav-links a:not(.button):not(.mobile-auth-link):not(.mobile-main-link){display:none}.nav-links .mobile-auth-link,.nav-links .mobile-main-link{padding:7px 6px!important;font-size:.74rem}.nav-links .button{padding:7px 9px;font-size:.74rem}.wrap{padding:20px 14px 56px}.hero{padding:27px 22px}.hero:after{font-size:5rem}.book-grid{grid-template-columns:1fr}.filters,.form-grid{grid-template-columns:1fr}.full{grid-column:auto}.lookup-field,.title-field,.compact-field,.language-field,.condition-field{max-width:none}.stats{grid-template-columns:1fr 1fr}.book-card{grid-template-columns:75px 1fr}.cover{width:75px}.catalogue-tools{align-items:flex-start;flex-direction:column}table.responsive thead{display:none}table.responsive,table.responsive tbody,table.responsive tr,table.responsive td{display:block}table.responsive tr{padding:13px;border-bottom:1px solid var(--line)}table.responsive td{border:0;padding:5px 0}table.responsive td:before{content:attr(data-label);display:block;font-size:.7rem;text-transform:uppercase;color:var(--muted);font-weight:800}}
  </style></head><body><nav class="nav"><div class="nav-inner"><a class="brand" href="/library"><span class="brand-name">Skyrena Community Library</span></a><div class="nav-links">${navLinks}</div></div></nav>${body}<button type="button" class="install-app" id="installLibraryApp" hidden>Install Library App</button><aside class="install-hint" id="iosInstallHint" hidden><strong>Install Skyrena Library</strong><p>In Safari, tap the Share button, choose <b>Add to Home Screen</b>, then select <b>Open as Web App</b>.</p><button type="button" id="closeInstallHint">Got it</button></aside><script>if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/library/sw.js',{scope:'/library/'}).catch(()=>{}));(()=>{const install=document.getElementById('installLibraryApp'),hint=document.getElementById('iosInstallHint'),close=document.getElementById('closeInstallHint');const standalone=matchMedia('(display-mode:standalone)').matches||navigator.standalone===true;const ios=/iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);let prompt;if(standalone)return;addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;install.hidden=false});if(ios&&sessionStorage.getItem('library-install-dismissed')!=='yes'){install.textContent='Install on iPhone';install.hidden=false}install.addEventListener('click',async()=>{if(prompt){prompt.prompt();await prompt.userChoice;prompt=null;install.hidden=true}else if(ios){hint.hidden=false;install.hidden=true}});close.addEventListener('click',()=>{hint.hidden=true;sessionStorage.setItem('library-install-dismissed','yes')});addEventListener('appinstalled',()=>{install.hidden=true;hint.hidden=true})})();</script>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

function html(content: string, status = 200, headers: HeadersInit = {}) {
  return new Response(content, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function redirect(request: Request, path: string, headers: HeadersInit = {}) {
  return new Response(null, { status: 303, headers: { location: new URL(path, request.url).toString(), ...headers } });
}

function messageFrom(url: URL) {
  const success = clean(url.searchParams.get("success"), 220);
  const error = clean(url.searchParams.get("error"), 220);
  return success ? `<div class="notice success">${esc(success)}</div>` : error ? `<div class="notice error">${esc(error)}</div>` : "";
}

function statusLabel(available: number, reserved: number, borrowed: number) {
  if (available > 0) return ["Available", "available"];
  if (reserved > 0) return ["Reserved", "reserved"];
  if (borrowed > 0) return ["Borrowed", "borrowed"];
  return ["Unavailable", "unavailable"];
}

async function cataloguePage(request: Request, env: LibraryEnv) {
  const url = new URL(request.url);
  const member = await sessionMember(request, env);
  const q = clean(url.searchParams.get("q"), 80);
  const sharedBookId = clean(url.searchParams.get("book"), 80);
  const requestedGenre = clean(url.searchParams.get("genre"), 60);
  const genre = CATALOGUE_GENRES.includes(requestedGenre as typeof CATALOGUE_GENRES[number]) ? requestedGenre : "";
  const availability = clean(url.searchParams.get("availability"), 20);
  const sort = ["title", "author", "recent"].includes(clean(url.searchParams.get("sort"), 20)) ? clean(url.searchParams.get("sort"), 20) : "recent";
  const view = clean(url.searchParams.get("view"), 10) === "list" ? "list" : "grid";
  const pageNumber = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const offset = (pageNumber - 1) * CATALOGUE_PAGE_SIZE;
  const conditions = ["m.status='active'", "c.withdrawn_at IS NULL"];
  const bindings: unknown[] = [];
  if (member) {
    conditions.push("c.owner_member_id!=?");
    bindings.push(member.id);
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM library_loans active_loan
      JOIN library_copies borrowed_copy ON borrowed_copy.id=active_loan.copy_id
      WHERE active_loan.borrower_member_id=? AND active_loan.status='active' AND borrowed_copy.title_id=t.id
    )`);
    bindings.push(member.id);
  }
  if (sharedBookId) { conditions.push("t.id=?"); bindings.push(sharedBookId); }
  if (q) { conditions.push("(t.title LIKE ? OR t.author LIKE ? OR t.isbn LIKE ?)"); const like = `%${q}%`; bindings.push(like, like, like); }
  if (genre) { conditions.push("INSTR(',' || LOWER(REPLACE(t.genre,' ','')) || ',', ',' || LOWER(REPLACE(?,' ','')) || ',') > 0"); bindings.push(genre); }
  const having = availability === "available" ? "HAVING available_count > 0" : "";
  const order = sort === "title" ? "t.title COLLATE NOCASE" : sort === "author" ? "t.author COLLATE NOCASE, t.title COLLATE NOCASE" : "MAX(c.created_at) DESC";
  const [booksResult, countsResult] = await env.DB.batch([
    env.DB.prepare(`SELECT t.id,t.title,t.author,t.genre,t.language,t.cover_url,t.isbn,
      COUNT(c.id) copy_count,
      SUM(CASE WHEN c.status='available' THEN 1 ELSE 0 END) available_count,
      SUM(CASE WHEN c.status='reserved' THEN 1 ELSE 0 END) reserved_count,
      SUM(CASE WHEN c.status='borrowed' THEN 1 ELSE 0 END) borrowed_count,
      REPLACE(GROUP_CONCAT(DISTINCT m.display_name || ' ' || m.block_no || '-' || m.flat_no), ',', ' · ') owners
      FROM library_titles t JOIN library_copies c ON c.title_id=t.id
      JOIN library_members m ON m.id=c.owner_member_id
      WHERE ${conditions.join(" AND ")} GROUP BY t.id ${having} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...bindings, CATALOGUE_PAGE_SIZE + 1, offset),
    env.DB.prepare("SELECT titles,copies,available FROM library_metrics WHERE id=1")
  ]);
  const fetchedBooks = booksResult.results as Array<Record<string, unknown>>;
  const hasNextPage = fetchedBooks.length > CATALOGUE_PAGE_SIZE;
  const books = fetchedBooks.slice(0, CATALOGUE_PAGE_SIZE);
  const counts = (countsResult.results[0] || {}) as Record<string, unknown>;
  const visibleAvailable = books.reduce((total, book) => total + Number(book.available_count || 0), 0);
  const activeFilterCount = Number(Boolean(genre)) + Number(Boolean(availability)) + Number(sort !== "recent");
  const bookPresentation = books.map(book => {
    const available = Number(book.available_count || 0), reserved = Number(book.reserved_count || 0), borrowed = Number(book.borrowed_count || 0);
    const [label, className] = statusLabel(available, reserved, borrowed);
    const cover = book.cover_url ? `<img class="cover" src="${esc(book.cover_url)}" alt="Cover of ${esc(book.title)}" loading="lazy">` : `<div class="cover cover-placeholder" aria-hidden="true">📖</div>`;
    const listCover = book.cover_url ? `<img class="list-cover" src="${esc(book.cover_url)}" alt="Cover of ${esc(book.title)}" loading="lazy">` : `<div class="list-cover cover-placeholder" aria-hidden="true">📖</div>`;
    const action = member?.status === "active"
      ? `<div class="request-action"><button class="button compact request" data-title="${esc(book.id)}">${available ? "Request book" : "Join waiting list"}</button><div class="request-inline" aria-live="polite"></div></div>`
      : member
        ? `<span class="approval-pending">${member.status === "pending" ? "Approval pending" : "Account unavailable"}</span>`
        : `<a class="button-secondary compact" href="/library/login">Sign in</a>`;
    return {
      card: `<article class="card book-card">${cover}<div><span class="badge ${className}">${label}</span><h3>${esc(book.title)}</h3><div class="meta">${esc(book.author)} · ${esc(book.genre)} · ${esc(book.language)}</div><div class="owners">${esc(book.copy_count)} ${Number(book.copy_count) === 1 ? "copy" : "copies"} · ${esc(book.owners)}</div>${action}</div></article>`,
      row: `<tr><td>${listCover}</td><td class="title-cell"><strong>${esc(book.title)}</strong><small>${book.isbn ? `ISBN ${esc(book.isbn)}` : "ISBN not provided"}</small></td><td>${esc(book.author)}</td><td>${esc(book.genre)}<br><span class="meta">${esc(book.language)}</span></td><td>${esc(book.copy_count)} ${Number(book.copy_count) === 1 ? "copy" : "copies"}<br><span class="meta">${esc(book.owners)}</span></td><td><span class="badge ${className}">${label}</span></td><td>${action}</td></tr>`
    };
  });
  const empty = `<div class="panel empty">No matching books yet. Try a different search or encourage a neighbour to add one.</div>`;
  const cards = bookPresentation.length ? bookPresentation.map(book => book.card).join("") : empty;
  const rows = bookPresentation.length ? `<div class="panel book-list"><table><thead><tr><th>Cover</th><th>Book</th><th>Author</th><th>Genre &amp; language</th><th>Copies &amp; owners</th><th>Status</th><th>Action</th></tr></thead><tbody>${bookPresentation.map(book => book.row).join("")}</tbody></table></div>` : empty;
  const genreOptions = CATALOGUE_GENRES.map(option => `<option value="${esc(option)}" ${genre === option ? "selected" : ""}>${esc(option)}</option>`).join("");
  const viewParams = new URLSearchParams();
  if (q) viewParams.set("q", q);
  if (genre) viewParams.set("genre", genre);
  if (availability) viewParams.set("availability", availability);
  if (sort !== "recent") viewParams.set("sort", sort);
  if (pageNumber > 1) viewParams.set("page", String(pageNumber));
  const viewHref = (nextView: "grid" | "list") => { const params = new URLSearchParams(viewParams); params.set("view", nextView); return `/library?${params.toString()}`; };
  const pageHref = (nextPage: number) => { const params = new URLSearchParams(viewParams); params.set("view", view); params.set("page", String(nextPage)); return `/library?${params.toString()}`; };
  const catalogueActions = member?.status === "active"
    ? `<a class="button" href="/library/dashboard#add-books">Add books</a><a class="button-secondary" href="/library/dashboard">My library</a>`
    : member
      ? `<a class="button-secondary" href="/library/dashboard">${member.status === "pending" ? "Verification pending" : "View account"}</a>`
      : `<a class="button" href="/library/join">Contribute books</a><a class="button-secondary" href="/library/login">Sign in</a>`;
  const membershipNotice = member?.status === "pending"
    ? `<div class="notice membership-notice">Your membership is awaiting administrator approval. You can browse the catalogue now; borrowing and adding books will be enabled after approval.</div>`
    : member?.status === "suspended"
      ? `<div class="notice error membership-notice">This library account is currently unavailable. Please contact the library coordinator.</div>`
      : "";
  const body = `<main class="wrap"><section class="catalogue-head"><div><div class="eyebrow">Skyrena Community Library</div><h1>Browse books</h1><p>Discover books shared by residents and request your next read.</p></div><div class="catalogue-actions">${catalogueActions}</div></section>${membershipNotice}
  <form class="mobile-search"><input type="hidden" name="view" value="grid"><input type="hidden" name="genre" value="${esc(genre)}"><input type="hidden" name="availability" value="${esc(availability)}"><input type="hidden" name="sort" value="${esc(sort)}"><input name="q" value="${esc(q)}" placeholder="Search books or authors" aria-label="Search books"><button class="button">Search</button></form>
  <div class="mobile-summary"><span><strong>${books.length}</strong> ${books.length === 1 ? "book" : "books"} · <strong>${visibleAvailable}</strong> available</span><button type="button" class="button-secondary compact" id="openMobileFilters">Filter &amp; sort${activeFilterCount ? ` (${activeFilterCount})` : ""}</button></div>
  <dialog class="mobile-filter-dialog" id="mobileFilters"><section class="mobile-filter-sheet"><div class="mobile-filter-head"><div><div class="eyebrow">Refine catalogue</div><h2>Filter &amp; sort</h2></div><button type="button" class="filter-close" id="closeMobileFilters" aria-label="Close filters">×</button></div><form class="mobile-filter-form"><input type="hidden" name="view" value="grid"><input type="hidden" name="q" value="${esc(q)}"><div class="field"><label>Genre</label><select name="genre"><option value="">All genres</option>${genreOptions}</select></div><div class="field"><label>Availability</label><select name="availability"><option value="">All statuses</option><option value="available" ${availability === "available" ? "selected" : ""}>Available now</option></select></div><div class="field"><label>Sort by</label><select name="sort"><option value="recent" ${sort === "recent" ? "selected" : ""}>Recently added</option><option value="title" ${sort === "title" ? "selected" : ""}>Title A–Z</option><option value="author" ${sort === "author" ? "selected" : ""}>Author A–Z</option></select></div></form></section></dialog>
  <section class="stats"><div class="card stat"><strong>${Number(counts.titles || 0)}</strong><span>Book titles</span></div><div class="card stat"><strong>${Number(counts.copies || 0)}</strong><span>Community copies</span></div><div class="card stat"><strong>${Number(counts.available || 0)}</strong><span>Available now</span></div><div class="card stat"><strong>${LOAN_DAYS}</strong><span>Days per loan</span></div></section>
  <form class="filters desktop-filters"><input type="hidden" name="view" value="${view}"><input name="q" value="${esc(q)}" placeholder="Search title, author or ISBN"><select name="genre"><option value="">All genres</option>${genreOptions}</select><select name="availability"><option value="">All statuses</option><option value="available" ${availability === "available" ? "selected" : ""}>Available now</option></select><select name="sort" aria-label="Sort"><option value="recent" ${sort === "recent" ? "selected" : ""}>Recently added</option><option value="title" ${sort === "title" ? "selected" : ""}>Title A–Z</option><option value="author" ${sort === "author" ? "selected" : ""}>Author A–Z</option></select><button class="button">Search</button></form>
  <div class="catalogue-tools"><div class="results-count">${books.length} ${books.length === 1 ? "book" : "books"}</div><div class="view-switch" aria-label="Catalogue view"><a class="${view === "grid" ? "active" : ""}" href="${esc(viewHref("grid"))}">▦ Grid</a><a class="${view === "list" ? "active" : ""}" href="${esc(viewHref("list"))}">☷ List</a></div></div>
  ${view === "list" ? rows : `<section class="book-grid">${cards}</section>`}${pageNumber > 1 || hasNextPage ? `<nav class="pagination" aria-label="Catalogue pages">${pageNumber > 1 ? `<a class="button-secondary compact" href="${esc(pageHref(pageNumber - 1))}">Previous</a>` : ""}<span class="current">Page ${pageNumber}</span>${hasNextPage ? `<a class="button-secondary compact" href="${esc(pageHref(pageNumber + 1))}">Next</a>` : ""}</nav>` : ""}</main>`;
  const filterScript = `const mobileFilters=document.getElementById('mobileFilters');document.getElementById('openMobileFilters')?.addEventListener('click',()=>mobileFilters.showModal());document.getElementById('closeMobileFilters')?.addEventListener('click',()=>mobileFilters.close());mobileFilters?.addEventListener('click',event=>{if(event.target===mobileFilters)mobileFilters.close()});document.querySelectorAll('.mobile-filter-form select,.desktop-filters select').forEach(select=>select.addEventListener('change',()=>select.form.requestSubmit()));`;
  const requestScript = member?.status === "active" ? `document.querySelectorAll('.request').forEach(button=>button.addEventListener('click',async()=>{const requestFeedback=button.closest('.request-action').querySelector('.request-inline');button.disabled=true;const original=button.textContent;button.textContent='Requesting…';requestFeedback.className='request-inline';requestFeedback.textContent='';try{const response=await fetch('/api/library/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({titleId:button.dataset.title})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to request this book.');button.textContent=result.message.includes('waiting list')?'Waitlisted':'Requested';button.classList.remove('button');button.classList.add('button-secondary');requestFeedback.className='request-inline notice success';const summary=document.createElement('strong');summary.textContent=result.message;requestFeedback.append(summary);const requestsLink=document.createElement('a');requestsLink.href='/library/dashboard#requests';requestsLink.textContent='View my request';requestFeedback.append(document.createTextNode(' '),requestsLink);if(result.notifyOwnerUrl){const notify=document.createElement('a');notify.className='button compact';notify.href=result.notifyOwnerUrl;notify.target='_blank';notify.rel='noopener';notify.textContent='Notify owner on WhatsApp';requestFeedback.append(notify)}}catch(error){requestFeedback.className='request-inline notice error';requestFeedback.textContent=error.message;button.disabled=false;button.textContent=original}}));` : "";
  const script = filterScript + requestScript;
  return html(page("Browse books", body, member, script));
}

async function joinPage(request: Request, env: LibraryEnv) {
  const member = await sessionMember(request, env);
  if (member) return redirect(request, "/library/dashboard");
  const body = `<main class="wrap"><section class="panel" style="max-width:760px;margin:auto"><div class="eyebrow">Community membership</div><h1>Join Skyrena Library</h1><p class="help">Create your personal library account. Other residents from the same flat may create their own accounts using their mobile numbers. A library administrator will verify that you are a Skyrena resident.</p>${messageFrom(new URL(request.url))}<form method="post" action="/library/join" class="form-grid"><div class="field full"><label>Your name <span class="required">*</span></label><input name="name" required maxlength="100" autocomplete="name"></div><div class="field"><label>Block <span class="required">*</span></label><select name="block" required><option value="">Select block</option>${["A","B","C","D","E"].map(block => `<option>${block}</option>`).join("")}</select></div><div class="field"><label>Flat number <span class="required">*</span></label><input name="flat" required maxlength="12" placeholder="e.g. 505 or C505"><small>You may include the block letter.</small></div><div class="field"><label>Mobile number <span class="required">*</span></label><input name="mobile" required inputmode="numeric" pattern="[6-9][0-9]{9}" maxlength="10" placeholder="10-digit number"></div><div class="field"><label>Create a 4–6 digit PIN <span class="required">*</span></label><input name="pin" required type="password" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" autocomplete="new-password"><small>Use this PIN to access your books and requests.</small></div><div class="full"><button class="button">Create library account</button></div></form></section></main>`;
  return html(page("Join", body));
}

async function join(request: Request, env: LibraryEnv) {
  const form = await request.formData();
  const name = formValue(form, "name", 100), block = formValue(form, "block", 1).toUpperCase();
  const mobile = formValue(form, "mobile", 10).replace(/\D/g, ""), pin = formValue(form, "pin", 6);
  let flat = "";
  try { flat = flatFor(block, form.get("flat")); } catch (error) { return redirect(request, `/library/join?error=${encodeURIComponent((error as Error).message)}`); }
  if (name.length < 2 || !/^[A-E]$/.test(block) || !/^[6-9]\d{9}$/.test(mobile) || !/^\d{4,6}$/.test(pin)) return redirect(request, "/library/join?error=Please+enter+all+details+correctly.");
  const existing = await env.DB.prepare("SELECT id FROM library_members WHERE mobile_number=? LIMIT 1").bind(mobile).first<{ id: string }>();
  if (existing) return redirect(request, "/library/login?error=An+account+already+exists+for+this+mobile+number.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    await env.DB.prepare(`INSERT INTO library_members (id,display_name,block_no,flat_no,mobile_number,pin_salt,pin_hash) VALUES (?,?,?,?,?,?,?)`).bind(id(), name, block, flat, mobile, base64url(salt), await pinHash(pin, salt)).run();
  } catch {
    return redirect(request, "/library/login?error=An+account+already+exists+for+this+mobile+number.");
  }
  return redirect(request, "/library/login?success=Account+created.+An+administrator+will+verify+it+shortly.");
}

async function loginPage(request: Request, env: LibraryEnv) {
  const member = await sessionMember(request, env);
  if (member) return redirect(request, "/library/dashboard");
  const body = `<main class="wrap"><section class="panel" style="max-width:560px;margin:auto"><div class="eyebrow">Resident access</div><h1>Library sign in</h1>${messageFrom(new URL(request.url))}<form method="post" action="/library/login" class="stack"><div class="field"><label>Mobile number</label><input name="mobile" required inputmode="numeric" pattern="[6-9][0-9]{9}" maxlength="10" autocomplete="username"></div><div class="field"><label>Library PIN</label><input name="pin" required type="password" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" autocomplete="current-password"></div><button class="button">Sign in</button><a href="/library/join">New to the library? Create an account</a></form></section></main>`;
  return html(page("Sign in", body));
}

async function login(request: Request, env: LibraryEnv) {
  const form = await request.formData();
  const mobile = formValue(form, "mobile", 10).replace(/\D/g, ""), pin = formValue(form, "pin", 6);
  const row = await env.DB.prepare("SELECT id,display_name,block_no,flat_no,mobile_number,status,pin_salt,pin_hash FROM library_members WHERE mobile_number=?").bind(mobile).first<Record<string, unknown>>();
  if (!row || !/^\d{4,6}$/.test(pin) || !secureEqual(await pinHash(pin, fromBase64url(String(row.pin_salt))), String(row.pin_hash))) return redirect(request, "/library/login?error=Incorrect+mobile+number+or+PIN.");
  const token = await sessionToken(String(row.id), env);
  return redirect(request, "/library/dashboard", { "set-cookie": `skyrena_library=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` });
}

function logout(request: Request) {
  return redirect(request, "/library", { "set-cookie": "skyrena_library=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
}

function requestStatus(value: unknown) {
  const status = String(value);
  return ({ pending: "Requested", waitlisted: "Waiting list", approved: "Reserved", fulfilled: "Borrowed", declined: "Declined", cancelled: "Cancelled" } as Record<string, string>)[status] || status;
}

function whatsappLink(mobile: unknown, message: string) {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  return `https://wa.me/91${digits}?text=${encodeURIComponent(message)}`;
}

async function dashboardPage(request: Request, env: LibraryEnv) {
  const member = await sessionMember(request, env);
  if (!member) return redirect(request, "/library/login?error=Please+sign+in+to+continue.");
  const url = new URL(request.url);
  if (member.status !== "active") {
    const body = `<main class="wrap"><section class="panel" style="max-width:760px;margin:auto"><div class="eyebrow">Membership verification</div><h1>Welcome, ${esc(member.display_name)}</h1>${messageFrom(url)}<div class="notice">Your account is awaiting administrator verification. Once approved, you can add books and place borrowing requests.</div><p class="member-line">Block ${esc(member.block_no)} · Flat ${esc(member.flat_no)} · ${esc(member.mobile_number)}</p><a class="button-secondary" href="/library">Browse the catalogue</a></section></main>`;
    return html(page("My library", body, member));
  }
  const [copiesResult, incomingResult, waitlistResult, requestsResult, borrowedResult] = await env.DB.batch([
    env.DB.prepare(`SELECT c.id,c.status,c.condition_label,c.notes,t.title,t.author,t.cover_url,
      l.due_at,b.display_name borrower_name,b.block_no borrower_block,b.flat_no borrower_flat,b.mobile_number borrower_mobile
      FROM library_copies c JOIN library_titles t ON t.id=c.title_id
      LEFT JOIN library_loans l ON l.copy_id=c.id AND l.status='active'
      LEFT JOIN library_members b ON b.id=l.borrower_member_id
      WHERE c.owner_member_id=? AND c.withdrawn_at IS NULL ORDER BY c.created_at DESC`).bind(member.id),
    env.DB.prepare(`SELECT r.id,r.status,r.created_at,r.reservation_expires_at,r.reservation_extensions,t.title,c.id copy_id,
      m.display_name requester_name,m.block_no requester_block,m.flat_no requester_flat,m.mobile_number requester_mobile
      FROM library_requests r JOIN library_titles t ON t.id=r.title_id
      JOIN library_copies c ON c.id=r.copy_id JOIN library_members m ON m.id=r.requester_member_id
      WHERE c.owner_member_id=? AND r.status IN ('pending','approved') ORDER BY r.created_at`).bind(member.id),
    env.DB.prepare(`SELECT r.id,r.created_at,r.title_id,t.title,
      m.display_name requester_name,m.block_no requester_block,m.flat_no requester_flat,m.mobile_number requester_mobile,
      (SELECT c.id FROM library_copies c WHERE c.title_id=r.title_id AND c.owner_member_id=?
        AND c.status='available' AND c.withdrawn_at IS NULL ORDER BY c.created_at LIMIT 1) available_copy_id
      FROM library_requests r JOIN library_titles t ON t.id=r.title_id
      JOIN library_members m ON m.id=r.requester_member_id
      WHERE r.status='waitlisted' AND EXISTS (SELECT 1 FROM library_copies owned
        WHERE owned.title_id=r.title_id AND owned.owner_member_id=? AND owned.withdrawn_at IS NULL)
      ORDER BY t.title COLLATE NOCASE,r.created_at LIMIT 100`).bind(member.id, member.id),
    env.DB.prepare(`SELECT r.id,r.status,r.created_at,r.reservation_expires_at,t.title,t.author
      FROM library_requests r JOIN library_titles t ON t.id=r.title_id
      WHERE r.requester_member_id=? AND (r.status IN ('pending','waitlisted','approved') OR (r.status='fulfilled' AND EXISTS (SELECT 1 FROM library_loans l WHERE l.request_id=r.id AND l.status='active')))
      ORDER BY r.created_at DESC LIMIT 50`).bind(member.id),
    env.DB.prepare(`SELECT l.id,l.due_at,l.borrowed_at,t.title,t.author,o.display_name owner_name,o.block_no owner_block,o.flat_no owner_flat,o.mobile_number owner_mobile
      FROM library_loans l JOIN library_copies c ON c.id=l.copy_id JOIN library_titles t ON t.id=c.title_id
      JOIN library_members o ON o.id=l.owner_member_id WHERE l.borrower_member_id=? AND l.status='active' ORDER BY l.due_at`).bind(member.id)
  ]);
  const copies = copiesResult.results as Array<Record<string, unknown>>;
  const incoming = incomingResult.results as Array<Record<string, unknown>>;
  const waitlist = waitlistResult.results as Array<Record<string, unknown>>;
  const requests = requestsResult.results as Array<Record<string, unknown>>;
  const borrowed = borrowedResult.results as Array<Record<string, unknown>>;
  const overdueBorrowed = borrowed.filter(loan => loanTiming(loan.due_at).key === "overdue");
  const copyRows = copies.map(copy => {
    const overdue = copy.due_at && new Date(String(copy.due_at).replace(" ", "T") + "Z").getTime() < Date.now();
    const loanInfo = copy.borrower_name ? `<div class="help">With ${esc(copy.borrower_name)} · ${esc(copy.borrower_block)}-${esc(copy.borrower_flat)} · due ${formatDate(copy.due_at)} ${overdue ? '<span class="badge overdue">Overdue</span>' : ""}</div>` : "";
    const removable = copy.status === "available" || copy.status === "unavailable";
    return `<tr><td data-label="Book"><strong>${esc(copy.title)}</strong><div class="help">${esc(copy.author)}</div></td><td data-label="Status"><span class="badge ${esc(copy.status)}">${esc(copy.status)}</span>${loanInfo}</td><td data-label="Action"><div class="actions">${copy.status === "available" ? `<form method="post" action="/api/library/copies/${esc(copy.id)}/action"><input type="hidden" name="action" value="pause"><button class="button-secondary compact">Pause</button></form>` : copy.status === "unavailable" ? `<form method="post" action="/api/library/copies/${esc(copy.id)}/action"><input type="hidden" name="action" value="resume"><button class="button-secondary compact">Make available</button></form>` : copy.status === "borrowed" ? `<form method="post" action="/api/library/copies/${esc(copy.id)}/action"><input type="hidden" name="action" value="return"><button class="button compact">Confirm return</button></form>` : ""}${removable ? `<form method="post" action="/api/library/copies/${esc(copy.id)}/action" onsubmit="return confirm('Remove this book from your shelf and the community catalogue?')"><input type="hidden" name="action" value="remove"><button class="button-danger compact">Remove from shelf</button></form>` : ""}</div></td></tr>`;
  }).join("") || `<tr><td colspan="3" class="empty">You have not added any books yet.</td></tr>`;
  const incomingRows = incoming.map(entry => {
    const reservationInfo = entry.status === "approved" && entry.reservation_expires_at ? `<div class="help">Reserved until ${formatDate(entry.reservation_expires_at, true)}</div>` : "";
    const expiryTime = entry.reservation_expires_at ? new Date(`${String(entry.reservation_expires_at).replace(" ", "T")}Z`).getTime() : 0;
    const handoverReminder = entry.status === "approved" && expiryTime > Date.now() && expiryTime - Date.now() <= 24 * 60 * 60 * 1000
      ? `<div class="queue">Handover confirmation is still pending.</div>` : "";
    const canExtend = entry.status === "approved" && Number(entry.reservation_extensions || 0) < 1;
    return `<tr><td data-label="Book"><strong>${esc(entry.title)}</strong></td><td data-label="Reader">${esc(entry.requester_name)}<div class="help">Block ${esc(entry.requester_block)} · Flat ${esc(entry.requester_flat)}</div></td><td data-label="Status"><span class="badge ${entry.status === "approved" ? "reserved" : "available"}">${requestStatus(entry.status)}</span>${reservationInfo}${handoverReminder}</td><td data-label="Action"><div class="actions">${entry.status === "pending" ? `<form method="post" action="/api/library/requests/${esc(entry.id)}/action"><input type="hidden" name="action" value="approve"><button class="button compact">Accept</button></form><form method="post" action="/api/library/requests/${esc(entry.id)}/action"><input type="hidden" name="action" value="decline"><button class="button-danger compact">Decline</button></form>` : `<form method="post" action="/api/library/requests/${esc(entry.id)}/action"><input type="hidden" name="action" value="handover"><button class="button compact">Book handed over</button></form>${canExtend ? `<form method="post" action="/api/library/requests/${esc(entry.id)}/action"><input type="hidden" name="action" value="extend"><button class="button-secondary compact">Extend 24 hours</button></form>` : ""}<a class="button-secondary compact" target="_blank" rel="noopener" href="${whatsappLink(entry.requester_mobile, `Hi ${entry.requester_name}, your request for ${entry.title} has been accepted and is reserved until ${formatDate(entry.reservation_expires_at, true)}. Please contact me to arrange collection.`)}">Notify borrower on WhatsApp</a>`}</div></td></tr>`;
  }).join("") || `<tr><td colspan="4" class="empty">No incoming requests.</td></tr>`;
  const waitlistRows = waitlist.map(entry => `<tr><td data-label="Book"><strong>${esc(entry.title)}</strong></td><td data-label="Interested reader">${esc(entry.requester_name)}<div class="help">${esc(entry.requester_block)}-${esc(entry.requester_flat)} · ${esc(entry.requester_mobile)}</div></td><td data-label="Requested">${formatDate(entry.created_at, true)}</td><td data-label="Action">${entry.available_copy_id ? `<form method="post" action="/api/library/requests/${esc(entry.id)}/action"><input type="hidden" name="action" value="choose-reader"><input type="hidden" name="copyId" value="${esc(entry.available_copy_id)}"><button class="button compact">Reserve for this reader</button></form>` : `<span class="help">Available after the current loan or reservation ends</span>`}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">Nobody is waiting for your books.</td></tr>`;
  const requestRows = requests.map(entry => `<tr><td data-label="Book"><strong>${esc(entry.title)}</strong><div class="help">${esc(entry.author)}</div></td><td data-label="Status"><span class="badge ${entry.status === "approved" ? "reserved" : entry.status === "fulfilled" ? "borrowed" : entry.status === "pending" || entry.status === "waitlisted" ? "available" : "unavailable"}">${requestStatus(entry.status)}</span>${entry.status === "waitlisted" ? `<div class="queue">Waiting for an owner to select a reader</div>` : entry.status === "approved" && entry.reservation_expires_at ? `<div class="help">Collect by ${formatDate(entry.reservation_expires_at, true)}</div>` : ""}</td><td data-label="Action">${["pending","waitlisted","approved"].includes(String(entry.status)) ? `<form method="post" action="/api/library/requests/${esc(entry.id)}/action"><input type="hidden" name="action" value="cancel"><button class="button-secondary compact">Cancel</button></form>` : ""}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">You have not requested any books.</td></tr>`;
  const borrowedCards = borrowed.map(loan => {
    const timing = loanTiming(loan.due_at), overdue = timing.key === "overdue";
    const personalReminder = `Return reminder: “${loan.title}” by ${loan.author} is due on ${formatDate(loan.due_at)}. Please return it to ${loan.owner_name}, ${loan.owner_block}-${loan.owner_flat}.`;
    return `<div class="card panel"><span class="badge ${overdue ? "overdue" : "borrowed"}">${esc(timing.label)}</span><h3>${esc(loan.title)}</h3><div class="meta">${esc(loan.author)}</div><p><strong>Return by ${formatDate(loan.due_at)}</strong></p><div class="help">Owner: ${esc(loan.owner_name)} · Block ${esc(loan.owner_block)} · Flat ${esc(loan.owner_flat)}</div><div class="actions"><a class="button-secondary compact" target="_blank" rel="noopener" href="${whatsappLink(loan.owner_mobile, `Hi ${loan.owner_name}, I am contacting you about returning ${loan.title}.`)}">Contact owner</a><a class="button compact" target="_blank" rel="noopener" href="${whatsappLink(member.mobile_number, personalReminder)}">Remind me on WhatsApp</a></div></div>`;
  }).join("") || `<div class="panel empty">No books currently borrowed.</div>`;
  const overdueNotice = overdueBorrowed.length ? `<div class="notice error"><strong>${overdueBorrowed.length === 1 ? "A borrowed book is overdue." : `${overdueBorrowed.length} borrowed books are overdue.`}</strong> Please return ${overdueBorrowed.length === 1 ? "it" : "them"} as soon as possible, or contact the owner if you need assistance.</div>` : "";
  const body = `<main class="wrap dashboard"><div class="eyebrow">Block ${esc(member.block_no)} · Flat ${esc(member.flat_no)}</div><h1>Welcome, ${esc(member.display_name)}</h1>${messageFrom(url)}${overdueNotice}<nav class="tabs dashboard-tabs" aria-label="My Library sections"><a href="#borrowed" data-tab="borrowed">Borrowed Books</a><a href="#requests" data-tab="requests">Books I Requested</a><a href="#incoming" data-tab="incoming">Requests for My Books</a><a href="#shelf" data-tab="shelf">Books I’m Sharing</a><a href="#add-books" data-tab="add-books">Add Books</a></nav>
  <section id="borrowed" class="section dashboard-pane"><h2 class="section-title">Books I’m Reading</h2><div class="book-grid">${borrowedCards}</div></section>
  <section id="requests" class="section panel dashboard-pane"><h2 class="section-title">Books I Requested</h2><div class="table-wrap"><table class="responsive"><thead><tr><th>Book</th><th>Status</th><th>Action</th></tr></thead><tbody>${requestRows}</tbody></table></div></section>
  <section id="incoming" class="section panel dashboard-pane"><h2 class="section-title">Requests to Borrow My Books</h2><div class="table-wrap"><table class="responsive"><thead><tr><th>Book</th><th>Reader</th><th>Status</th><th>Action</th></tr></thead><tbody>${incomingRows}</tbody></table></div><h3 style="margin-top:28px">Interested readers waiting for my books</h3><p class="help">You decide who receives an available copy. Waiting residents cannot see one another’s details.</p><div class="table-wrap"><table class="responsive"><thead><tr><th>Book</th><th>Interested reader</th><th>Requested</th><th>Action</th></tr></thead><tbody>${waitlistRows}</tbody></table></div></section>
  <section id="shelf" class="section panel dashboard-pane"><h2 class="section-title">Books I’m Sharing</h2><div class="table-wrap"><table class="responsive"><thead><tr><th>Book</th><th>Status</th><th>Action</th></tr></thead><tbody>${copyRows}</tbody></table></div></section>
  <section id="add-books" class="section panel dashboard-pane"><div class="eyebrow">Share your shelf</div><h2 class="section-title">Add one or more books</h2><p class="help">Search by ISBN, title or author to fill details automatically. Online suggestions are limited to English, Hindi and Telugu editions. You can correct any field before saving.</p><div id="book-message"></div><form id="books-form"><div id="book-rows"></div><div class="actions"><button type="button" class="button-secondary" id="add-row">+ Add another book</button><button class="button" id="save-books">Save books</button></div></form><datalist id="genres"><option>Fiction</option><option>Non-fiction</option><option>Children</option><option>Young Adult</option><option>Biography</option><option>History</option><option>Mythology & Spirituality</option><option>Self-help</option><option>Business</option><option>Science & Technology</option><option>Comics & Graphic Novels</option><option>Poetry</option><option>Regional Literature</option></datalist></section></main>`;
  const scriptV2 = `const dashboardTabs=[...document.querySelectorAll('.dashboard-tabs a')],dashboardPanes=[...document.querySelectorAll('.dashboard-pane')];function showDashboardTab(){const requested=location.hash.slice(1),active=dashboardPanes.some(pane=>pane.id===requested)?requested:'borrowed';dashboardPanes.forEach(pane=>pane.hidden=pane.id!==active);dashboardTabs.forEach(tab=>{const selected=tab.dataset.tab===active;tab.classList.toggle('active',selected);tab.setAttribute('aria-current',selected?'page':'false')})}addEventListener('hashchange',showDashboardTab);showDashboardTab();let rowCount=0;
const rows=document.querySelector('#book-rows'),message=document.querySelector('#book-message');
const languageOptions=['English','Hindi','Telugu'];
function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function searchBooks(box){
  const lookup=box.querySelector('.lookup'),select=box.querySelector('.results'),status=box.querySelector('.lookup-status'),q=lookup.value.trim();
  if(q.length<4)return;
  const sequence=(box._searchSequence||0)+1;box._searchSequence=sequence;status.textContent='Searching…';
  try{
    const response=await fetch('/api/library/metadata?q='+encodeURIComponent(q)),result=await response.json();
    if(sequence!==box._searchSequence)return;
    select._items=result.items||[];
    select.innerHTML='<option value="">Select a matching edition</option>'+select._items.map((item,index)=>'<option value="'+index+'">'+escapeHtml(item.title)+' — '+escapeHtml(item.author)+(item.language?' · '+escapeHtml(item.language):'')+'</option>').join('');
    select.hidden=!select._items.length;status.textContent=select._items.length?'Choose the correct title and edition below.':'No English, Hindi or Telugu match found. You can enter the details manually.';
  }catch(error){if(sequence===box._searchSequence){select.hidden=true;status.textContent='Online search is unavailable. You can enter the details manually.'}}
}
function addRow(){
  rowCount++;const box=document.createElement('div');box.className='card panel';box.style.marginBottom='14px';
  box.innerHTML='<div class="actions" style="justify-content:space-between"><strong>Book '+rowCount+'</strong><button type="button" class="button-danger compact remove">Remove</button></div><div class="form-grid"><div class="field full lookup-field"><label>Find book online</label><input class="lookup" placeholder="Start typing an ISBN, title or author" autocomplete="off"><small class="lookup-status">Suggestions appear after 4 characters.</small><select class="results" hidden><option value="">Select a matching edition</option></select></div><div class="field full title-field"><label>Title <span class="required">*</span></label><input class="title" required maxlength="180"></div><div class="field compact-field"><label>Author <span class="required">*</span></label><input class="author" required maxlength="160"></div><div class="field"><label>Genre <span class="required">*</span></label><input class="genre" list="genres" required maxlength="80"></div><div class="field compact-field"><label>ISBN</label><input class="isbn" inputmode="numeric" maxlength="20"></div><div class="field language-field"><label>Language <span class="required">*</span></label><select class="language" required>'+languageOptions.map(value=>'<option>'+value+'</option>').join('')+'</select></div><div class="field condition-field"><label>Condition</label><select class="condition"><option>Like new</option><option selected>Good</option><option>Well used</option></select></div><div class="field"><label>Notes</label><input class="notes" maxlength="200" placeholder="Edition, minor damage, etc."></div><input class="cover" type="hidden"></div>';
  rows.append(box);
  box.querySelector('.remove').onclick=()=>{if(rows.children.length>1)box.remove()};
  const lookup=box.querySelector('.lookup');let timer;
  lookup.oninput=()=>{clearTimeout(timer);const q=lookup.value.trim();const select=box.querySelector('.results'),status=box.querySelector('.lookup-status');if(q.length<4){box._searchSequence=(box._searchSequence||0)+1;select.hidden=true;status.textContent='Suggestions appear after 4 characters.';return}status.textContent='Searching shortly…';timer=setTimeout(()=>searchBooks(box),700)};
  lookup.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(timer);searchBooks(box)}};
  box.querySelector('.results').onchange=event=>{const item=event.target._items?.[Number(event.target.value)];if(!item)return;box.querySelector('.title').value=item.title||'';box.querySelector('.author').value=item.author||'';box.querySelector('.genre').value=item.genre||'';box.querySelector('.isbn').value=item.isbn||'';box.querySelector('.language').value=languageOptions.includes(item.language)?item.language:'Other';box.querySelector('.cover').value=item.cover||''};
}
document.querySelector('#add-row').onclick=()=>addRow();addRow();
document.querySelector('#books-form').onsubmit=async event=>{event.preventDefault();const button=document.querySelector('#save-books');const books=[...rows.children].map(box=>({title:box.querySelector('.title').value,author:box.querySelector('.author').value,genre:box.querySelector('.genre').value,isbn:box.querySelector('.isbn').value,language:box.querySelector('.language').value,condition:box.querySelector('.condition').value,notes:box.querySelector('.notes').value,coverUrl:box.querySelector('.cover').value}));button.disabled=true;button.textContent='Saving…';try{const response=await fetch('/api/library/books',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({books})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save books.');message.className='notice success';message.textContent='';const summary=document.createElement('strong');summary.textContent=result.message;message.append(summary);const actions=document.createElement('div');actions.className='actions';actions.style.marginTop='10px';const share=document.createElement('a');share.className='button compact';share.href=result.shareUrl;share.target='_blank';share.rel='noopener';share.textContent='Share new books on WhatsApp';const shelf=document.createElement('a');shelf.className='button-secondary compact';shelf.href='/library/dashboard#shelf';shelf.textContent='View my shelf';actions.append(share,shelf);message.append(actions);rows.innerHTML='';rowCount=0;addRow()}catch(error){message.className='notice error';message.textContent=error.message}finally{button.disabled=false;button.textContent='Save books'}};`;
  return html(page("My library", body, member, scriptV2));
}

async function addBooks(request: Request, env: LibraryEnv) {
  const member = await sessionMember(request, env);
  if (!member || member.status !== "active") return json({ error: "Verified library membership required." }, 401);
  let body: { books?: Array<Record<string, unknown>> };
  try { body = await request.json(); } catch { return json({ error: "Invalid book details." }, 400); }
  if (!body.books?.length || body.books.length > 20) return json({ error: "Add between 1 and 20 books at a time." }, 400);
  let added = 0;
  const addedBooks: Array<{ id: string; title: string; author: string }> = [];
  for (const entry of body.books) {
    const title = clean(entry.title, 180), author = clean(entry.author, 160), genre = clean(entry.genre, 80), language = clean(entry.language, 50) || "English";
    const isbn = clean(entry.isbn, 20).replace(/[^0-9Xx]/g, "").toUpperCase();
    const condition = ["Like new", "Good", "Well used"].includes(clean(entry.condition, 30)) ? clean(entry.condition, 30) : "Good";
    const notes = clean(entry.notes, 200), coverUrl = clean(entry.coverUrl, 500);
    if (title.length < 2 || author.length < 2 || genre.length < 2) return json({ error: "Every book needs a title, author and genre." }, 400);
    const key = isbn ? `isbn:${isbn}` : `book:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}|${author.toLowerCase().replace(/[^a-z0-9]+/g, "-")}|${language.toLowerCase()}`;
    let book = await env.DB.prepare("SELECT id FROM library_titles WHERE catalogue_key=?").bind(key).first<{ id: string }>();
    if (!book) {
      const titleId = id();
      await env.DB.prepare(`INSERT OR IGNORE INTO library_titles (id,catalogue_key,isbn,title,author,genre,language,cover_url) VALUES (?,?,?,?,?,?,?,?)`).bind(titleId, key, isbn || null, title, author, genre, language, /^https:\/\//.test(coverUrl) ? coverUrl : null).run();
      book = await env.DB.prepare("SELECT id FROM library_titles WHERE catalogue_key=?").bind(key).first<{ id: string }>();
    }
    if (!book) return json({ error: "Unable to create the book record." }, 500);
    const copyId = id();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO library_copies (id,title_id,owner_member_id,condition_label,notes) VALUES (?,?,?,?,?)").bind(copyId, book.id, member.id, condition, notes || null),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor,after_json) VALUES ('library_copy',?,'created',?,?)").bind(copyId, member.id, JSON.stringify({ title, author, genre }))
    ]);
    added++;
    addedBooks.push({ id: book.id, title, author });
  }
  const catalogueUrl = new URL("/library", request.url);
  if (added === 1) catalogueUrl.searchParams.set("book", addedBooks[0].id);
  const announced = addedBooks.slice(0, 5).map((book, index) => `${index + 1}. *${book.title}*\n   by ${book.author}`).join("\n\n");
  const remainder = addedBooks.length > 5 ? `\n\n…and ${addedBooks.length - 5} more.` : "";
  const shareText = added === 1
    ? `*New arrival at Skyrena Community Library!*\n\n*${addedBooks[0].title}*\nby ${addedBooks[0].author}\n\nThis book is now available to borrow.\n\nView and request the book:\n${catalogueUrl.toString()}\n\nHappy reading!`
    : `*New arrivals at Skyrena Community Library!*\n\n${announced}${remainder}\n\nBrowse and request a book:\n${catalogueUrl.toString()}\n\nHappy reading!`;
  return json({ ok: true, message: `${added} ${added === 1 ? "book" : "books"} added to your shelf.`, shareUrl: `https://wa.me/?text=${encodeURIComponent(shareText)}` });
}

async function metadataSearch(request: Request) {
  const q = clean(new URL(request.url).searchParams.get("q"), 100);
  if (q.length < 4) return json({ items: [] });
  try {
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&printType=books&maxResults=20&projection=lite`, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (response.ok) {
      const data = await response.json() as { items?: Array<{ volumeInfo?: Record<string, unknown> }> };
      const items = uniqueMetadata((data.items || []).map(item => {
        const info = item.volumeInfo || {};
        const identifiers = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers as Array<Record<string, unknown>> : [];
        const images = (info.imageLinks || {}) as Record<string, unknown>;
        return { title: clean(info.title, 180), author: Array.isArray(info.authors) ? clean((info.authors as unknown[]).join(", "), 160) : "", genre: Array.isArray(info.categories) ? clean((info.categories as unknown[])[0], 80) : "", language: languageName(info.language), isbn: clean(identifiers.find(value => value.type === "ISBN_13")?.identifier || identifiers[0]?.identifier, 20), cover: clean(images.thumbnail || images.smallThumbnail, 500).replace(/^http:/, "https:") };
      }).filter(item => item.title && item.author && ONLINE_SEARCH_LANGUAGES.has(item.language)));
      if (items.length) return json({ items }, 200);
    }
  } catch { /* Open Library fallback below */ }
  try {
    const response = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=24&fields=key,title,author_name,subject,isbn,language,cover_i`, { headers: { "user-agent": "SkyrenaCommunityLibrary/1.0" }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!response.ok) throw new Error("Metadata service unavailable");
    const data = await response.json() as { docs?: Array<Record<string, unknown>> };
    const items = uniqueMetadata((data.docs || []).map(book => {
      const authors = Array.isArray(book.author_name) ? book.author_name as unknown[] : [];
      const subjects = Array.isArray(book.subject) ? book.subject as unknown[] : [];
      const isbns = Array.isArray(book.isbn) ? book.isbn as unknown[] : [];
      const languages = Array.isArray(book.language) ? book.language as unknown[] : [];
      const preferredLanguage = languages.map(languageName).find(language => ONLINE_SEARCH_LANGUAGES.has(language)) || "Other";
      const coverId = Number(book.cover_i || 0);
      return { title: clean(book.title, 180), author: clean(authors.slice(0, 3).join(", "), 160), genre: clean(subjects[0], 80), language: preferredLanguage, isbn: clean(isbns.find(value => String(value).length === 13) || isbns[0], 20), cover: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : "" };
    }).filter(item => item.title && item.author && ONLINE_SEARCH_LANGUAGES.has(item.language)));
    return json({ items });
  } catch { return json({ items: [] }); }
}

async function createRequest(request: Request, env: LibraryEnv) {
  const member = await sessionMember(request, env);
  if (!member || member.status !== "active") return json({ error: "Verified library membership required." }, 401);
  let body: { titleId?: string };
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const titleId = clean(body.titleId, 50);
  const title = await env.DB.prepare("SELECT id,title FROM library_titles WHERE id=?").bind(titleId).first<{ id: string; title: string }>();
  if (!title) return json({ error: "Book not found." }, 404);
  const existing = await env.DB.prepare("SELECT id FROM library_requests WHERE title_id=? AND requester_member_id=? AND status IN ('pending','waitlisted','approved')").bind(titleId, member.id).first();
  if (existing) return json({ error: "You already have an active request for this title." }, 409);
  const loanCount = await env.DB.prepare("SELECT COUNT(*) count FROM library_loans WHERE borrower_member_id=? AND status='active'").bind(member.id).first<{ count: number }>();
  if (Number(loanCount?.count || 0) >= 2) return json({ error: "Please return one of your current books before requesting another." }, 409);
  const copy = await env.DB.prepare(`SELECT c.id,m.display_name owner_name,m.mobile_number owner_mobile FROM library_copies c JOIN library_members m ON m.id=c.owner_member_id
    WHERE c.title_id=? AND c.status='available' AND c.withdrawn_at IS NULL AND c.owner_member_id!=? AND m.status='active'
      AND NOT EXISTS (SELECT 1 FROM library_requests waiting WHERE waiting.title_id=? AND waiting.status='waitlisted')
    ORDER BY c.created_at LIMIT 1`).bind(titleId, member.id, titleId).first<{ id: string; owner_name: string; owner_mobile: string }>();
  const requestId = id(), status = copy ? "pending" : "waitlisted";
  const statements = [
    env.DB.prepare("INSERT INTO library_requests (id,title_id,copy_id,requester_member_id,status) VALUES (?,?,?,?,?)").bind(requestId, titleId, copy?.id || null, member.id, status),
    env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor,after_json) VALUES ('library_request',?,'created',?,?)").bind(requestId, member.id, JSON.stringify({ titleId, status, copyId: copy?.id || null }))
  ];
  if (copy) statements.push(env.DB.prepare("UPDATE library_copies SET status='reserved',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='available'").bind(copy.id));
  await env.DB.batch(statements);
  const notifyOwnerUrl = copy ? whatsappLink(copy.owner_mobile, `Hi ${copy.owner_name}, I am ${member.display_name} from ${member.block_no}-${member.flat_no}. I have requested "${title.title}" through Skyrena Community Library. Please review it under My Library > Incoming.`) : null;
  return json({ ok: true, message: copy ? "Book request recorded." : "All copies are in use. You have joined the waiting list.", notifyOwnerUrl });
}

export async function expireLibraryReservations(env: LibraryEnv) {
  const expired = await env.DB.prepare(`SELECT id,title_id,copy_id FROM library_requests
    WHERE status='approved' AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at<=CURRENT_TIMESTAMP
    ORDER BY reservation_expires_at LIMIT 50`).all<Record<string, unknown>>();
  let released = 0;
  for (const row of expired.results) {
    const requestResult = await env.DB.prepare(`UPDATE library_requests
      SET status='cancelled',reservation_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='approved' AND reservation_expires_at<=CURRENT_TIMESTAMP`).bind(row.id).run();
    if (!requestResult.meta.changes) continue;
    await env.DB.prepare("UPDATE library_copies SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='reserved'").bind(row.copy_id).run();
    await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor,after_json) VALUES ('library_request',?,'reservation_expired','scheduled-job',?)")
      .bind(row.id, JSON.stringify({ copyId: row.copy_id })).run();
    released++;
  }
  return released;
}

async function requestAction(request: Request, env: LibraryEnv, requestId: string) {
  const member = await sessionMember(request, env);
  if (!member || member.status !== "active") return redirect(request, "/library/login?error=Please+sign+in.");
  const form = await request.formData();
  const action = formValue(form, "action", 20);
  const row = await env.DB.prepare(`SELECT r.*,c.owner_member_id,c.status copy_status,t.title
    FROM library_requests r JOIN library_titles t ON t.id=r.title_id LEFT JOIN library_copies c ON c.id=r.copy_id WHERE r.id=?`).bind(requestId).first<Record<string, unknown>>();
  if (!row) return redirect(request, "/library/dashboard?error=Request+not+found.");
  const isOwner = row.owner_member_id === member.id, isRequester = row.requester_member_id === member.id;
  if (action === "choose-reader" && row.status === "waitlisted") {
    const copyId = formValue(form, "copyId", 50);
    const copy = await env.DB.prepare(`SELECT id FROM library_copies
      WHERE id=? AND owner_member_id=? AND title_id=? AND status='available' AND withdrawn_at IS NULL`)
      .bind(copyId, member.id, row.title_id).first<{ id: string }>();
    if (!copy) return redirect(request, "/library/dashboard?error=That+copy+is+no+longer+available.#incoming");
    const selection = await env.DB.batch([
      env.DB.prepare(`UPDATE library_requests SET copy_id=?,status='approved',reservation_expires_at=datetime('now', ?),reservation_extensions=0,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='waitlisted' AND EXISTS (SELECT 1 FROM library_copies available
          WHERE available.id=? AND available.owner_member_id=? AND available.status='available' AND available.withdrawn_at IS NULL)`)
        .bind(copy.id, `+${RESERVATION_HOURS} hours`, requestId, copy.id, member.id),
      env.DB.prepare(`UPDATE library_copies SET status='reserved',updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='available' AND EXISTS (SELECT 1 FROM library_requests selected
          WHERE selected.id=? AND selected.status='approved' AND selected.copy_id=library_copies.id)`).bind(copy.id, requestId),
      env.DB.prepare(`INSERT INTO audit_log (entity_type,entity_id,action,actor,after_json)
        SELECT 'library_request',?,'reader_selected',?,? WHERE EXISTS
          (SELECT 1 FROM library_requests selected WHERE selected.id=? AND selected.status='approved' AND selected.copy_id=?)`)
        .bind(requestId, member.id, JSON.stringify({ copyId: copy.id, reservationHours: RESERVATION_HOURS }), requestId, copy.id)
    ]);
    if (!selection[0].meta.changes) return redirect(request, "/library/dashboard?error=That+request+or+copy+is+no+longer+available.#incoming");
    return redirect(request, `/library/dashboard?success=Reader+selected.+The+book+is+reserved+for+${RESERVATION_HOURS}+hours.#incoming`);
  }
  if (action === "cancel" && isRequester && ["pending","waitlisted","approved"].includes(String(row.status))) {
    const statements = [env.DB.prepare("UPDATE library_requests SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(requestId)];
    if (row.copy_id) statements.push(env.DB.prepare("UPDATE library_copies SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.copy_id));
    await env.DB.batch(statements);
    return redirect(request, "/library/dashboard?success=Request+cancelled.#requests");
  }
  if (action === "approve" && isOwner && row.status === "pending" && row.copy_status === "reserved") {
    await env.DB.batch([
      env.DB.prepare("UPDATE library_requests SET status='approved',reservation_expires_at=datetime('now', ?),reservation_extensions=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(`+${RESERVATION_HOURS} hours`, requestId),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor) VALUES ('library_request',?,'approved',?)").bind(requestId, member.id)
    ]);
    return redirect(request, `/library/dashboard?success=Request+accepted.+The+book+is+reserved+for+${RESERVATION_HOURS}+hours.#incoming`);
  }
  if (action === "extend" && isOwner && row.status === "approved" && row.copy_status === "reserved" && Number(row.reservation_extensions || 0) < 1) {
    await env.DB.batch([
      env.DB.prepare("UPDATE library_requests SET reservation_expires_at=datetime(MAX(reservation_expires_at,CURRENT_TIMESTAMP), ?),reservation_extensions=reservation_extensions+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='approved' AND reservation_extensions<1").bind(`+${RESERVATION_EXTENSION_HOURS} hours`, requestId),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor,after_json) VALUES ('library_request',?,'reservation_extended',?,?)").bind(requestId, member.id, JSON.stringify({ hours: RESERVATION_EXTENSION_HOURS }))
    ]);
    return redirect(request, `/library/dashboard?success=Reservation+extended+by+${RESERVATION_EXTENSION_HOURS}+hours.#incoming`);
  }
  if (action === "decline" && isOwner && row.status === "pending") {
    await env.DB.batch([
      env.DB.prepare("UPDATE library_requests SET status='declined',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(requestId),
      env.DB.prepare("UPDATE library_copies SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='reserved'").bind(row.copy_id),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor) VALUES ('library_request',?,'declined',?)").bind(requestId, member.id)
    ]);
    return redirect(request, "/library/dashboard?success=Request+declined.#incoming");
  }
  if (action === "handover" && isOwner && row.status === "approved" && row.copy_status === "reserved") {
    const due = new Date(Date.now() + LOAN_DAYS * 86400000).toISOString().slice(0, 19).replace("T", " ");
    const loanId = id();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO library_loans (id,copy_id,request_id,owner_member_id,borrower_member_id,due_at) VALUES (?,?,?,?,?,?)").bind(loanId, row.copy_id, requestId, member.id, row.requester_member_id, due),
      env.DB.prepare("UPDATE library_requests SET status='fulfilled',reservation_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(requestId),
      env.DB.prepare("UPDATE library_copies SET status='borrowed',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.copy_id),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor,after_json) VALUES ('library_loan',?,'borrowed',?,?)").bind(loanId, member.id, JSON.stringify({ dueAt: due, requestId }))
    ]);
    return redirect(request, `/library/dashboard?success=Handover+confirmed.+The+book+is+due+in+${LOAN_DAYS}+days.#shelf`);
  }
  return redirect(request, "/library/dashboard?error=That+action+is+not+available.");
}

async function copyAction(request: Request, env: LibraryEnv, copyId: string) {
  const member = await sessionMember(request, env);
  if (!member || member.status !== "active") return redirect(request, "/library/login?error=Please+sign+in.");
  const form = await request.formData();
  const action = formValue(form, "action", 20);
  const copy = await env.DB.prepare("SELECT id,title_id,status FROM library_copies WHERE id=? AND owner_member_id=? AND withdrawn_at IS NULL").bind(copyId, member.id).first<Record<string, unknown>>();
  if (!copy) return redirect(request, "/library/dashboard?error=Book+copy+not+found.");
  if (action === "pause" && copy.status === "available") await env.DB.prepare("UPDATE library_copies SET status='unavailable',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(copyId).run();
  else if (action === "resume" && copy.status === "unavailable") {
    await env.DB.prepare("UPDATE library_copies SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(copyId).run();
  } else if (action === "return" && copy.status === "borrowed") {
    const loan = await env.DB.prepare("SELECT id FROM library_loans WHERE copy_id=? AND status='active'").bind(copyId).first<{ id: string }>();
    if (!loan) return redirect(request, "/library/dashboard?error=Active+loan+not+found.");
    await env.DB.batch([
      env.DB.prepare("UPDATE library_loans SET status='returned',returned_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(loan.id),
      env.DB.prepare("UPDATE library_copies SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(copyId),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor) VALUES ('library_loan',?,'returned',?)").bind(loan.id, member.id)
    ]);
    return redirect(request, "/library/dashboard?success=Return+confirmed.+The+book+is+available+again.#shelf");
  } else if (action === "remove" && (copy.status === "available" || copy.status === "unavailable")) {
    await env.DB.batch([
      env.DB.prepare("UPDATE library_copies SET status='unavailable',withdrawn_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND withdrawn_at IS NULL").bind(copyId),
      env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor) VALUES ('library_copy',?,'withdrawn',?)").bind(copyId, member.id)
    ]);
    return redirect(request, "/library/dashboard?success=Book+removed+from+your+shelf+and+the+catalogue.#shelf");
  } else return redirect(request, "/library/dashboard?error=That+action+is+not+available.");
  return redirect(request, "/library/dashboard?success=Book+availability+updated.#shelf");
}

async function adminPage(request: Request, env: LibraryEnv) {
  if (!isAdmin(request, env)) return new Response("Administrator login required.", { status: 401, headers: { "www-authenticate": 'Basic realm="Skyrena Library Admin"' } });
  const [membersResult, loansResult, requestsResult, countsResult] = await env.DB.batch([
    env.DB.prepare("SELECT id,display_name,block_no,flat_no,mobile_number,status,created_at FROM library_members ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 300"),
    env.DB.prepare(`SELECT l.id,l.due_at,l.borrowed_at,t.title,o.display_name owner_name,b.display_name borrower_name,b.block_no,b.flat_no,b.mobile_number,
      (SELECT MAX(a.created_at) FROM audit_log a WHERE a.entity_type='library_loan' AND a.entity_id=l.id AND a.action='reminder_sent') last_reminder_at,
      (SELECT COUNT(*) FROM audit_log a WHERE a.entity_type='library_loan' AND a.entity_id=l.id AND a.action='reminder_sent') reminder_count
      FROM library_loans l JOIN library_copies c ON c.id=l.copy_id JOIN library_titles t ON t.id=c.title_id
      JOIN library_members o ON o.id=l.owner_member_id JOIN library_members b ON b.id=l.borrower_member_id
      WHERE l.status='active' ORDER BY l.due_at`),
    env.DB.prepare(`SELECT r.id,r.status,r.created_at,r.reservation_expires_at,t.title,m.display_name,m.block_no,m.flat_no
      FROM library_requests r JOIN library_titles t ON t.id=r.title_id JOIN library_members m ON m.id=r.requester_member_id
      WHERE r.status IN ('pending','waitlisted','approved') ORDER BY r.created_at`),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM library_members WHERE status='active') members,
      (SELECT COUNT(*) FROM library_copies WHERE withdrawn_at IS NULL) copies,
      (SELECT COUNT(*) FROM library_loans WHERE status='active') loans,
      (SELECT COUNT(*) FROM library_requests WHERE status='waitlisted') waiting`)
  ]);
  const members = membersResult.results as Array<Record<string, unknown>>, loans = loansResult.results as Array<Record<string, unknown>>, requests = requestsResult.results as Array<Record<string, unknown>>;
  const counts = (countsResult.results[0] || {}) as Record<string, unknown>;
  const reminderLoans = loans.filter(row => loanTiming(row.due_at).key !== "upcoming");
  const reminderCounts = reminderLoans.reduce((totals, row) => { totals[loanTiming(row.due_at).key]++; return totals; }, { soon: 0, today: 0, overdue: 0 } as Record<string, number>);
  const memberRows = members.map(row => `<tr><td data-label="Resident"><strong>${esc(row.display_name)}</strong><div class="help">${esc(row.mobile_number)}</div></td><td data-label="Home">Block ${esc(row.block_no)} · ${esc(row.flat_no)}</td><td data-label="Status"><span class="badge ${row.status === "active" ? "available" : row.status === "pending" ? "reserved" : "unavailable"}">${esc(row.status)}</span></td><td data-label="Action"><div class="actions">${row.status !== "active" ? `<form method="post" action="/api/library/admin/members/${esc(row.id)}"><input type="hidden" name="action" value="approve"><button class="button compact">Approve</button></form>` : `<form method="post" action="/api/library/admin/members/${esc(row.id)}"><input type="hidden" name="action" value="suspend"><button class="button-danger compact">Suspend</button></form>`}</div></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No member accounts.</td></tr>`;
  const loanRows = loans.map(row => {
    const timing = loanTiming(row.due_at);
    return `<tr><td data-label="Book"><strong>${esc(row.title)}</strong></td><td data-label="Owner">${esc(row.owner_name)}</td><td data-label="Borrower">${esc(row.borrower_name)}<div class="help">${esc(row.block_no)}-${esc(row.flat_no)} · ${esc(row.mobile_number)}</div></td><td data-label="Due"><span class="badge ${timing.key === "overdue" ? "overdue" : timing.key === "today" || timing.key === "soon" ? "reserved" : "borrowed"}">${esc(timing.label)}</span><div class="help">${formatDate(row.due_at)}</div></td><td data-label="Last reminder">${row.last_reminder_at ? `${formatDate(row.last_reminder_at, true)}<div class="help">${Number(row.reminder_count || 0)} sent</div>` : '<span class="help">Not sent</span>'}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">No active loans.</td></tr>`;
  const reminderRows = reminderLoans.map(row => {
    const timing = loanTiming(row.due_at);
    const reminder = timing.key === "overdue"
      ? `Hi ${row.borrower_name}, a friendly reminder that "${row.title}" was due for return on ${formatDate(row.due_at)}. Please arrange to return it to ${row.owner_name} at the earliest. Thank you.`
      : timing.key === "today"
        ? `Hi ${row.borrower_name}, a friendly reminder that "${row.title}" is due for return today. Please return it to ${row.owner_name}. Thank you.`
        : `Hi ${row.borrower_name}, a friendly reminder that "${row.title}" is due for return on ${formatDate(row.due_at)}. Please return it to ${row.owner_name} by the due date. Thank you.`;
    return `<tr><td data-label="Priority"><span class="badge ${timing.key === "overdue" ? "overdue" : "reserved"}">${esc(timing.label)}</span></td><td data-label="Book"><strong>${esc(row.title)}</strong><div class="help">Due ${formatDate(row.due_at)}</div></td><td data-label="Borrower">${esc(row.borrower_name)}<div class="help">${esc(row.block_no)}-${esc(row.flat_no)} · ${esc(row.mobile_number)}</div></td><td data-label="Reminder history">${row.last_reminder_at ? `Last recorded ${formatDate(row.last_reminder_at, true)}<div class="help">${Number(row.reminder_count || 0)} reminder${Number(row.reminder_count || 0) === 1 ? "" : "s"}</div>` : '<span class="help">No reminder recorded</span>'}</td><td data-label="Action"><div class="actions"><a class="button compact" target="_blank" rel="noopener" href="${whatsappLink(row.mobile_number, reminder)}">Open WhatsApp</a><form method="post" action="/api/library/admin/loans/${esc(row.id)}/reminder"><button class="button-secondary compact">Mark sent</button></form></div></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">No reminders are due. Loans enter this queue two days before their return date.</td></tr>`;
  const requestRows = requests.map(row => `<tr><td data-label="Book">${esc(row.title)}</td><td data-label="Reader">${esc(row.display_name)} · ${esc(row.block_no)}-${esc(row.flat_no)}</td><td data-label="Status"><span class="badge ${row.status === "approved" ? "reserved" : "available"}">${requestStatus(row.status)}</span>${row.status === "approved" && row.reservation_expires_at ? `<div class="help">Until ${formatDate(row.reservation_expires_at, true)}</div>` : ""}</td><td data-label="Date">${formatDate(row.created_at, true)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No open requests.</td></tr>`;
  const body = `<main class="wrap"><div class="eyebrow">Library administration</div><h1>Community Library Console</h1><section class="stats"><div class="card stat"><strong>${Number(counts.members || 0)}</strong><span>Active members</span></div><div class="card stat"><strong>${Number(counts.copies || 0)}</strong><span>Book copies</span></div><div class="card stat"><strong>${Number(counts.loans || 0)}</strong><span>Active loans</span></div><div class="card stat"><strong>${Number(counts.waiting || 0)}</strong><span>Waiting</span></div></section>
  <section class="section panel" id="reminders"><div class="eyebrow">Return follow-up</div><h2 class="section-title">Reminder queue</h2><p class="help">Open the prepared WhatsApp message, send it, then return here and mark it as sent.</p><div class="actions" style="margin-bottom:14px"><span class="badge reserved">${reminderCounts.soon} due soon</span><span class="badge reserved">${reminderCounts.today} due today</span><span class="badge overdue">${reminderCounts.overdue} overdue</span></div><div class="table-wrap"><table class="responsive"><thead><tr><th>Priority</th><th>Book</th><th>Borrower</th><th>History</th><th>Action</th></tr></thead><tbody>${reminderRows}</tbody></table></div></section>
  <section class="section panel"><h2 class="section-title">Members</h2><div class="table-wrap"><table class="responsive"><thead><tr><th>Resident</th><th>Home</th><th>Status</th><th>Action</th></tr></thead><tbody>${memberRows}</tbody></table></div></section>
  <section class="section panel"><h2 class="section-title">Active loans</h2><div class="table-wrap"><table class="responsive"><thead><tr><th>Book</th><th>Owner</th><th>Borrower</th><th>Due</th><th>Last reminder</th></tr></thead><tbody>${loanRows}</tbody></table></div></section>
  <section class="section panel"><h2 class="section-title">Open requests and waiting list</h2><div class="table-wrap"><table class="responsive"><thead><tr><th>Book</th><th>Reader</th><th>Status</th><th>Date</th></tr></thead><tbody>${requestRows}</tbody></table></div></section></main>`;
  return html(page("Library administration", body, undefined, "", true));
}

async function adminMemberAction(request: Request, env: LibraryEnv, memberId: string) {
  if (!isAdmin(request, env)) return new Response("Administrator login required.", { status: 401, headers: { "www-authenticate": 'Basic realm="Skyrena Library Admin"' } });
  const form = await request.formData(), action = formValue(form, "action", 20);
  if (!['approve','suspend'].includes(action)) return redirect(request, "/library/admin");
  const status = action === "approve" ? "active" : "suspended";
  await env.DB.batch([
    env.DB.prepare("UPDATE library_members SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, memberId),
    env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor) VALUES ('library_member',?,?,'admin')").bind(memberId, action)
  ]);
  if (status === "suspended") await env.DB.prepare("UPDATE library_copies SET status='unavailable',updated_at=CURRENT_TIMESTAMP WHERE owner_member_id=? AND status='available'").bind(memberId).run();
  return redirect(request, "/library/admin");
}

async function adminReminderAction(request: Request, env: LibraryEnv, loanId: string) {
  if (!isAdmin(request, env)) return new Response("Administrator login required.", { status: 401, headers: { "www-authenticate": 'Basic realm="Skyrena Library Admin"' } });
  const loan = await env.DB.prepare("SELECT id FROM library_loans WHERE id=? AND status='active'").bind(loanId).first<{ id: string }>();
  if (!loan) return redirect(request, "/library/admin?error=Active+loan+not+found.#reminders");
  await env.DB.prepare("INSERT INTO audit_log (entity_type,entity_id,action,actor) VALUES ('library_loan',?,'reminder_sent','admin')").bind(loanId).run();
  return redirect(request, "/library/admin?success=WhatsApp+reminder+recorded.#reminders");
}

export async function handleLibrary(request: Request, env: LibraryEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/";
  if (!(path === "/library" || path.startsWith("/library/") || path.startsWith("/api/library/"))) return null;
  if (request.method === "GET" && path === "/library") return cataloguePage(request, env);
  if (request.method === "GET" && path === "/library/join") return joinPage(request, env);
  if (request.method === "POST" && path === "/library/join") return join(request, env);
  if (request.method === "GET" && path === "/library/login") return loginPage(request, env);
  if (request.method === "POST" && path === "/library/login") return login(request, env);
  if (request.method === "GET" && path === "/library/logout") return logout(request);
  if (request.method === "GET" && path === "/library/dashboard") return dashboardPage(request, env);
  if (request.method === "GET" && path === "/library/admin") return adminPage(request, env);
  if (request.method === "GET" && path === "/api/library/metadata") return metadataSearch(request);
  if (request.method === "POST" && path === "/api/library/books") return addBooks(request, env);
  if (request.method === "POST" && path === "/api/library/requests") return createRequest(request, env);
  const requestMatch = path.match(/^\/api\/library\/requests\/([^/]+)\/action$/);
  if (request.method === "POST" && requestMatch) return requestAction(request, env, decodeURIComponent(requestMatch[1]));
  const copyMatch = path.match(/^\/api\/library\/copies\/([^/]+)\/action$/);
  if (request.method === "POST" && copyMatch) return copyAction(request, env, decodeURIComponent(copyMatch[1]));
  const memberMatch = path.match(/^\/api\/library\/admin\/members\/([^/]+)$/);
  if (request.method === "POST" && memberMatch) return adminMemberAction(request, env, decodeURIComponent(memberMatch[1]));
  const reminderMatch = path.match(/^\/api\/library\/admin\/loans\/([^/]+)\/reminder$/);
  if (request.method === "POST" && reminderMatch) return adminReminderAction(request, env, decodeURIComponent(reminderMatch[1]));
  return new Response("Not found", { status: 404 });
}
