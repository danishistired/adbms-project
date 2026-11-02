-- QueryLens: library management schema
-- Covers: constraints, foreign keys, indexes, a view, a materialized view,
-- a trigger, and a stored function.

DROP SCHEMA IF EXISTS library CASCADE;
CREATE SCHEMA library;
SET search_path TO library;

CREATE TABLE categories (
    category_id  SERIAL PRIMARY KEY,
    name         VARCHAR(60) NOT NULL UNIQUE
);

CREATE TABLE authors (
    author_id    SERIAL PRIMARY KEY,
    full_name    VARCHAR(120) NOT NULL,
    country      VARCHAR(60),
    birth_year   INT CHECK (birth_year BETWEEN 1500 AND 2025)
);

CREATE TABLE books (
    book_id          SERIAL PRIMARY KEY,
    title            VARCHAR(200) NOT NULL,
    isbn             CHAR(13) UNIQUE,
    category_id      INT NOT NULL REFERENCES categories(category_id),
    published_year   INT,
    total_copies     INT NOT NULL DEFAULT 3 CHECK (total_copies >= 0),
    available_copies INT NOT NULL DEFAULT 3 CHECK (available_copies >= 0),
    price            NUMERIC(8,2) NOT NULL
);

CREATE TABLE book_authors (
    book_id    INT REFERENCES books(book_id) ON DELETE CASCADE,
    author_id  INT REFERENCES authors(author_id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, author_id)
);

CREATE TABLE members (
    member_id   SERIAL PRIMARY KEY,
    full_name   VARCHAR(120) NOT NULL,
    email       VARCHAR(160) NOT NULL UNIQUE,
    city        VARCHAR(60),
    joined_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    tier        VARCHAR(10) NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic','silver','gold'))
);

CREATE TABLE loans (
    loan_id      SERIAL PRIMARY KEY,
    book_id      INT NOT NULL REFERENCES books(book_id),
    member_id    INT NOT NULL REFERENCES members(member_id),
    loaned_on    DATE NOT NULL,
    due_on       DATE NOT NULL,
    returned_on  DATE,
    fine         NUMERIC(6,2) NOT NULL DEFAULT 0
);
-- Note: loans.member_id, loans.book_id and loans.loaned_on are intentionally
-- NOT indexed, so the Index Lab can show the difference an index makes.

-- Query history kept by the app itself
CREATE TABLE query_log (
    log_id        SERIAL PRIMARY KEY,
    sql_text      TEXT NOT NULL,
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms   NUMERIC(10,3),
    row_count     INT,
    total_cost    NUMERIC(14,2),
    success       BOOLEAN NOT NULL,
    error_message TEXT
);

-- View: loans that are overdue right now
CREATE VIEW overdue_loans AS
SELECT l.loan_id, m.full_name AS member, b.title, l.loaned_on, l.due_on,
       CURRENT_DATE - l.due_on AS days_late
FROM loans l
JOIN members m ON m.member_id = l.member_id
JOIN books b   ON b.book_id   = l.book_id
WHERE l.returned_on IS NULL AND l.due_on < CURRENT_DATE;

-- Stored function: fine owed for a loan (0.50 per late day, capped at the book price)
CREATE FUNCTION calc_fine(p_loan_id INT) RETURNS NUMERIC AS $$
    SELECT LEAST(
        GREATEST(COALESCE(l.returned_on, CURRENT_DATE) - l.due_on, 0) * 0.50,
        b.price)
    FROM loans l JOIN books b ON b.book_id = l.book_id
    WHERE l.loan_id = p_loan_id;
$$ LANGUAGE sql STABLE;

-- Trigger: keep books.available_copies in sync with loans
CREATE FUNCTION trg_loan_copies() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.returned_on IS NULL THEN
        UPDATE books SET available_copies = available_copies - 1 WHERE book_id = NEW.book_id;
    ELSIF TG_OP = 'UPDATE' AND OLD.returned_on IS NULL AND NEW.returned_on IS NOT NULL THEN
        UPDATE books SET available_copies = available_copies + 1 WHERE book_id = NEW.book_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
