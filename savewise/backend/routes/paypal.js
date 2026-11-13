const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

const BASE_URL = 'https://api-m.sandbox.paypal.com';
const TEST_AMOUNT = '1.00';
const TEST_CURRENCY = 'USD';

// Get a PayPal access token.
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PayPal configuration is incomplete.');
  }

  if (process.env.PAYPAL_BASE_URL !== BASE_URL) {
    throw new Error('Only PayPal Sandbox is allowed.');
  }

  const credentials = Buffer
    .from(`${clientId}:${clientSecret}`)
    .toString('base64');

  const response = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error('PayPal authentication failed.');
  }

  return data.access_token;
}

// Test PayPal Sandbox connection.
router.get('/connection-test', requireAuth, async (req, res) => {
  try {
    await getPayPalAccessToken();

    res.json({
      status: 'ok',
      message: 'PayPal Sandbox connection successful!',
      environment: 'sandbox',
    });
  } catch (error) {
    console.error('PayPal connection test failed:', error.message);

    res.status(502).json({
      status: 'error',
      message: 'Could not connect to PayPal Sandbox.',
    });
  }
});

// Create a fixed $1 Sandbox test order.
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();

    const response = await fetch(`${BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({
  intent: 'CAPTURE',
  payment_source: {
    paypal: {
      experience_context: {
        return_url: 'http://localhost:5500/success.html',
        cancel_url: 'http://localhost:5500/cancel.html',
        user_action: 'PAY_NOW'
      }
    }
  },
  purchase_units: [
    {
      reference_id: 'savewise-sandbox-test',
      custom_id: req.user.id,
      description: 'SaveWise Sandbox integration test',
      amount: {
        currency_code: TEST_CURRENCY,
        value: TEST_AMOUNT
      }
    }
  ]
}),
    });

    const data = await response.json();

    if (!response.ok || !data.id) {
      console.error('PayPal order creation failed:', data);

      return res.status(502).json({
        status: 'error',
        message: 'Could not create PayPal order.',
      });
    }
    const approvalLink = data.links?.find(
  (link) => link.rel === 'payer-action' || link.rel === 'approve'
)?.href;

    res.status(201).json({
      status: 'ok',
      message: 'Sandbox order created.',
      orderID: data.id,
      approvalUrl: approvalLink,
      amount: TEST_AMOUNT,
      currency: TEST_CURRENCY,
    });
  } catch (error) {
    console.error('Create PayPal order failed:', error.message);

    res.status(500).json({
      status: 'error',
      message: 'Could not create Sandbox order.',
    });
  }
});

// Capture and verify an approved Sandbox order.
 router.post('/capture-order', requireAuth, async (req, res) => {
  try {
    const { orderID } = req.body;

    if (
      typeof orderID !== 'string' ||
      !/^[A-Z0-9-]{1,100}$/i.test(orderID)
    ) {
      return res.status(400).json({
        status: 'error',
        message: 'A valid PayPal order ID is required.',
      });
    }

    const accessToken = await getPayPalAccessToken();

    // STEP 1: Retrieve the order before attempting capture.
    const orderResponse = await fetch(
      `${BASE_URL}/v2/checkout/orders/${encodeURIComponent(orderID)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const order = await orderResponse.json();

    if (!orderResponse.ok) {
      return res.status(502).json({
        status: 'error',
        message: 'Could not verify the PayPal order.',
      });
    }

    // STEP 2: Verify order ownership and payment details.
const purchaseUnits = order.purchase_units || [];
const purchaseUnit = purchaseUnits[0];
const amount = purchaseUnit?.amount;

if (
  !['APPROVED', 'COMPLETED'].includes(order.status) ||
  order.intent !== 'CAPTURE' ||
  purchaseUnits.length !== 1 ||
  purchaseUnit?.custom_id !== req.user.id ||
  purchaseUnit?.reference_id !== 'savewise-sandbox-test' ||
  amount?.currency_code !== TEST_CURRENCY ||
  amount?.value !== TEST_AMOUNT
) {
  return res.status(400).json({
    status: 'error',
    message: 'PayPal order verification failed.',
  });
}

let capture;

// STEP 3: Reuse an existing completed capture.
// Never capture an order that is already completed.
if (order.status === 'COMPLETED') {
  capture = purchaseUnit?.payments?.captures?.[0];
} else {
  const captureRequestId = crypto
    .createHash('sha256')
    .update(`savewise-capture-${orderID}`)
    .digest('hex')
    .slice(0, 36);

  const captureResponse = await fetch(
    `${BASE_URL}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': captureRequestId,
      },
    }
  );

  const captureData = await captureResponse.json();

  if (!captureResponse.ok) {
    console.error('PayPal capture failed:', captureData);

    return res.status(502).json({
      status: 'error',
      message: 'PayPal could not capture this order.',
    });
  }

  capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];

  if (captureData.status !== 'COMPLETED') {
    return res.status(400).json({
      status: 'error',
      message: 'PayPal capture is not completed.',
    });
  }
}

// STEP 4: Verify the captured payment.
if (
  capture?.status !== 'COMPLETED' ||
  capture?.amount?.currency_code !== TEST_CURRENCY ||
  capture?.amount?.value !== TEST_AMOUNT ||
  !capture?.id
) {
  return res.status(400).json({
    status: 'error',
    message: 'PayPal payment verification failed.',
  });
}
    // STEP 5: Record the verified transaction.
    const result = await pool.query(
      `INSERT INTO paypal_transactions
       (user_id, paypal_txn_id, amount, currency, status, occurred_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (paypal_txn_id) DO NOTHING
       RETURNING id`,
      [
        req.user.id,
        capture.id,
        capture.amount.value,
        capture.amount.currency_code,
        capture.status,
        capture.create_time || null,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        status: 'error',
        message: 'This PayPal transaction has already been recorded.',
      });
    }

    return res.json({
      status: 'ok',
      message: 'Sandbox payment captured and recorded successfully!',
      transactionID: capture.id,
      amount: capture.amount.value,
      currency: capture.amount.currency_code,
      paymentStatus: capture.status,
    });

  } catch (error) {
    console.error('PayPal capture error:', error.message);

    return res.status(500).json({
      status: 'error',
      message: 'Could not complete PayPal capture.',
    });
  }
});
// Read-only PayPal order status check
router.get('/order-status/:orderID', requireAuth, async (req, res) => {
  try {
    const { orderID } = req.params;

    if (!/^[A-Z0-9-]{1,100}$/i.test(orderID)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid order ID.',
      });
    }

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(
      `${BASE_URL}/v2/checkout/orders/${encodeURIComponent(orderID)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        status: 'error',
        message: 'Could not retrieve PayPal order.',
      });
    }

    const unit = data.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];

    return res.json({
      status: 'ok',
      orderStatus: data.status,
      captureStatus: capture?.status || null,
      currency: capture?.amount?.currency_code || unit?.amount?.currency_code || null,
      amount: capture?.amount?.value || unit?.amount?.value || null,
      hasCaptureId: Boolean(capture?.id),
    });
  } catch (error) {
    console.error('PayPal order status error:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Could not check PayPal order status.',
    });
  }
});
module.exports = router;