const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const router = express.Router();
// Every route in this file requires a valid login token
router.use(requireAuth);

const DEFAULT_ALERT_PERCENT = 80; // matches the default in your database
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_REGEX = /^\d{1,10}(\.\d{1,2})?$/; // fits NUMERIC(12,2)

// Constant text (no user input), so it is safe to reuse inside queries.
// to_char returns the month as plain text, which avoids timezone surprises.
const BUDGET_COLUMNS = `id, to_char(month, 'YYYY-MM-DD') AS month,
  total_limit, alert_percent, created_at`;

// ---------- helpers ----------

// Accepts "2026-11" or "2026-11-15" and returns "2026-11-01"
function parseMonth(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;

  if (match[3] !== undefined) {
    const day = Number(match[3]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) return null;
  }

  return `${match[1]}-${match[2]}-01`;
}

// Returns the amount as a clean string like "25000.50", or null if invalid
function parseTotalLimit(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!MONEY_REGEX.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

function parseAlertPercent(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) return null;
  return value;
}

function validateBudgetInput(body, { isUpdate }) {
  const errors = [];
  const values = {};
  const input =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  // Note: user_id in the body is never read. The user comes from the token.

  if (input.month !== undefined) {
    const month = parseMonth(input.month);
    if (!month) {
      errors.push('month must be a valid date like "2026-11" or "2026-11-01".');
    } else {
      values.month = month;
    }
  } else if (!isUpdate) {
    errors.push('month is required.');
  }

  if (input.total_limit !== undefined) {
    const totalLimit = parseTotalLimit(input.total_limit);
    if (!totalLimit) {
      errors.push(
        'total_limit must be a number greater than 0 with at most 2 decimal places (max 9999999999.99).'
      );
    } else {
      values.total_limit = totalLimit;
    }
  } else if (!isUpdate) {
    errors.push('total_limit is required.');
  }

  if (input.alert_percent !== undefined) {
    const alertPercent = parseAlertPercent(input.alert_percent);
    if (alertPercent === null) {
      errors.push('alert_percent must be a whole number from 1 to 100.');
    } else {
      values.alert_percent = alertPercent;
    }
  }

  if (isUpdate && errors.length === 0 && Object.keys(values).length === 0) {
    errors.push('Provide at least one of: month, total_limit, alert_percent.');
  }

  return { errors, values };
}

function sendValidationError(res, errors) {
  return res
    .status(400)
    .json({ status: 'error', message: 'Validation failed', errors });
}

function sendInvalidId(res) {
  return res
    .status(400)
    .json({ status: 'error', message: 'Invalid budget id.' });
}

function sendNotFound(res) {
  return res.status(404).json({ status: 'error', message: 'Budget not found.' });
}

// Turns known PostgreSQL errors into friendly responses
function handleDbError(err, res, next) {
  switch (err.code) {
    case '23505': // unique violation (same user + month)
      return res.status(409).json({
        status: 'error',
        message: 'You already have a budget for this month.',
      });
    case '23503': // foreign key violation (user no longer exists)
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

// POST /api/budgets  -> create a budget
router.post('/', async (req, res, next) => {
  try {
    const { errors, values } = validateBudgetInput(req.body, { isUpdate: false });
    if (errors.length > 0) return sendValidationError(res, errors);

    const alertPercent = values.alert_percent ?? DEFAULT_ALERT_PERCENT;

    // The unique constraint on (user_id, month) blocks duplicates,
    // even if two requests arrive at the same moment.
    const result = await pool.query(
      `INSERT INTO budgets (user_id, month, total_limit, alert_percent)
       VALUES ($1, $2::date, $3::numeric, $4::smallint)
       RETURNING ${BUDGET_COLUMNS}`,
      [req.user.id, values.month, values.total_limit, alertPercent]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'Budget created.',
      budget: result.rows[0],
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// GET /api/budgets  -> list my budgets
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${BUDGET_COLUMNS}
       FROM budgets
       WHERE user_id = $1
       ORDER BY budgets.month DESC`,
      [req.user.id]
    );

    return res.json({
      status: 'ok',
      count: result.rows.length,
      budgets: result.rows,
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// GET /api/budgets/:id  -> one of my budgets
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) return sendInvalidId(res);

    const result = await pool.query(
      `SELECT ${BUDGET_COLUMNS}
       FROM budgets
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({ status: 'ok', budget: result.rows[0] });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// PUT /api/budgets/:id  -> update one of my budgets
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) return sendInvalidId(res);

    const { errors, values } = validateBudgetInput(req.body, { isUpdate: true });
    if (errors.length > 0) return sendValidationError(res, errors);

    // Fields that were not sent stay as they are (COALESCE keeps the old value)
    const result = await pool.query(
      `UPDATE budgets
       SET month = COALESCE($1::date, month),
           total_limit = COALESCE($2::numeric, total_limit),
           alert_percent = COALESCE($3::smallint, alert_percent)
       WHERE id = $4 AND user_id = $5
       RETURNING ${BUDGET_COLUMNS}`,
      [
        values.month ?? null,
        values.total_limit ?? null,
        values.alert_percent ?? null,
        id,
        req.user.id,
      ]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({
      status: 'ok',
      message: 'Budget updated.',
      budget: result.rows[0],
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// DELETE /api/budgets/:id  -> delete one of my budgets
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) return sendInvalidId(res);

    const result = await pool.query(
      `DELETE FROM budgets
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({ status: 'ok', message: 'Budget deleted.' });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

module.exports = router;