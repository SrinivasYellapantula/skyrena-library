PRAGMA foreign_keys = ON;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE library_members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  block_no TEXT NOT NULL CHECK (block_no IN ('A','B','C','D','E')),
  flat_no TEXT NOT NULL,
  mobile_number TEXT NOT NULL UNIQUE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE library_titles (
  id TEXT PRIMARY KEY,
  catalogue_key TEXT NOT NULL UNIQUE,
  isbn TEXT,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  genre TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'English',
  cover_url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE library_copies (
  id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL REFERENCES library_titles(id) ON DELETE RESTRICT,
  owner_member_id TEXT NOT NULL REFERENCES library_members(id) ON DELETE RESTRICT,
  condition_label TEXT NOT NULL DEFAULT 'Good',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','borrowed','unavailable')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at TEXT
);

CREATE TABLE library_requests (
  id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL REFERENCES library_titles(id) ON DELETE RESTRICT,
  copy_id TEXT REFERENCES library_copies(id) ON DELETE SET NULL,
  requester_member_id TEXT NOT NULL REFERENCES library_members(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waitlisted','approved','declined','cancelled','fulfilled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reservation_expires_at TEXT,
  reservation_extensions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE library_loans (
  id TEXT PRIMARY KEY,
  copy_id TEXT NOT NULL REFERENCES library_copies(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL REFERENCES library_requests(id) ON DELETE RESTRICT,
  owner_member_id TEXT NOT NULL REFERENCES library_members(id) ON DELETE RESTRICT,
  borrower_member_id TEXT NOT NULL REFERENCES library_members(id) ON DELETE RESTRICT,
  borrowed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at TEXT NOT NULL,
  returned_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE library_metrics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  titles INTEGER NOT NULL DEFAULT 0,
  copies INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0,
  active_members INTEGER NOT NULL DEFAULT 0
);

INSERT INTO library_metrics (id) VALUES (1);

CREATE INDEX idx_library_members_status ON library_members(status, block_no, flat_no);
CREATE INDEX idx_library_titles_browse ON library_titles(genre, author, title);
CREATE INDEX idx_library_copies_title_status ON library_copies(title_id, status);
CREATE INDEX idx_library_copies_owner ON library_copies(owner_member_id, status);
CREATE INDEX idx_library_copies_active_catalogue ON library_copies(title_id, status, withdrawn_at, owner_member_id);
CREATE INDEX idx_library_requests_title_status ON library_requests(title_id, status, created_at);
CREATE INDEX idx_library_requests_requester ON library_requests(requester_member_id, status, created_at DESC);
CREATE INDEX idx_library_loans_borrower ON library_loans(borrower_member_id, status, due_at);
CREATE INDEX idx_library_loans_owner ON library_loans(owner_member_id, status, due_at);
CREATE INDEX idx_audit_entity_action_created ON audit_log(entity_type, entity_id, action, created_at DESC);
CREATE INDEX idx_library_reservation_expiry ON library_requests(status, reservation_expires_at) WHERE status = 'approved';

CREATE UNIQUE INDEX idx_library_one_open_request ON library_requests(title_id, requester_member_id)
  WHERE status IN ('pending','waitlisted','approved');
CREATE UNIQUE INDEX idx_library_one_active_loan_per_copy ON library_loans(copy_id) WHERE status = 'active';

CREATE TRIGGER library_metrics_copy_insert AFTER INSERT ON library_copies
WHEN NEW.withdrawn_at IS NULL
BEGIN
  UPDATE library_metrics SET
    titles = titles + CASE WHEN (SELECT COUNT(*) FROM library_copies WHERE title_id = NEW.title_id AND withdrawn_at IS NULL) = 1 THEN 1 ELSE 0 END,
    copies = copies + 1,
    available = available + CASE WHEN NEW.status = 'available' THEN 1 ELSE 0 END
  WHERE id = 1;
END;

CREATE TRIGGER library_metrics_copy_delete AFTER DELETE ON library_copies
WHEN OLD.withdrawn_at IS NULL
BEGIN
  UPDATE library_metrics SET
    titles = MAX(0, titles - CASE WHEN (SELECT COUNT(*) FROM library_copies WHERE title_id = OLD.title_id AND withdrawn_at IS NULL) = 0 THEN 1 ELSE 0 END),
    copies = MAX(0, copies - 1),
    available = MAX(0, available - CASE WHEN OLD.status = 'available' THEN 1 ELSE 0 END)
  WHERE id = 1;
END;

CREATE TRIGGER library_metrics_copy_status AFTER UPDATE OF status ON library_copies
WHEN OLD.status <> NEW.status AND OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NULL
BEGIN
  UPDATE library_metrics SET available = MAX(0, available
    - CASE WHEN OLD.status = 'available' THEN 1 ELSE 0 END
    + CASE WHEN NEW.status = 'available' THEN 1 ELSE 0 END)
  WHERE id = 1;
END;

CREATE TRIGGER library_metrics_copy_withdrawal AFTER UPDATE OF withdrawn_at ON library_copies
WHEN (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL)
  OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NULL)
BEGIN
  UPDATE library_metrics SET
    titles = MAX(0, titles
      - CASE WHEN OLD.withdrawn_at IS NULL AND (SELECT COUNT(*) FROM library_copies WHERE title_id = NEW.title_id AND withdrawn_at IS NULL) = 0 THEN 1 ELSE 0 END
      + CASE WHEN OLD.withdrawn_at IS NOT NULL AND (SELECT COUNT(*) FROM library_copies WHERE title_id = NEW.title_id AND withdrawn_at IS NULL) = 1 THEN 1 ELSE 0 END),
    copies = MAX(0, copies + CASE WHEN OLD.withdrawn_at IS NULL THEN -1 ELSE 1 END),
    available = MAX(0, available
      - CASE WHEN OLD.withdrawn_at IS NULL AND OLD.status = 'available' THEN 1 ELSE 0 END
      + CASE WHEN OLD.withdrawn_at IS NOT NULL AND NEW.status = 'available' THEN 1 ELSE 0 END)
  WHERE id = 1;
END;

CREATE TRIGGER library_metrics_member_insert AFTER INSERT ON library_members
BEGIN UPDATE library_metrics SET active_members = active_members + CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END WHERE id = 1; END;
CREATE TRIGGER library_metrics_member_delete AFTER DELETE ON library_members
BEGIN UPDATE library_metrics SET active_members = MAX(0, active_members - CASE WHEN OLD.status = 'active' THEN 1 ELSE 0 END) WHERE id = 1; END;
CREATE TRIGGER library_metrics_member_status AFTER UPDATE OF status ON library_members
WHEN OLD.status <> NEW.status
BEGIN
  UPDATE library_metrics SET active_members = MAX(0, active_members
    - CASE WHEN OLD.status = 'active' THEN 1 ELSE 0 END
    + CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END) WHERE id = 1;
END;
