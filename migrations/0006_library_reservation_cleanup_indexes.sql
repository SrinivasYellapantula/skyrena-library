CREATE INDEX IF NOT EXISTS idx_library_requests_copy_status
  ON library_requests(copy_id, status);

CREATE INDEX IF NOT EXISTS idx_library_reserved_copy_cleanup
  ON library_copies(updated_at)
  WHERE status='reserved' AND withdrawn_at IS NULL;
