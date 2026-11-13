const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// The 7 default categories every user gets
const DEFAULT_CATEGORIES = [
  'Food',
  'Travel',
  'Shopping',
  'Bills',
  'Education',
  'Health',
  'Entertainment',
];
const DEFAULT_NAMES_LOWER = DEFAULT_CATEGORIES.map((n) => n.toLowerCase());
const DEFAULT_NAMES_SET = new Set(DEFAULT_NAMES_LOWER);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const MAX_NAME_LENGTH = 50;

// ---------- helpers ----------

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// A category is a "default" if its name is one of the 7 default names
// (upper/lower case ignored). No extra database column is needed.
function isDefaultName(name) {
  return DEFAULT_NAMES_SET.has(String(name).toLowerCase());
}

// Cleans and checks a category name. Returns { name } or { error }.
function parseName(value) {
  if (typeof value !== 'string') {
    return { error: 'name is required and must be text.' };
  }
  if (CONTROL_CHARS_REGEX.test(value)) {
    return { error: 'name contains invalid characters.' };
  }

  // Trim the ends and turn runs of spaces into a single space
  const name = value.trim().replace(/\s+/g, ' ');

  if (name.length < 1) {
    return { error: 'name cannot be empty.' };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `name must be at most ${MAX_NAME_LENGTH} characters.` };
  }
  return { name };
}

function readName(body) {
  // user_id in the body is never read. The user always comes from the token.
  const input =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return parseName(input.name);
}

// True if this user already has a category with the same name
// (ignoring upper/lower case, so "Food" and "food" count as the same)
async function nameTaken(userId, name, excludeId = null) {
  const result = await pool.query(
    `SELECT 1 FROM categories
     WHERE user_id = $1
       AND LOWER(name) = LOWER($2)
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,
    [userId, name, excludeId]
  );
  return result.rows.length > 0;
}

// Finds a category only if it belongs to this user
async function findOwnedCategory(id, userId) {
  const result = await pool.query(
    'SELECT id, name FROM categories WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0];
}

function sendValidationError(res, errors) {
  return res
    .status(400)
    .json({ status: 'error', message: 'Validation failed', errors });
}

function sendInvalidId(res) {
  return res
    .status(400)
    .json({ status: 'error', message: 'Invalid category id.' });
}

function sendNotFound(res) {
  return res
    .status(404)
    .json({ status: 'error', message: 'Category not found.' });
}

function sendDuplicate(res) {
  return res.status(409).json({
    status: 'error',
    message: 'You already have a category with that name.',
  });
}

function sendDefaultName(res) {
  return res.status(409).json({
    status: 'error',
    message: 'That name is already used by a default category.',
  });
}

function sendDefaultProtected(res, action) {
  return res.status(403).json({
    status: 'error',
    message: `Default categories cannot be ${action}.`,
  });
}

// Turns known PostgreSQL errors into friendly responses
function handleDbError(err, res, next) {
  switch (err.code) {
    case '23505': // unique violation (same user + same name)
      return sendDuplicate(res);
    case '23503': // foreign key violation (user no longer exists)
      return res.status(401).json({
        status: 'error',
        message: 'Your account no longer exists. Please log in again.',
      });
    case '22001': // text too long for the column
    case '22P02': // invalid input format
    case '23514': // check constraint failed
      return res.status(400).json({
        status: 'error',
        message: 'One of the values was rejected by the database.',
      });
    default:
      return next(err); // handled by the central error handler in index.js
  }
}

// Makes sure the logged-in user owns a copy of each default category.
// Safe to run many times: it only adds the ones that are missing.
async function ensureDefaultCategories(req, res, next) {
  try {
    await pool.query(
      `INSERT INTO categories (user_id, name)
       SELECT $1::uuid, d.name
       FROM unnest($2::text[]) AS d(name)
       WHERE NOT EXISTS (
         SELECT 1 FROM categories c
         WHERE c.user_id = $1::uuid AND LOWER(c.name) = LOWER(d.name)
       )
       ON CONFLICT DO NOTHING`,
      [req.user.id, DEFAULT_CATEGORIES]
    );
    return next();
  } catch (err) {
    return handleDbError(err, res, next);
  }
}

// Every route in this file requires a valid login token,
// and then makes sure the user's default categories exist
router.use(requireAuth);
router.use(ensureDefaultCategories);

// ---------- routes ----------

// GET /api/categories  -> my default + custom categories together
router.get('/', async (req, res, next) => {
  try {
    // Defaults first (A to Z), then custom ones (A to Z)
    const result = await pool.query(
      `SELECT id, name, (LOWER(name) = ANY($2::text[])) AS is_default
       FROM categories
       WHERE user_id = $1
       ORDER BY is_default DESC, LOWER(name), id`,
      [req.user.id, DEFAULT_NAMES_LOWER]
    );

    return res.json({
      status: 'ok',
      count: result.rows.length,
      categories: result.rows,
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// POST /api/categories  -> create a custom category
router.post('/', async (req, res, next) => {
  try {
    const { name, error } = readName(req.body);
    if (error) return sendValidationError(res, [error]);

    if (isDefaultName(name)) return sendDefaultName(res);
    if (await nameTaken(req.user.id, name)) return sendDuplicate(res);

    // The database also enforces one name per user, which protects us
    // if two requests arrive at the same moment (handled in handleDbError)
    const result = await pool.query(
      `INSERT INTO categories (user_id, name)
       VALUES ($1, $2)
       RETURNING id, name`,
      [req.user.id, name]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'Category created.',
      category: { ...result.rows[0], is_default: false },
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// PUT /api/categories/:id  -> rename one of my custom categories
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    const { name, error } = readName(req.body);
    if (error) return sendValidationError(res, [error]);

    // Make sure the category exists and is mine
    const existing = await findOwnedCategory(id, req.user.id);
    if (!existing) return sendNotFound(res);

    // Default categories are locked
    if (isDefaultName(existing.name)) return sendDefaultProtected(res, 'renamed');

    // The new name must not be a default name or one of my other categories
    if (isDefaultName(name)) return sendDefaultName(res);
    if (await nameTaken(req.user.id, name, id)) return sendDuplicate(res);

    const result = await pool.query(
      `UPDATE categories
       SET name = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, name`,
      [name, id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({
      status: 'ok',
      message: 'Category renamed.',
      category: { ...result.rows[0], is_default: false },
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// DELETE /api/categories/:id  -> delete one of my custom categories
// Your expenses are NOT deleted. They simply become "uncategorized".
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    // Make sure the category exists and is mine
    const existing = await findOwnedCategory(id, req.user.id);
    if (!existing) return sendNotFound(res);

    // Default categories are locked
    if (isDefaultName(existing.name)) return sendDefaultProtected(res, 'deleted');

    // One statement does both jobs: count the expenses that use this category,
    // then delete the category. The database sets those expenses' category to
    // empty (it never deletes the expenses themselves).
    // The name check is a second layer of protection for default categories.
    const result = await pool.query(
      `WITH affected AS (
         SELECT COUNT(*)::int AS expense_count
         FROM expenses
         WHERE category_id = $1 AND user_id = $2
       ),
       deleted AS (
         DELETE FROM categories
         WHERE id = $1 AND user_id = $2
           AND LOWER(name) <> ALL($3::text[])
         RETURNING id
       )
       SELECT affected.expense_count
       FROM deleted CROSS JOIN affected`,
      [id, req.user.id, DEFAULT_NAMES_LOWER]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({
      status: 'ok',
      message: 'Category deleted.',
      expensesUncategorized: result.rows[0].expense_count,
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

module.exports = router;