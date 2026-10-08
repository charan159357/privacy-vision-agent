/**
 * pii-rules.js — PII taxonomy, regexes and label heuristics.
 * This is the privacy knowledge-base used by the on-device detector.
 * All rules run locally; nothing here ever leaves the browser.
 *
 * Every detection yields: { category, confidence, source }
 *   source: 'type' | 'autocomplete' | 'hint' | 'label' | 'text' | 'value' | 'image' | 'face'
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PVA = Object.assign(root.PVA || {}, { PII: api });
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Categories that must ALWAYS be redacted before any network request. */
  const SENSITIVE = new Set([
    'password', 'otp', 'aadhaar', 'pan', 'credit_card', 'debit_card', 'cvv',
    'account_number', 'ifsc', 'phone', 'email', 'dob', 'address', 'document_image', 'face',
  ]);
  /** PII categories that are sensitive but configurable (names, pincode...). */
  const PII_OPTIONAL = new Set(['name', 'pincode', 'username']);

  const CATEGORY = {
    password: 'password', otp: 'otp', aadhaar: 'aadhaar', pan: 'pan',
    credit_card: 'credit_card', debit_card: 'debit_card', cvv: 'cvv',
    phone: 'phone', email: 'email', name: 'name', dob: 'dob',
    address: 'address', account_number: 'account_number', ifsc: 'ifsc',
    pincode: 'pincode', username: 'username', document_image: 'document_image',
    face: 'face',
  };

  const CONF = {
    type: 0.98, autocomplete: 0.95, label: 0.92, hint: 0.88, value: 0.9, text: 0.86, image: 0.78, face: 0.9,
  };

  /* ---------------- regexes (India-centric, extensible) ---------------- */
  // All numeric patterns use look-around digit boundaries so that long
  // numbers (e.g. a 14-digit bank account) are never partially matched as
  // a 12-digit Aadhaar.
  const RX = {
    // aadhaar: 12 digits in 4-4-4 groups. The group separators mean plain
    // digit-boundary checks are not enough — a 16-digit card number would
    // otherwise match its first 12 digits. So also require that the match is
    // not preceded by "digit+separator" and not followed by "separator+digit".
    aadhaar: /(?<!\d)(?<![0-9][\s-])\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\s-]?\d)/g,
    pan: /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/g,
    phone: /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    cardLoose: /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g,
    ifsc: /(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])/g,
    account: /(?<!\d)\d{9,18}(?!\d)/g,
    dob: /(?<!\d)\d{1,2}[\/-]\d{1,2}[\/-]\d{4}(?!\d)/g,
    cvv: /(?<!\d)\d{3}(?!\d)/g,
    otp: /(?<!\d)\d{4,6}(?!\d)/g,
  };

  /** Luhn check — kills most false positives for credit-card numbers. */
  function luhn(numStr) {
    const digits = numStr.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0, dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  /** Match a block of text against the PII regexes. Returns [{category, match, index}]. */
  function scanText(text) {
    if (!text) return [];
    const found = [];
    const push = (category, match, index) => found.push({ category, match, index });
    let m;
    while ((m = RX.aadhaar.exec(text))) push('aadhaar', m[0], m.index);
    while ((m = RX.pan.exec(text))) push('pan', m[0], m.index);
    while ((m = RX.phone.exec(text))) push('phone', m[0], m.index);
    while ((m = RX.email.exec(text))) push('email', m[0], m.index);
    while ((m = RX.cardLoose.exec(text))) if (luhn(m[0])) push('credit_card', m[0], m.index);
    while ((m = RX.ifsc.exec(text))) push('ifsc', m[0], m.index);
    while ((m = RX.dob.exec(text))) push('dob', m[0], m.index);
    // generic account numbers: only if the span is not already covered by a
    // more specific category (avoids double-flagging Aadhaar/PAN/phone runs)
    while ((m = RX.account.exec(text))) {
      const covered = found.some(f => f.index <= m.index && f.index + f.match.length >= m.index + m[0].length);
      if (!covered) push('account_number', m[0], m.index);
    }
    return found;
  }

  /* ---------------- label / hint keyword maps ---------------- */
  const LABEL_MAP = [
    { cat: 'aadhaar', conf: 0.94, re: /(^|[^a-z])(aadhaar|aadhar|uid|unique\s*id)([^a-z]|$)/i },
    { cat: 'pan', conf: 0.92, re: /(^|[^a-z])(pan|permanent\s+account\s+number)([^a-z]|$)/i },
    { cat: 'credit_card', conf: 0.94, re: /\b(card|cc|credit\s*card|debit\s*card)\b\s*(number|no\.?|#)?/i },
    { cat: 'cvv', conf: 0.95, re: /(cvv|cvc|card\s*verif)/i },
    { cat: 'expiry', conf: 0.85, re: /(expiry|exp\.?|valid\s*through|mm\/yy)/i }, // mapped to credit_card family
    { cat: 'otp', conf: 0.95, re: /(^|[^a-z])(otp|one\s*time\s*(password|code|pin)|verification\s*code|6[\s-]?digit\s*(code|pin)|security\s*code)([^a-z]|$)/i },
    { cat: 'password', conf: 0.96, re: /(^|[^a-z])(password|passwd|pwd|pass\b|secret|security\s*(pin|key)|login\s*pin|mpin)([^a-z]|$)/i },
    { cat: 'phone', conf: 0.93, re: /(^|[^a-z])(phone|mobile|telephone|contact|cell|mob\.?|mobile\s*no)([^a-z]|$)/i },
    { cat: 'email', conf: 0.94, re: /(^|[^a-z])(e-?mail|email|mail\s*id)([^a-z]|$)/i },
    { cat: 'username', conf: 0.8, re: /(^|[^a-z])(username|user\s*id|login\s*id|userid)([^a-z]|$)/i },
    { cat: 'name', conf: 0.82, re: /(^|[^a-z])(full\s*name|applicant\s*name|holder\s*name|insured\s*name|customer\s*name|policyholder\s*name|beneficiary\s*name|name\s*of\s+(the\s+)?(applicant|insured|holder|customer|beneficiary))([^a-z]|$)/i },
    { cat: 'dob', conf: 0.95, re: /(^|[^a-z])(date\s*of\s*birth|dob|birth\s*date)([^a-z]|$)/i },
    { cat: 'address', conf: 0.85, re: /(^|[^a-z])(address|street|locality|residential|permanent\s*address)([^a-z]|$)/i },
    { cat: 'account_number', conf: 0.93, re: /(account\s*(no|number)|a\/?c\s*(no|number)|bank\s*account|acct)/i },
    { cat: 'ifsc', conf: 0.95, re: /(^|[^a-z])(ifsc|ifs\s*code|bank\s*code)([^a-z]|$)/i },
    { cat: 'pincode', conf: 0.85, re: /(^|[^a-z])(pin\s*code|pincode|postal\s*code|zip|atm\s*pin|debit\s*pin|card\s*pin)([^a-z]|$)/i },
  ];

  const AUTOFILL_MAP = {
    'cc-number': 'credit_card', 'cc-exp': 'credit_card', 'cc-exp-month': 'credit_card',
    'cc-exp-year': 'credit_card', 'cc-csc': 'cvv', 'cc-name': 'name',
    tel: 'phone', email: 'email', name: 'name', 'given-name': 'name', 'family-name': 'name',
    'additional-name': 'name', username: 'username', 'nickname': 'username',
    'street-address': 'address', 'address-line1': 'address', 'address-line2': 'address',
    'postal-code': 'pincode', 'bday': 'dob', 'bday-day': 'dob', 'bday-month': 'dob', 'bday-year': 'dob',
    'current-password': 'password', 'new-password': 'password',
    'one-time-code': 'otp', 'transaction-verification-code': 'otp',
  };

  const HINT_TOKENS = [
    { cat: 'aadhaar', conf: 0.85, re: /(aadhaar|aadhar|uid)/i },
    { cat: 'pan', conf: 0.82, re: /(^|[^a-z])pan([^a-z]|$)|permanent.?account/i },
    { cat: 'credit_card', conf: 0.8, re: /(card|ccnum|cc_num|cardno)/i },
    { cat: 'cvv', conf: 0.9, re: /(cvv|cvc)/i },
    { cat: 'otp', conf: 0.88, re: /(otp|onetp|otp_code|otpcode)/i },
    { cat: 'password', conf: 0.9, re: /(^|[^a-z])(password|passwd|pwd|pass|mpin|secret|security_pin)([^a-z]|$)/i },
    { cat: 'phone', conf: 0.85, re: /(phone|mobile|telephone|contact|cell|mobno|mobileno|phone_no)/i },
    { cat: 'email', conf: 0.87, re: /(email|e-mail|mailid|mail_id)/i },
    { cat: 'username', conf: 0.8, re: /(username|userid|user_id|loginid|login_id)/i },
    { cat: 'dob', conf: 0.9, re: /(dob|dateofbirth|birthdate|birth_date)/i },
    { cat: 'account_number', conf: 0.88, re: /(account_no|accountnumber|acct|acc_no|account)/i },
    { cat: 'ifsc', conf: 0.9, re: /(ifsc|ifs_code)/i },
    { cat: 'pincode', conf: 0.8, re: /(pincode|pin_code|postal|zip)/i },
    { cat: 'address', conf: 0.78, re: /(address|addr|street|locality)/i },
  ];

  /* ---------------- image heuristics ---------------- */
  const IMAGE_HINTS = [
    { cat: 'document_image', conf: 0.82, re: /(aadhaar|pan\b|passport|driving.?licen|licence|voter|id.?card|identity|cheque|statement|invoice|bill|agreement|policy.?doc|document|kyc)/i },
    { cat: 'face', conf: 0.6, re: /(photo|profile|avatar|picture|selfie)/i },
  ];

  /** Normalize an identifier for matching: lowercase, alnum tokens. */
  function tokens(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  }

  /** Classify a form control from its attributes. Returns {category, confidence, source} | null. */
  function classifyField({ type, name, id, autocomplete, label, placeholder, ariaLabel, className }) {
    const hay = [label, placeholder, ariaLabel].filter(Boolean).join(' | ');

    // 1. strongest signal: input type
    if (type === 'password') return { category: 'password', confidence: CONF.type, source: 'type' };
    if (type === 'email') return { category: 'email', confidence: CONF.autocomplete * 0.98, source: 'autocomplete' };
    if (type === 'tel') return { category: 'phone', confidence: CONF.autocomplete * 0.98, source: 'autocomplete' };

    // 2. autocomplete attribute (browser-authored semantics — very reliable)
    if (autocomplete && AUTOFILL_MAP[autocomplete.toLowerCase()]) {
      return { category: AUTOFILL_MAP[autocomplete.toLowerCase()], confidence: CONF.autocomplete, source: 'autocomplete' };
    }

    // 3. explicit label text
    if (hay) {
      for (const rule of LABEL_MAP) {
        if (rule.re.test(hay)) {
          const cat = rule.cat === 'expiry' ? 'credit_card' : rule.cat;
          return { category: cat, confidence: rule.conf, source: 'label' };
        }
      }
    }

    // 4. name / id hints
    const ident = [name, id, className].filter(Boolean).join(' ');
    if (ident) {
      for (const rule of HINT_TOKENS) {
        if (rule.re.test(ident)) {
          // guard: "account" is common in non-PII contexts like "account settings"
          if (rule.cat === 'account_number' && /(settings|management|admin)/i.test(ident)) continue;
          return { category: rule.cat, confidence: rule.conf, source: 'hint' };
        }
      }
    }

    // 5. visible value matches (e.g. autofilled fields)
    return null;
  }

  /** Classify an <img> element. Returns {category, confidence, source} | null. */
  function classifyImage({ src, alt, className, id }) {
    const hay = [src, alt, className, id].filter(Boolean).join(' ');
    if (!hay) return null;
    for (const rule of IMAGE_HINTS) {
      if (rule.re.test(hay)) return { category: rule.cat, confidence: rule.conf, source: 'image' };
    }
    return null;
  }

  /** Verify a card-like string with Luhn for value-level checks. */
  function isCardNumber(s) { return luhn(s); }

  return {
    CATEGORY, SENSITIVE, PII_OPTIONAL, CONF, RX,
    scanText, classifyField, classifyImage, luhn, isCardNumber, tokens, LABEL_MAP, AUTOFILL_MAP,
  };
});
