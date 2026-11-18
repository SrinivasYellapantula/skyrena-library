-- Abort the migration if existing data already violates the new invariant.
-- The guard table is removed immediately and is never part of the final schema.
DROP TABLE IF EXISTS _library_loan_limit_guard;
CREATE TABLE _library_loan_limit_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO _library_loan_limit_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM library_loans
  WHERE status = 'active'
  GROUP BY borrower_member_id
  HAVING COUNT(*) > 2
) THEN 0 ELSE 1 END;
DROP TABLE _library_loan_limit_guard;

-- Enforce at database level: no borrower may have more than two active loans.
CREATE TRIGGER IF NOT EXISTS trg_library_loans_max_two_active
BEFORE INSERT ON library_loans
WHEN NEW.status = 'active'
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM library_loans
      WHERE borrower_member_id = NEW.borrower_member_id
        AND status = 'active'
    ) >= 2
    THEN RAISE(ABORT, 'MAX_ACTIVE_LOANS_EXCEEDED')
  END;
END;

-- Also protect reactivating a returned loan or moving an active loan to a
-- different borrower. Exclude the row currently being updated from the count.
CREATE TRIGGER IF NOT EXISTS trg_library_loans_max_two_active_on_update
BEFORE UPDATE OF status, borrower_member_id ON library_loans
WHEN NEW.status = 'active'
  AND (
    OLD.status <> 'active'
    OR NEW.borrower_member_id <> OLD.borrower_member_id
  )
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM library_loans
      WHERE borrower_member_id = NEW.borrower_member_id
        AND status = 'active'
        AND id <> OLD.id
    ) >= 2
    THEN RAISE(ABORT, 'MAX_ACTIVE_LOANS_EXCEEDED')
  END;
END;
