const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/';

router.get('/recommendations', requireAuth, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL;

    if (!apiKey || !model) {
      return res.status(503).json({
        status: 'error',
        message: 'AI service is not configured yet.',
      });
    }

    // Get the authenticated user's income and currency.
    const userResult = await pool.query(
      `SELECT monthly_income, currency
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found.',
      });
    }

    // Get this month's budget.
    const budgetResult = await pool.query(
      `SELECT total_limit, alert_percent
       FROM budgets
       WHERE user_id = $1
         AND month = date_trunc('month', CURRENT_DATE)::date
       LIMIT 1`,
      [req.user.id]
    );

    // Get this month's spending grouped by category.
    const expenseResult = await pool.query(
      `SELECT
         COALESCE(c.name, 'Uncategorised') AS category,
         SUM(e.amount)::numeric(12,2) AS total
       FROM expenses e
       LEFT JOIN categories c
         ON c.id = e.category_id
        AND c.user_id = e.user_id
       WHERE e.user_id = $1
         AND e.spent_on >= date_trunc('month', CURRENT_DATE)::date
         AND e.spent_on < (
           date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
         )::date
       GROUP BY COALESCE(c.name, 'Uncategorised')
       ORDER BY SUM(e.amount) DESC`,
      [req.user.id]
    );

    const user = userResult.rows[0];
    const budget = budgetResult.rows[0] || null;

    const categoryBreakdown = expenseResult.rows.map((row) => ({
      category: row.category,
      amount: Number(row.total),
    }));

    const totalSpent = categoryBreakdown.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    const budgetLimit = budget ? Number(budget.total_limit) : null;
    const remainingBudget =
      budgetLimit === null ? null : budgetLimit - totalSpent;

    const financialSummary = {
      currency: user.currency,
      monthlyIncome:
        user.monthly_income === null
          ? null
          : Number(user.monthly_income),
      monthlyBudget: budgetLimit,
      alertPercent: budget ? Number(budget.alert_percent) : null,
      totalSpent: Number(totalSpent.toFixed(2)),
      remainingBudget:
        remainingBudget === null
          ? null
          : Number(remainingBudget.toFixed(2)),
      categoryBreakdown,
    };

    const prompt = `
You are SaveWise, an educational savings and budgeting assistant.

Analyse the financial summary below.

Give the user:
1. A short spending overview.
2. Two or three practical saving suggestions.
3. Any budget warning that the numbers support.
4. One achievable next step.

Rules:
- Use the supplied currency.
- Never invent financial figures.
- If budget or income is missing, say so.
- Do not shame the user.
- Do not recommend investments, loans or risky financial products.
- Give educational suggestions, not professional financial advice.
- Keep the answer friendly and easy to understand.

Financial summary:
${JSON.stringify(financialSummary)}
`;

    const response = await fetch(
      `${GEMINI_URL}${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 600,
          },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API request failed:', data.error?.message);

      return res.status(502).json({
        status: 'error',
        message: 'AI recommendations are temporarily unavailable.',
      });
    }

    const recommendation = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();

    if (!recommendation) {
      return res.status(502).json({
        status: 'error',
        message: 'The AI did not return a recommendation.',
      });
    }

    res.json({
      status: 'ok',
      financialSummary,
      recommendation,
    });
  } catch (error) {
    console.error('AI recommendation error:', error.message);

    res.status(500).json({
      status: 'error',
      message: 'Could not generate AI recommendations.',
    });
  }
});

module.exports = router;