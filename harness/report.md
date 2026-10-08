# SIH Evaluation Report — On-device Visual Perception for Light-weight Browser Agents

Generated: 2026-08-29T06:51:45.466Z · Overall score: **98.3/100** 

## Metric scores

| Metric | Weight | Score | Key numbers |
|---|---|---|---|
| M1 Visual context accuracy | 25% | **100** | category accuracy 1, mean element IoU 1 |
| M2 PII detection P/R | 20% | **100** | text: P 1 / R 1 (11TP 0FP 0FN) · fields: P 1 / R 1 (18TP 0FP 0FN) |
| M3 Redaction precision | 20% | **100** | box P 1 / R 1, 100.0% pixels changed inside GT boxes, 0.000% outside |
| M4 Resource utilization | 20% | **91.8** | model 227 KB, payload 42 KB, DOM 0 ms, face 19 ms |
| M5 End-to-end latency | 15% | **99.5** | 37 ms/tick, fills OK=true, click OK=true, done=true |

## Notes

- YuNet model 227 KB (target <1 MB → 78%)
- ORT runtime JS 694 KB + WASM 10.5 MB (loaded once, cached)
- face-model input buffer 4.69 MB
- redacted payload 42 KB for a full page snapshot
- Face inference measured with the WASM backend in Node (browser uses WebGPU when available — typically 3–6× faster).
- End-to-end tick measured against the live planner (fallback mode); payload re-audited server-side and found clean: true.

## Text fixture detail

| fixture | expected | found | ok |
|---|---|---|---|
| Aadhaar: 1234 5678 9012 | 1 | 1 (aadhaar:1234 5678 9012) | ✅ |
| My Aadhaar is 2345-6789-0123, keep it safe | 1 | 1 (aadhaar:2345-6789-0123) | ✅ |
| PAN number ABCDE1234F | 1 | 1 (pan:ABCDE1234F) | ✅ |
| Call +91 98765 43210 or 9876543210 | 2 | 2 (phone:+91 98765 43210, phone:9876543210) | ✅ |
| Email me at priya.sharma@example.com | 1 | 1 (email:priya.sharma@example.com) | ✅ |
| Card 4111 1111 1111 1111 exp 12/28 cvv 123 | 1 | 1 (credit_card:4111 1111 1111 1111) | ✅ |
| Card 1234 5678 9012 3456 (invalid luhn) | 0 | 0 () | ✅ |
| IFSC HDFC0001234, account 50100234567890 | 2 | 2 (ifsc:HDFC0001234, account_number:50100234567890) | ✅ |
| Account 50100234567890 is long but must NOT be aadhaar | 1 | 1 (account_number:50100234567890) | ✅ |
| DOB 15/08/1995 | 1 | 1 (dob:15/08/1995) | ✅ |
| No sensitive data here, just prose about the weather. | 0 | 0 () | ✅ |
| PIN 560001 near MG Road Bengaluru | 0 | 0 () | ✅ |
| 12345 | 0 | 0 () | ✅ |

## Field fixture detail (PII classification)

| scenario | field | expected | got | verdict |
|---|---|---|---|---|
| banking | Full name (as per ID) | name | name | TP |
| banking | Date of birth | dob | dob | TP |
| banking | Email address | email | email | TP |
| banking | Mobile number | phone | phone | TP |
| banking | Residential address | address | address | TP |
| banking | PIN code | pincode | pincode | TP |
| banking | Aadhaar number | aadhaar | aadhaar | TP |
| banking | PAN | pan | pan | TP |
| banking | Bank account number | account_number | account_number | TP |
| banking | IFSC code | ifsc | ifsc | TP |
| banking | Create login password | password | password | TP |
| banking | OTP (sent to your mobile) | otp | otp | TP |
| banking | City | clean | — | TN |
| banking | Company name | clean | — | TN |
| banking | Comments | clean | — | TN |
| flight | From | clean | — | TN |
| flight | To | clean | — | TN |
| flight | Travel date | clean | — | TN |
| flight | Passengers | clean | — | TN |
| flight | Search flights | clean | — | TN |
| flight | Book | clean | — | TN |
| flight | Passenger full name | name | name | TP |
| flight | Email | email | email | TP |
| flight | Mobile | phone | phone | TP |
| flight | Card number (for payment) | credit_card | credit_card | TP |
| login | Username or email | username | username | TP |
| login | Password | password | password | TP |
| login | Sign in | clean | — | TN |

## Screen pipeline detections

- name @ 0.95 (autocomplete)
- dob @ 0.9 (text)
- email @ 0.9 (text)
- phone @ 0.9 (text)
- address @ 0.95 (autocomplete)
- pincode @ 0.95 (autocomplete)
- aadhaar @ 0.9 (text)
- pan @ 0.9 (text)
- account_number @ 0.9 (text)
- ifsc @ 0.9 (text)
- password @ 0.98 (type)

## Face detection

- 1 face(s) found on the sample portrait, scores [0.95], WASM inference 19 ms, 98.0% of face-box pixels altered by redaction.