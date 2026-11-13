const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Every route in this file requires a valid login token
router.use(requireAuth);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_REGEX = /^\d{1,10}(\.\d{1,2})?$/; // fits NUMERIC(12,2)
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_REGEX = /^(\d{4})-(\d{2})$/;
const MAX_DESCRIPTION_LENGTH = 255;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1000000;

// Constant text (no user input), so it is safe to reuse inside queries.
// to_char returns the date as plain text, which avoids timezone surprises.
const EXPENSE_COLUMNS = `id, category_id, amount, description,
  to_char(spent_on, 'YYYY-MM-DD') AS spent_on, source, created_at`;

// ---------- helpers ----------

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// Returns "2026-11-09" if it is a real calendar date, otherwise null
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_REGEX.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;

  return `${match[1]}-${match[2]}-${match[3]}`;
}

// "2026-11" -> "2026-11-01" (first day of that month), otherwise null
function parseMonth(value) {
  if (typeof value !== 'string') return null;
  const match = MONTH_REGEX.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;

  return `${match[1]}-${match[2]}-01`;
}

// Returns the amount as a clean string like "12.50", or null if invalid
function parseAmount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!MONEY_REGEX.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

function parseWholeNumber(value, min, max) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (number < min || number > max) return null;
  return number;
}

function validateExpenseInput(body, { isUpdate }) {
  const errors = [];
  const values = {};
  const input =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  // user_id in the body is never read. The user always comes from the token.

  // Users may never choose the source (it could be used to fake PayPal records)
  if (input.source !== undefined) {
    errors.push('source cannot be set. Expenses created here are always "manual".');
  }

  if (input.amount !== undefined) {
    const amount = parseAmount(input.amount);
    if (!amount) {
      errors.push(
        'amount must be a number greater than 0 with at most 2 decimal places (max 9999999999.99).'
      );
    } else {
      values.amount = amount;
    }
  } else if (!isUpdate) {
    errors.push('amount is required.');
  }

  if (input.description !== undefined) {
    if (input.description === null) {
      values.description = null;
    } else if (typeof input.description !== 'string') {
      errors.push('description must be text.');
    } else {
      const description = input.description.trim();
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
      } else {
        values.description = description === '' ? null : description;
      }
    }
  }

  if (input.spent_on !== undefined) {
    const spentOn = parseDate(input.spent_on);
    if (!spentOn) {
      errors.push('spent_on must be a real date like "2026-11-09".');
    } else {
      values.spent_on = spentOn;
    }
  }

  if (input.category_id !== undefined) {
    if (input.category_id === null) {
      values.category_id = null; // means "no category"
    } else if (!isValidUuid(input.category_id)) {
      errors.push('category_id must be a valid id or null.');
    } else {
      values.category_id = input.category_id;
    }
  }

  if (isUpdate && errors.length === 0 && Object.keys(values).length === 0) {
    errors.push(
      'Provide at least one of: amount, description, spent_on, category_id.'
    );
  }

  return { errors, values };
}

async function categoryBelongsToUser(categoryId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM categories WHERE id = $1 AND user_id = $2',
    [categoryId, userId]
  );
  return result.rows.length > 0;
}

function sendValidationError(res, errors) {
  return res
    .status(400)
    .json({ status: 'error', message: 'Validation failed', errors });
}

function sendInvalidId(res) {
  return res
    .status(400)
    .json({ status: 'error', message: 'Invalid expense id.' });
}

function sendNotFound(res) {
  return res
    .status(404)
    .json({ status: 'error', message: 'Expense not found.' });
}

function sendBadCategory(res) {
  return res.status(400).json({
    status: 'error',
    message: 'Validation failed',
    errors: ['category_id does not match any of your categories.'],
  });
}

// Turns known PostgreSQL errors into friendly responses
function handleDbError(err, res, next) {
  switch (err.code) {
    case '23503': // foreign key violation
      if (err.constraint && err.constraint.includes('category')) {
        return sendBadCategory(res);
      }
      return res.status(401).json({
        status: 'error',
        message: 'Your account no longer exists. Please log in again.',
      });
    case '23514': // check constraint failed
    case '22003': // number out of range
    case '22007': // invalid date
    case '22P02': // invalid input format
      return res.status(400).json({
        status: 'error',
        message: 'One of the values was rejected by the database.',
      });
    default:
      return next(err); // handled by the central error handler in index.js
  }
}

// ---------- routes ----------

// POST /api/expenses  -> create an expense (always source = 'manual')
router.post('/', async (req, res, next) => {
  try {
    const { errors, values } = validateExpenseInput(req.body, { isUpdate: false });
    if (errors.length > 0) return sendValidationError(res, errors);

    if (
      values.category_id &&
      !(await categoryBelongsToUser(values.category_id, req.user.id))
    ) {
      return sendBadCategory(res);
    }

    // 'manual' is written directly in the query, never taken from the user.
    // If spent_on is missing, the database date for today is used.
    const result = await pool.query(
      `INSERT INTO expenses (user_id, category_id, amount, description, spent_on, source)
       VALUES ($1, $2::uuid, $3::numeric, $4::varchar, COALESCE($5::date, CURRENT_DATE), 'manual')
       RETURNING ${EXPENSE_COLUMNS}`,
      [
        req.user.id,
        values.category_id ?? null,
        values.amount,
        values.description ?? null,
        values.spent_on ?? null,
      ]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'Expense created.',
      expense: result.rows[0],
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// GET /api/expenses  -> list my expenses
// Optional filters: ?month=2026-11  ?category_id=<uuid>  ?limit=50  ?offset=0
router.get('/', async (req, res, next) => {
  try {
    const { month, category_id, limit, offset } = req.query;
    const errors = [];
    const conditions = ['user_id = $1'];
    const params = [req.user.id];

    if (month !== undefined) {
      const firstDay = parseMonth(month);
      if (!firstDay) {
        errors.push('month must look like "2026-11".');
      } else {
        params.push(firstDay);
        const n = params.length;
        conditions.push(
          `spent_on >= $${n}::date AND spent_on < ($${n}::date + INTERVAL '1 month')::date`
        );
      }
    }

    if (category_id !== undefined) {
      if (!isValidUuid(category_id)) {
        errors.push('category_id must be a valid id.');
      } else {
        params.push(category_id);
        conditions.push(`category_id = $${params.length}::uuid`);
      }
    }

    let limitValue = DEFAULT_LIMIT;
    if (limit !== undefined) {
      limitValue = parseWholeNumber(limit, 1, MAX_LIMIT);
      if (limitValue === null) errors.push(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    }

    let offsetValue = 0;
    if (offset !== undefined) {
      offsetValue = parseWholeNumber(offset, 0, MAX_OFFSET);
      if (offsetValue === null) errors.push('offset must be a whole number of 0 or more.');
    }

    if (errors.length > 0) return sendValidationError(res, errors);

    params.push(limitValue, offsetValue);
    const limitPlaceholder = `$${params.length - 1}`;
    const offsetPlaceholder = `$${params.length}`;

    // Only constant text and placeholder numbers are joined into the query
    const result = await pool.query(
      `SELECT ${EXPENSE_COLUMNS}
       FROM expenses
       WHERE ${conditions.join(' AND ')}
       ORDER BY expenses.spent_on DESC, expenses.created_at DESC, expenses.id
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      params
    );

    return res.json({
      status: 'ok',
      count: result.rows.length,
      limit: limitValue,
      offset: offsetValue,
      expenses: result.rows,
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// GET /api/expenses/:id  -> one of my expenses
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    const result = await pool.query(
      `SELECT ${EXPENSE_COLUMNS}
       FROM expenses
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({ status: 'ok', expense: result.rows[0] });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// PUT /api/expenses/:id  -> update one of my expenses (send only what changes)
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    const { errors, values } = validateExpenseInput(req.body, { isUpdate: true });
    if (errors.length > 0) return sendValidationError(res, errors);

    // Find the expense first (and make sure it is mine)
    const existing = await pool.query(
      'SELECT source FROM expenses WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (existing.rows.length === 0) return sendNotFound(res);

    // Money records from PayPal must not be rewritten by the user
    if (
      existing.rows[0].source === 'paypal' &&
      ('amount' in values || 'spent_on' in values)
    ) {
      return res.status(403).json({
        status: 'error',
        message:
          'The amount and date of PayPal expenses cannot be changed. You can still change the description or category.',
      });
    }

    if (
      values.category_id &&
      !(await categoryBelongsToUser(values.category_id, req.user.id))
    ) {
      return sendBadCategory(res);
    }

    // Build the SET part only from fixed column names. Values are parameters.
    const sets = [];
    const params = [];
    if ('amount' in values) {
      params.push(values.amount);
      sets.push(`amount = $${params.length}::numeric`);
    }
    if ('description' in values) {
      params.push(values.description);
      sets.push(`description = $${params.length}::varchar`);
    }
    if ('spent_on' in values) {
      params.push(values.spent_on);
      sets.push(`spent_on = $${params.length}::date`);
    }
    if ('category_id' in values) {
      params.push(values.category_id);
      sets.push(`category_id = $${params.length}::uuid`);
    }

    params.push(id, req.user.id);
    const idPlaceholder = `$${params.length - 1}`;
    const userPlaceholder = `$${params.length}`;

    const result = await pool.query(
      `UPDATE expenses
       SET ${sets.join(', ')}
       WHERE id = ${idPlaceholder} AND user_id = ${userPlaceholder}
       RETURNING ${EXPENSE_COLUMNS}`,
      params
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({
      status: 'ok',
      message: 'Expense updated.',
      expense: result.rows[0],
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// DELETE /api/expenses/:id  -> delete one of my manual expenses
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    // Find the expense first (and make sure it is mine)
    const existing = await pool.query(
      'SELECT source FROM expenses WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (existing.rows.length === 0) return sendNotFound(res);

    // PayPal records come from the payment system and must stay
    if (existing.rows[0].source === 'paypal') {
      return res.status(403).json({
        status: 'error',
        message: 'PayPal expenses cannot be deleted.',
      });
    }

    // The source check is repeated in the query as a second layer of protection
    const result = await pool.query(
      `DELETE FROM expenses
       WHERE id = $1 AND user_id = $2 AND source <> 'paypal'
       RETURNING id`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({ status: 'ok', message: 'Expense deleted.' });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

module.exports = router;