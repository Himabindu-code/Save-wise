const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

// Refuse to start with a missing or weak secret
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET is missing or too short (minimum 32 characters). Set it in your .env file.'
  );
}

const router = express.Router();

const SALT_ROUNDS = 12;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Used when an email is not found, so login takes the same time either way
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function validateRegistration(name, email, password) {
  const errors = [];

  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
    errors.push('Name is required and must be at most 100 characters.');
  }

  if (
    typeof email !== 'string' ||
    email.trim().length > 255 ||
    !EMAIL_REGEX.test(email.trim())
  ) {
    errors.push('A valid email address is required.');
  }

  if (typeof password !== 'string') {
    errors.push('Password is required.');
  } else {
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters.');
    }
    // bcrypt only uses the first 72 bytes, so longer passwords are refused
    if (Buffer.byteLength(password, 'utf8') > 72) {
      errors.push('Password must be at most 72 bytes long.');
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      errors.push('Password must contain at least one letter and one number.');
    }
  }

  return errors;
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};

    const errors = validateRegistration(name, email, password);
    if (errors.length > 0) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Validation failed', errors });
    }

    const cleanName = name.trim();
    const cleanEmail = normalizeEmail(email);

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
      cleanEmail,
    ]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        status: 'error',
        message: 'An account with this email already exists.',
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, monthly_income, currency, created_at`,
      [cleanName, cleanEmail, passwordHash]
    );

    return res.status(201).json({
      status: 'ok',
      message: 'Account created successfully.',
      user: result.rows[0],
    });
  } catch (err) {
    // Two people registering the same email at the same moment
    if (err.code === '23505') {
      return res.status(409).json({
        status: 'error',
        message: 'An account with this email already exists.',
      });
    }
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email and password are required.',
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash, monthly_income, currency, created_at
       FROM users WHERE email = $1`,
      [normalizeEmail(email)]
    );

    const user = result.rows[0];

    // Always run a bcrypt comparison, even if the user does not exist
    const passwordOk = await bcrypt.compare(
      password,
      user ? user.password_hash : DUMMY_HASH
    );

    if (!user || !passwordOk) {
      // Same message for both cases so attackers cannot discover which emails exist
      return res.status(401).json({
        status: 'error',
        message: 'Invalid email or password.',
      });
    }

    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: JWT_EXPIRES_IN,
    });

    // Remove the hash before sending the user back
    const { password_hash, ...safeUser } = user;

    return res.json({
      status: 'ok',
      message: 'Login successful.',
      token,
      user: safeUser,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;