const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Every route in this file requires a valid login token
router.use(requireAuth);

// ---------- settings ----------

const VALID_STATUSES = ['active', 'completed', 'cancelled'];
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_REGEX = /^\d{1,10}(\.\d{1,2})?$/; // fits NUMERIC(12,2)
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const MAX_TITLE_LENGTH = 100;
const MAX_GOALS_RETURNED = 200;

// Constant text (no user input), so it is safe to reuse inside queries.
// to_char returns the date as plain text, which avoids timezone surprises.
const GOAL_COLUMNS = `id, title, target_amount, saved_amount,
  to_char(deadline, 'YYYY-MM-DD') AS deadline, status, created_at`;

// ---------- helpers ----------

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// Cleans and checks a goal title. Returns { title } or { error }.
function parseTitle(value) {
  if (typeof value !== 'string') {
    return { error: 'title is required and must be text.' };
  }
  if (CONTROL_CHARS_REGEX.test(value)) {
    return { error: 'title contains invalid characters.' };
  }

  // Trim the ends and turn runs of spaces into a single space
  const title = value.trim().replace(/\s+/g, ' ');

  if (title.length < 1) {
    return { error: 'title cannot be empty.' };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { error: `title must be at most ${MAX_TITLE_LENGTH} characters.` };
  }
  return { title };
}

// Returns the amount as a clean string like "50000.00", or null if invalid
function parseAmount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!MONEY_REGEX.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

// Returns "2027-06-30" if it is a real calendar date, otherwise null
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

// True if the date is clearly in the past.
// One day of tolerance is allowed so different time zones do not cause trouble.
function isPastDate(dateString) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return dateString < yesterday; // "YYYY-MM-DD" text compares correctly
}

function validateGoalInput(body, { isUpdate }) {
  const errors = [];
  const values = {};
  const input =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  // user_id in the body is never read. The user always comes from the token.

  // Savings can only change through contributions (a separate feature)
  if (input.saved_amount !== undefined) {
    errors.push(
      'saved_amount cannot be set here. It is updated only through contributions.'
    );
  }

  if (input.title !== undefined) {
    const { title, error } = parseTitle(input.title);
    if (error) errors.push(error);
    else values.title = title;
  } else if (!isUpdate) {
    errors.push('title is required.');
  }

  if (input.target_amount !== undefined) {
    const targetAmount = parseAmount(input.target_amount);
    if (!targetAmount) {
      errors.push(
        'target_amount must be a number greater than 0 with at most 2 decimal places (max 9999999999.99).'
      );
    } else {
      values.target_amount = targetAmount;
    }
  } else if (!isUpdate) {
    errors.push('target_amount is required.');
  }

  // deadline is optional. null means "no deadline".
  if (input.deadline !== undefined) {
    if (input.deadline === null) {
      values.deadline = null;
    } else {
      const deadline = parseDate(input.deadline);
      if (!deadline) {
        errors.push('deadline must be a real date like "2027-06-30" or null.');
      } else {
        values.deadline = deadline;
      }
    }
  }

  // New goals always start as "active", so status is only accepted on update
  if (input.status !== undefined) {
    if (!isUpdate) {
      errors.push('status cannot be set when creating a goal. New goals start as "active".');
    } else if (!VALID_STATUSES.includes(input.status)) {
      errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    } else {
      values.status = input.status;
    }
  }

  if (isUpdate && errors.length === 0 && Object.keys(values).length === 0) {
    errors.push('Provide at least one of: title, target_amount, deadline, status.');
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
    .json({ status: 'error', message: 'Invalid goal id.' });
}

function sendNotFound(res) {
  return res.status(404).json({ status: 'error', message: 'Goal not found.' });
}

// Turns known PostgreSQL errors into friendly responses
function handleDbError(err, res, next) {
  switch (err.code) {
    case '23503': // foreign key violation (user no longer exists)
      return res.status(401).json({
        status: 'error',
        message: 'Your account no longer exists. Please log in again.',
      });
    case '23514': // check constraint failed
    case '22001': // text too long for the column
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

// POST /api/goals  -> create a savings goal
router.post('/', async (req, res, next) => {
  try {
    const { errors, values } = validateGoalInput(req.body, { isUpdate: false });

    if (errors.length === 0 && values.deadline && isPastDate(values.deadline)) {
      errors.push('deadline cannot be in the past.');
    }
    if (errors.length > 0) return sendValidationError(res, errors);

    // saved_amount (0) and status ('active') are written directly in the
    // query, never taken from the user.
    const result = await pool.query(
      `INSERT INTO goals (user_id, title, target_amount, saved_amount, deadline, status)
       VALUES ($1, $2, $3::numeric, 0, $4::date, 'active')
       RETURNING ${GOAL_COLUMNS}`,
      [req.user.id, values.title, values.target_amount, values.deadline ?? null]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'Goal created.',
      goal: result.rows[0],
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// GET /api/goals  -> list my goals (optional filter: ?status=active)
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const conditions = ['user_id = $1'];
    const params = [req.user.id];

    if (status !== undefined) {
      if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) {
        return sendValidationError(res, [
          `status must be one of: ${VALID_STATUSES.join(', ')}.`,
        ]);
      }
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    // Only constant text and placeholder numbers are joined into the query
    const result = await pool.query(
      `SELECT ${GOAL_COLUMNS}
       FROM goals
       WHERE ${conditions.join(' AND ')}
       ORDER BY goals.created_at DESC, goals.id
       LIMIT ${MAX_GOALS_RETURNED}`,
      params
    );

    return res.json({
      status: 'ok',
      count: result.rows.length,
      goals: result.rows,
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// GET /api/goals/:id  -> one of my goals
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    const result = await pool.query(
      `SELECT ${GOAL_COLUMNS}
       FROM goals
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({ status: 'ok', goal: result.rows[0] });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// PUT /api/goals/:id  -> update one of my goals (send only what changes)
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    const { errors, values } = validateGoalInput(req.body, { isUpdate: true });
    if (errors.length > 0) return sendValidationError(res, errors);

    // Find the goal first (and make sure it is mine)
    const existingResult = await pool.query(
      `SELECT target_amount, saved_amount, status,
              to_char(deadline, 'YYYY-MM-DD') AS deadline
       FROM goals
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (existingResult.rows.length === 0) return sendNotFound(res);
    const existing = existingResult.rows[0];

    // A new deadline must not be in the past (keeping the old one is fine)
    if (
      values.deadline &&
      values.deadline !== existing.deadline &&
      isPastDate(values.deadline)
    ) {
      errors.push('deadline cannot be in the past.');
    }

    // A completed goal must have reached its target
    const finalStatus = values.status ?? existing.status;
    const finalTarget = values.target_amount ?? existing.target_amount;
    if (
      finalStatus === 'completed' &&
      Number(existing.saved_amount) < Number(finalTarget)
    ) {
      errors.push(
        'A goal can only be "completed" when the saved amount has reached the target amount. Set the status to "active" first if you want to raise the target.'
      );
    }

    if (errors.length > 0) return sendValidationError(res, errors);

    // Build the SET part only from fixed column names. Values are parameters.
    const sets = [];
    const params = [];
    if ('title' in values) {
      params.push(values.title);
      sets.push(`title = $${params.length}::varchar`);
    }
    if ('target_amount' in values) {
      params.push(values.target_amount);
      sets.push(`target_amount = $${params.length}::numeric`);
    }
    if ('deadline' in values) {
      params.push(values.deadline);
      sets.push(`deadline = $${params.length}::date`);
    }
    if ('status' in values) {
      params.push(values.status);
      sets.push(`status = $${params.length}::varchar`);
    }

    params.push(id, req.user.id);
    const idPlaceholder = `$${params.length - 1}`;
    const userPlaceholder = `$${params.length}`;

    const result = await pool.query(
      `UPDATE goals
       SET ${sets.join(', ')}
       WHERE id = ${idPlaceholder} AND user_id = ${userPlaceholder}
       RETURNING ${GOAL_COLUMNS}`,
      params
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({
      status: 'ok',
      message: 'Goal updated.',
      goal: result.rows[0],
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

// DELETE /api/goals/:id  -> delete one of my goals
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidUuid(id)) return sendInvalidId(res);

    const result = await pool.query(
      `DELETE FROM goals
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) return sendNotFound(res);

    return res.json({ status: 'ok', message: 'Goal deleted.' });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

module.exports = router;