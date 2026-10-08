/**
 * fixtures.js — ground-truth fixtures for the SIH evaluation harness.
 * Synthetic screens are drawn with node-canvas so every test is
 * deterministic and reproducible.
 */
'use strict';

const { createCanvas } = require('canvas');

/* ---------------------------------------------------------------- */
/* 1. Text-level PII fixtures                                        */
/* ---------------------------------------------------------------- */
const TEXT_FIXTURES = [
  { text: 'Aadhaar: 1234 5678 9012', expect: [{ category: 'aadhaar', match: '1234 5678 9012' }] },
  { text: 'My Aadhaar is 2345-6789-0123, keep it safe', expect: [{ category: 'aadhaar', match: '2345-6789-0123' }] },
  { text: 'PAN number ABCDE1234F', expect: [{ category: 'pan', match: 'ABCDE1234F' }] },
  { text: 'Call +91 98765 43210 or 9876543210', expect: [
    { category: 'phone', match: '+91 98765 43210' }, { category: 'phone', match: '9876543210' }] },
  { text: 'Email me at priya.sharma@example.com', expect: [{ category: 'email', match: 'priya.sharma@example.com' }] },
  { text: 'Card 4111 1111 1111 1111 exp 12/28 cvv 123', expect: [{ category: 'credit_card', match: '4111 1111 1111 1111' }] },
  { text: 'Card 1234 5678 9012 3456 (invalid luhn)', expect: [] },
  { text: 'IFSC HDFC0001234, account 50100234567890', expect: [
    { category: 'ifsc', match: 'HDFC0001234' }, { category: 'account_number', match: '50100234567890' }] },
  { text: 'Account 50100234567890 is long but must NOT be aadhaar', expect: [{ category: 'account_number', match: '50100234567890' }] },
  { text: 'DOB 15/08/1995', expect: [{ category: 'dob', match: '15/08/1995' }] },
  { text: 'No sensitive data here, just prose about the weather.', expect: [] },
  { text: 'PIN 560001 near MG Road Bengaluru', expect: [] }, // pincode not flagged at text level (field-level only)
  { text: '12345', expect: [] },                              // too short for any rule
];

/* ---------------------------------------------------------------- */
/* 2. Field-level fixtures (descriptors as produced by extractor)    */
/* ---------------------------------------------------------------- */
function field(role, label, inputType, extra) {
  return Object.assign({ role, label, inputType, rect: { x: 10, y: 10, w: 200, h: 30 }, interactive: true }, extra || {});
}

const FIELD_FIXTURES = {
  banking: {
    desc: 'Insurance KYC form',
    elements: [
      field('input', 'Full name (as per ID)', 'text', { autocomplete: 'name' }),
      field('input', 'Date of birth', 'text', { autocomplete: 'bday' }),
      field('input', 'Email address', 'email'),
      field('input', 'Mobile number', 'tel'),
      field('textarea', 'Residential address', 'textarea', { autocomplete: 'street-address' }),
      field('input', 'PIN code', 'text', { autocomplete: 'postal-code' }),
      field('input', 'Aadhaar number', 'text'),
      field('input', 'PAN', 'text'),
      field('input', 'Bank account number', 'text'),
      field('input', 'IFSC code', 'text'),
      field('input', 'Create login password', 'password'),
      field('input', 'OTP (sent to your mobile)', 'text', { autocomplete: 'one-time-code' }),
      field('input', 'City', 'text'),            // decoy — NOT PII
      field('input', 'Company name', 'text'),    // decoy
      field('input', 'Comments', 'text'),        // decoy
    ],
    // expected = [{label, category|null}]
    expect: [
      { label: 'Full name (as per ID)', category: 'name' },
      { label: 'Date of birth', category: 'dob' },
      { label: 'Email address', category: 'email' },
      { label: 'Mobile number', category: 'phone' },
      { label: 'Residential address', category: 'address' },
      { label: 'PIN code', category: 'pincode' },
      { label: 'Aadhaar number', category: 'aadhaar' },
      { label: 'PAN', category: 'pan' },
      { label: 'Bank account number', category: 'account_number' },
      { label: 'IFSC code', category: 'ifsc' },
      { label: 'Create login password', category: 'password' },
      { label: 'OTP (sent to your mobile)', category: 'otp' },
      { label: 'City', category: null },
      { label: 'Company name', category: null },
      { label: 'Comments', category: null },
    ],
  },
  flight: {
    desc: 'Flight booking page',
    elements: [
      field('input', 'From', 'text'),
      field('input', 'To', 'text'),
      field('input', 'Travel date', 'text'),
      field('select', 'Passengers', 'select'),
      field('button', 'Search flights', null),
      field('button', 'Book', null),
      field('input', 'Passenger full name', 'text', { autocomplete: 'name' }),
      field('input', 'Email', 'email'),
      field('input', 'Mobile', 'tel'),
      field('input', 'Card number (for payment)', 'text', { autocomplete: 'cc-number' }),
    ],
    expect: [
      { label: 'From', category: null },
      { label: 'To', category: null },
      { label: 'Travel date', category: null },
      { label: 'Passengers', category: null },
      { label: 'Search flights', category: null },
      { label: 'Book', category: null },
      { label: 'Passenger full name', category: 'name' },
      { label: 'Email', category: 'email' },
      { label: 'Mobile', category: 'phone' },
      { label: 'Card number (for payment)', category: 'credit_card' },
    ],
  },
  login: {
    desc: 'Login page',
    elements: [
      field('input', 'Username or email', 'text', { autocomplete: 'username' }),
      field('input', 'Password', 'password'),
      field('button', 'Sign in', null),
    ],
    expect: [
      { label: 'Username or email', category: 'username' },
      { label: 'Password', category: 'password' },
      { label: 'Sign in', category: null },
    ],
  },
};

/* ---------------------------------------------------------------- */
/* 3. Synthetic pixel screens                                        */
/*    fields: [{label, value, x, y, w, h, kind, sensitive}]          */
/* ---------------------------------------------------------------- */
function drawText(ctx, text, x, y, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  try { ctx.fillText(text, x, y); } catch (e) { /* font missing — layout unaffected */ }
}

function buildFormScreen(width, height, fields) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const elements = [];
  const gtRects = []; // {category, rect} — pixel ground truth

  let y = 24;
  for (const f of fields) {
    const rect = { x: f.x != null ? f.x : 20, y: f.y != null ? f.y : y, w: f.w || 320, h: f.h || 34 };
    y = rect.y + rect.h + 18;
    // label
    drawText(ctx, f.label, rect.x, rect.y - 16, '13px sans-serif', '#334155');
    // field box
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    // value
    if (f.value && f.kind !== 'password') drawText(ctx, f.value, rect.x + 8, rect.y + 8, '13px sans-serif', '#0f172a');
    if (f.kind === 'password') drawText(ctx, '••••••••', rect.x + 8, rect.y + 8, '13px sans-serif', '#0f172a');

    // descriptor (mirrors extractor.js output shape)
    const el = {
      role: f.role || 'input', rect, label: f.label, text: f.label,
      inputType: f.kind || 'text',
      interactive: true,
    };
    if (f.value) el.value = f.value;
    if (f.autocomplete) el.autocomplete = f.autocomplete;
    if (f.uid != null) el.uid = f.uid;
    elements.push(el);

    if (f.sensitive) gtRects.push({ category: f.category || 'pii', rect: { ...rect } });
  }
  return { canvas, imageData: ctx.getImageData(0, 0, width, height), elements, gtRects };
}

function formField(label, opts) {
  return Object.assign({ label, kind: 'text', value: null, sensitive: false }, opts || {});
}

/* ---------------------------------------------------------------- */
/* 4. Scenario: banking form screen (with ground truth)              */
/* ---------------------------------------------------------------- */
function bankingScreen() {
  return buildFormScreen(640, 1100, [
    formField('Full name (as per ID)', { kind: 'text', value: 'Priya Sharma', autocomplete: 'name', sensitive: true, category: 'name' }),
    formField('Date of birth', { kind: 'text', value: '15/08/1995', autocomplete: 'bday', sensitive: true, category: 'dob' }),
    formField('Email address', { kind: 'email', value: 'priya.sharma@example.com', sensitive: true, category: 'email' }),
    formField('Mobile number', { kind: 'tel', value: '+91 98765 43210', sensitive: true, category: 'phone' }),
    formField('Residential address', { kind: 'textarea', value: '42 MG Road Bengaluru', autocomplete: 'street-address', sensitive: true, category: 'address' }),
    formField('PIN code', { kind: 'text', value: '560001', autocomplete: 'postal-code', sensitive: true, category: 'pincode' }),
    formField('Aadhaar number', { kind: 'text', value: '1234 5678 9012', sensitive: true, category: 'aadhaar' }),
    formField('PAN', { kind: 'text', value: 'ABCDE1234F', sensitive: true, category: 'pan' }),
    formField('Bank account number', { kind: 'text', value: '50100234567890', sensitive: true, category: 'account_number' }),
    formField('IFSC code', { kind: 'text', value: 'HDFC0001234', sensitive: true, category: 'ifsc' }),
    formField('Create login password', { kind: 'password', value: 'S3cret@123', sensitive: true, category: 'password' }),
    formField('City', { kind: 'text', value: 'Bengaluru' }),
    formField('Company name', { kind: 'text', value: 'Acme Pvt Ltd' }),
    formField('Comments', { kind: 'textarea', value: 'Looking forward to the claim' }),
    // submit button (role button — for the e2e planner test)
    { role: 'button', label: 'Submit claim', text: 'Submit claim', rect: { x: 20, y: 980, w: 140, h: 40 }, interactive: true, uid: 99, value: 'Submit claim' },
  ]);
}

/* ---------------------------------------------------------------- */
/* 5. Scenario: flight screen (for e2e server test)                  */
/* ---------------------------------------------------------------- */
function flightScreen() {
  return buildFormScreen(640, 500, [
    formField('From', { kind: 'text', value: '', uid: 1 }),
    formField('To', { kind: 'text', value: '', uid: 2 }),
    formField('Travel date', { kind: 'text', value: '', uid: 3 }),
    formField('Passengers', { kind: 'select', role: 'select', value: '1 Adult', uid: 4 }),
    formField('Search flights', { role: 'button', kind: 'text', value: 'Search flights', uid: 5 }),
  ]);
}

module.exports = { TEXT_FIXTURES, FIELD_FIXTURES, buildFormScreen, bankingScreen, flightScreen };
