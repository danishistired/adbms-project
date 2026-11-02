# QueryLens

A PostgreSQL query visualizer built on a library-management database (ADBMS project).

## Features

- **SQL Console**: run any SQL. Each query's `EXPLAIN (ANALYZE, BUFFERS)` plan is drawn as a tree:
  - node colour shows the share of execution time spent in that node,
  - link thickness shows how many rows flow between nodes,
  - ⚠ marks nodes where the planner's row estimate was off by 10× or more,
  - click a node to see all its details with a plain-language explanation.
  Results appear as a table and an automatic bar chart.
- **Index Lab**: compare a query's plan before and after adding an index (B-tree, composite, partial,
  expression, covering). The comparison runs inside a transaction that is rolled back, so nothing changes.
  You can also create and drop indexes permanently and see how often each one is used.
- **Schema**: an ER diagram generated live from the PostgreSQL catalog, plus the views,
  materialized view, functions and triggers.
- **History**: every query is logged to the `query_log` table, with a chart of run times.

## Database design (schema `library`)

| Table          | Rows    | Notes                                           |
|----------------|---------|-------------------------------------------------|
| categories     | 12      |                                                 |
| authors        | 300     | CHECK on birth_year                             |
| books          | 2,000   | FK to categories, UNIQUE isbn, CHECK on copies  |
| book_authors   | ~2,600  | many-to-many join table                         |
| members        | 5,000   | UNIQUE email, CHECK on tier                     |
| loans          | 200,000 | FKs to books and members; no secondary indexes on purpose |
| query_log      | —       | the app's query history                         |

Other objects: `overdue_loans` (view), `popular_books` (materialized view with a window function),
`calc_fine()` (SQL function), `loans_copies` trigger (keeps `books.available_copies` in sync).

## Running it

Needs Node.js 18+ and PostgreSQL.

1. Copy `.env.example` to `.env` and fill in your PostgreSQL user and password.
2. Install packages and build the database (creates a `querylens` database):
   ```bash
   npm install
   npm run setup
   ```
3. Start the app and open http://localhost:3000:
   ```bash
   npm start
   ```

`npm run setup` can be re-run at any time to reset the data.
