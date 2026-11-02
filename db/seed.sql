-- QueryLens seed data (generated, deterministic)
SET search_path TO library;
SELECT setseed(0.42);

INSERT INTO categories (name) VALUES
 ('Fiction'),('Science'),('History'),('Biography'),('Technology'),('Philosophy'),
 ('Poetry'),('Mystery'),('Fantasy'),('Business'),('Art'),('Travel');

-- 300 authors
INSERT INTO authors (full_name, country, birth_year)
SELECT
  (ARRAY['Ayesha','Omar','Lena','Hiro','Maria','Ivan','Sara','Kofi','Elena','Ravi','Noah','Zara','Diego','Mei','Tom'])[1 + floor(random()*15)::int]
  || ' ' ||
  (ARRAY['Khan','Smith','Tanaka','Garcia','Petrov','Mensah','Rossi','Patel','Chen','Müller','Silva','Novak','Ali','Brown','Dubois'])[1 + floor(random()*15)::int],
  (ARRAY['Pakistan','USA','Japan','Spain','Russia','Ghana','Italy','India','China','Germany','Brazil','France','UK'])[1 + floor(random()*13)::int],
  1900 + floor(random()*100)::int
FROM generate_series(1, 300);

-- 2,000 books
INSERT INTO books (title, isbn, category_id, published_year, total_copies, available_copies, price)
SELECT
  (ARRAY['The','A','Beyond','Under','Silent','Lost','Hidden','Last','First','Broken'])[1 + floor(random()*10)::int] || ' ' ||
  (ARRAY['River','Empire','Algorithm','Garden','Mind','Ocean','City','Code','Star','Mountain','Kingdom','Signal'])[1 + floor(random()*12)::int] || ' ' ||
  (ARRAY['Chronicles','of Time','Theory','Diaries','Rising','in Winter','Paradox','Manual','Legacy','Atlas'])[1 + floor(random()*10)::int],
  '978' || lpad(g::text, 10, '0'),
  1 + floor(random()*12)::int,
  1950 + floor(random()*75)::int,
  c, c,
  round((5 + random()*45)::numeric, 2)
FROM generate_series(1, 2000) g,
LATERAL (SELECT 2 + floor(random()*6)::int + (g*0) AS c) cc;

-- 1-2 authors per book
INSERT INTO book_authors (book_id, author_id)
SELECT b.book_id, 1 + floor(random()*300)::int FROM books b
ON CONFLICT DO NOTHING;
INSERT INTO book_authors (book_id, author_id)
SELECT b.book_id, 1 + floor(random()*300)::int FROM books b WHERE random() < 0.3
ON CONFLICT DO NOTHING;

-- 5,000 members
INSERT INTO members (full_name, email, city, joined_on, tier)
SELECT
  (ARRAY['Ali','Fatima','John','Aisha','Chen','Priya','Luca','Emma','Yusuf','Hana','Bilal','Sofia'])[1 + floor(random()*12)::int]
  || ' ' ||
  (ARRAY['Ahmed','Lee','Kumar','Rossi','Hassan','Jones','Wang','Iqbal','Martin','Kim'])[1 + floor(random()*10)::int],
  'member' || g || '@example.com',
  (ARRAY['Lahore','Karachi','Islamabad','London','Toronto','Dubai','Berlin','Tokyo','New York','Sydney'])[1 + floor(random()*10)::int],
  DATE '2018-01-01' + floor(random()*2800)::int,
  (ARRAY['basic','basic','basic','silver','silver','gold'])[1 + floor(random()*6)::int]
FROM generate_series(1, 5000) g;

-- 200,000 loans (big enough that indexes visibly matter)
INSERT INTO loans (book_id, member_id, loaned_on, due_on, returned_on)
SELECT book_id, member_id, d, d + 14,
       CASE WHEN d > CURRENT_DATE - 30 AND random() < 0.6 THEN NULL
            WHEN random() < 0.02 THEN NULL
            ELSE d + floor(random()*25)::int END
FROM (
  SELECT 1 + floor(random()*2000)::int AS book_id,
         1 + floor(random()*5000)::int AS member_id,
         CURRENT_DATE - floor(random()*1500)::int AS d
  FROM generate_series(1, 200000)
) s;

-- Fines for returned late loans
UPDATE loans SET fine = LEAST((returned_on - due_on) * 0.50, 25)
WHERE returned_on > due_on;

-- Make available_copies consistent with open loans (never below 0)
UPDATE books b SET available_copies = GREATEST(b.total_copies - COALESCE(o.open_loans, 0), 0)
FROM (SELECT book_id, count(*) AS open_loans FROM loans WHERE returned_on IS NULL GROUP BY book_id) o
WHERE o.book_id = b.book_id;

-- Attach the trigger after bulk loading
CREATE TRIGGER loans_copies
AFTER INSERT OR UPDATE OF returned_on ON loans
FOR EACH ROW EXECUTE FUNCTION trg_loan_copies();

-- Materialized view: most borrowed books per category
CREATE MATERIALIZED VIEW popular_books AS
SELECT c.name AS category, b.book_id, b.title, count(l.loan_id) AS times_borrowed,
       rank() OVER (PARTITION BY c.category_id ORDER BY count(l.loan_id) DESC) AS rank_in_category
FROM books b
JOIN categories c ON c.category_id = b.category_id
LEFT JOIN loans l ON l.book_id = b.book_id
GROUP BY c.category_id, c.name, b.book_id, b.title;

ANALYZE;
