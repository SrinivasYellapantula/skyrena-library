-- Support bounded, indexed pagination in resident and administrator lists.
CREATE INDEX IF NOT EXISTS idx_library_members_status_created
  ON library_members(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_requests_status_created
  ON library_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_loans_status_due
  ON library_loans(status, due_at);
