require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const pool = require('./db');
const authRoutes = require('./routes/auth');
const budgetRoutes = require('./routes/budgets');
const expenseRoutes = require('./routes/expenses');
const categoryRoutes = require('./routes/categories');
const goalRoutes = require('./routes/goals');
const contributionRoutes = require('./routes/contributions');
const paypalRoutes = require('./routes/paypal');
const aiRoutes = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Health check: confirms the server is running
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'SaveWise backend is running',
    timestamp: new Date().toISOString(),
  });
});
// Database test: confirms PostgreSQL is reachable

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');

    res.json({
      status: 'ok',
      message: 'Database connection successful',
      serverTime: result.rows[0].server_time,
    });
  } catch (err) {
    console.error('DATABASE ERROR DETAILS:', err);

    res.status(500).json({
      status: 'error',
      message: String(err.message || err),
      code: err.code || 'UNKNOWN',
      detail: err.detail || null,
    });
  }
});
// Authentication routes: /api/auth/register and /api/auth/login
app.use('/api/auth', authRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/goals', contributionRoutes);
app.use('/api/paypal', paypalRoutes);
app.use('/api/ai', aiRoutes);

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

// Central error handler (must have 4 parameters)
app.use((err, req, res, next) => {
  // Bad JSON or oversized body from the client
  if (err.status && err.status >= 400 && err.status < 500) {
    return res
      .status(err.status)
      .json({ status: 'error', message: 'Invalid request body' });
  }

  console.error('Error:', err.message);
  res.status(500).json({
    status: 'error',
    message: 'Something went wrong on the server',
  });
});

app.listen(PORT, () => {
  console.log(`SaveWise backend running on http://localhost:${PORT}`);
});