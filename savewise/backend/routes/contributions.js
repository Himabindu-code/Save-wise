const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// ---------- settings ----------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MONEY_REGEX = /^\d{1,10}(\.\d{1,2})?$/;

const MAX_CONTRIBUTIONS_RETURNED = 200;

// ---------- helpers ----------

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function parseAmount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }

  const text = String(value).trim();

  if (!MONEY_REGEX.test(text)) return null;
  if (Number(text) <= 0) return null;

  return text;
}

function sendValidationError(res, errors) {
  return res.status(400).json({
    status: 'error',
    message: 'Validation failed',
    errors,
  });
}

function sendNotFound(res) {
  return res.status(404).json({
    status: 'error',
    message: 'Goal not found.',
  });
}

function handleDbError(err, res, next) {
  switch (err.code) {
    case '23503':
      return res.status(401).json({
        status: 'error',
        message: 'Your account or goal no longer exists.',
      });

    case '23514':
    case '22001':
    case '22003':
    case '22007':
    case '22P02':
      return res.status(400).json({
        status: 'error',
        message: 'One of the values was rejected by the database.',
      });

    default:
      return next(err);
  }
}

// ---------- routes ----------

// POST /api/goals/:goalId/contributions
// Add money to one of my goals

router.post('/:goalId/contributions', async (req, res, next) => {
   let client;

try {
  client = await pool.connect();
    const { goalId } = req.params;

    if (!isValidUuid(goalId)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid goal ID.',
      });
    }

    const amount = parseAmount(req.body?.amount);

    if (!amount) {
      return sendValidationError(res, [
        'amount must be greater than 0 with at most 2 decimal places.',
      ]);
    }

    await client.query('BEGIN');

    // Lock the goal row to prevent simultaneous contribution races.
    const goalResult = await client.query(
      `SELECT id, target_amount, saved_amount, status
       FROM goals
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [goalId, req.user.id]
    );

    if (goalResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendNotFound(res);
    }

    const goal = goalResult.rows[0];

    if (goal.status !== 'active') {
      await client.query('ROLLBACK');

      return sendValidationError(res, [
        'Contributions can only be added to active goals.',
      ]);
    }

    const remaining =
      Number(goal.target_amount) - Number(goal.saved_amount);

    if (Number(amount) > remaining) {
      await client.query('ROLLBACK');

      return sendValidationError(res, [
        `Contribution exceeds the remaining target amount (${remaining.toFixed(2)}).`,
      ]);
    }

    // Record the contribution.
    const contributionResult = await client.query(
      `INSERT INTO goal_contributions (goal_id, amount)
       VALUES ($1, $2::numeric)
       RETURNING id, goal_id, amount, contributed_on`,
      [goalId, amount]
    );

    // Update saved progress.
    const updatedGoalResult = await client.query(
      `UPDATE goals
       SET saved_amount = saved_amount + $1::numeric
       WHERE id = $2 AND user_id = $3
       RETURNING id, title, target_amount, saved_amount,
                 status, to_char(deadline, 'YYYY-MM-DD') AS deadline`,
      [amount, goalId, req.user.id]
    );

    const updatedGoal = updatedGoalResult.rows[0];

    // Automatically complete the goal when its target is reached.
    let finalGoal = updatedGoal;

    if (
      Number(updatedGoal.saved_amount) >=
      Number(updatedGoal.target_amount)
    ) {
      const completedResult = await client.query(
        `UPDATE goals
         SET status = 'completed'
         WHERE id = $1 AND user_id = $2
         RETURNING id, title, target_amount, saved_amount,
                   status, to_char(deadline, 'YYYY-MM-DD') AS deadline`,
        [goalId, req.user.id]
      );

      finalGoal = completedResult.rows[0];
    }

    await client.query('COMMIT');

    return res.status(201).json({
      status: 'ok',
      message: 'Contribution added successfully.',
      contribution: contributionResult.rows[0],
      goal: finalGoal,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Preserve the original error.
    }

    return handleDbError(err, res, next);
  } finally {
  if (client) {
    client.release();
  }
}
});

// GET /api/goals/:goalId/contributions
// View contribution history for one of my goals

router.get('/:goalId/contributions', async (req, res, next) => {
  try {
    const { goalId } = req.params;

    if (!isValidUuid(goalId)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid goal ID.',
      });
    }

    // Confirm that the goal belongs to the logged-in user.
    const goalResult = await pool.query(
      `SELECT id
       FROM goals
       WHERE id = $1 AND user_id = $2`,
      [goalId, req.user.id]
    );

    if (goalResult.rows.length === 0) {
      return sendNotFound(res);
    }

    const result = await pool.query(
      `SELECT id, goal_id, amount, contributed_on
       FROM goal_contributions
       WHERE goal_id = $1
       ORDER BY contributed_on DESC, id DESC
       LIMIT ${MAX_CONTRIBUTIONS_RETURNED}`,
      [goalId]
    );

    return res.json({
      status: 'ok',
      count: result.rows.length,
      contributions: result.rows,
    });
  } catch (err) {
    return handleDbError(err, res, next);
  }
});

module.exports = router;