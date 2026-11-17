-- Store resident-uploaded cover photos separately so catalogue queries remain small.
CREATE TABLE IF NOT EXISTS library_cover_images (
  title_id TEXT PRIMARY KEY REFERENCES library_titles(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  image_data BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
