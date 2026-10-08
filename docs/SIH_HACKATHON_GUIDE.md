# 🏆 SIH Hackathon — Team Guide: Privacy Vision Agent

**Project**: Privacy-Preserving Visual-Perception Agent for Lightweight Browsers
**Team size**: 6 members · **Total score**: 98.30/100 (harness) · **Format**: working prototype + live demo

---

## 1. What this project does (your 30-second pitch)

> "We built a browser agent that can *see* a webpage and do tasks on it (fill forms, click buttons) — but it's **privacy-first**: faces, passwords and ID numbers are detected and redacted **on the user's own device** (WebGPU/WASM, no cloud vision), and the server only ever receives a **sanitized** screenshot. A built-in privacy gateway guarantees nothing sensitive leaves the device, and we prove it with an automated evaluation scoring **98.3/100**."

Key points judges love:
- ❌ No sensitive data leaves the device — redaction happens BEFORE any network call
- 🖥️ Works on lightweight browsers (no server-side vision needed; WASM fallback)
- 📊 Measured against the 5 SIH metrics with a repeatable harness
- 🧩 Fully self-contained: zero CDNs, works **offline**

---

## 2. What the agent actually does (the 6-step pipeline)

| # | Step | Where | What happens |
|---|---|---|---|
| 1 | **Extract** | device | Reads the page's DOM structure — element positions, labels, input types (NEVER the typed values) |
| 2 | **See** | device | Renders the page to a canvas snapshot (stays on device) + YuNet face detection via ONNX Runtime Web (WebGPU → WASM fallback, 232 KB model) |
| 3 | **Detect PII** | device | Classifies fields (Aadhaar, PAN, phone, email, card, password, OTP, DOB…) from labels/autocomplete/values + regex text scan |
| 4 | **Redact** | device | Blurs faces, **solid-black** passwords/OTP, masks PII; records pixel delta + byte delta audit |
| 5 | **Send** | network | Only the sanitized payload (`pva/v1`: redacted image + element map + audit metadata) goes to the server; a fetch/XHR **privacy gateway** re-scrubs everything as defense-in-depth |
| 6 | **Act** | both | Server planner (offline deterministic, or LLM/VLM if key set) returns validated commands (`type`, `click`, `scroll`…); agent executes them locally, loops until `done` |

**The demo you show:** the agent fills an insurance claim form (name, Aadhaar, PAN, password, OTP…) and submits it — while the server log proves it only ever saw redaction *metadata*.

---

## 3. Demo script for the judges (6 minutes)

| Time | What you do | What you say (key line) |
|---|---|---|
| 0:00–0:45 | Open `http://127.0.0.1:8787/` (hub) | "Everything you'll see runs on this laptop. No internet needed." |
| 0:45–1:30 | Click 🏦 **Insurance Claim Form** | "This is a normal insurance form with Aadhaar, PAN, password, OTP. Watch what happens when we press Start — while I show you the server log." |
| 1:30–2:30 | Click **green ▶ Start Agent** (bottom-left) | *(point at the screen)* "Form is filling itself: name, email, Aadhaar… Submit clicked… and there's the success box. Task done." |
| 2:30–3:30 | Show the **server terminal** | "This is EVERYTHING the server received: category counts, pixel delta, payload size. No 'Priya Sharma', no Aadhaar digits — only metadata. The typed values never left this device." |
| 3:30–4:15 | Open **📊 SIH Evaluation** (`/eval.html`) | "The 5 metrics run live in your browser, right now. M1 visual context 100, M2 PII detection 100, M3 redaction 100, M4 resources ~92, M5 latency ~99." |
| 4:15–5:00 | Optional: 🧑 **Faces & Documents** demo | "YuNet face detection + Aadhaar-card redaction, all on-device — here's the 'before/after' redaction preview." |
| 5:00–6:00 | Wrap + Q&A | "Privacy is our core: the gateway scrub counter, the byte audit, and the offline-first design." |

**Backup plan (critical):** record the whole demo as a video (OBS/screencast) and keep it on a phone. If the live demo fails, play the video — never show a broken screen.

---

## 4. Setup on each team member's laptop

### A. The ONLY hard requirement (for demos)
1. **Node.js 20 LTS** → https://nodejs.org (check: `node -v`)
2. **Chrome or Edge** (for WebGPU; Firefox works too via WASM)
3. The project folder (Git clone, USB, or zip)

### B. Get the code
```bash
git clone <your-repo-url> privacy-vision-agent
cd privacy-vision-agent
```

### C. Run the server (per laptop)
```bash
node server/app/server.js          # or: scripts/dev.sh  (Linux/macOS)
# open http://127.0.0.1:8787/
```
- Windows: if a firewall prompt appears, **Allow** (Node needs to listen on port 8787).
- If port 8787 is busy: `PORT=9000 node server/app/server.js` and open `http://127.0.0.1:9000/`.
- **No `npm install` needed for the demo** — the server is pure Node.js built-ins, and all browser assets (ONNX Runtime, wasm, YuNet model) are vendored in the repo.

### D. Optional per-laptop extras
| Tool | Install | Needed for |
|---|---|---|
| Evaluation harness | `cd harness && npm install` (installs onnxruntime-node, canvas, pngjs) | Running `node eval.js` locally |
| Browser smoke test | `cd /tmp && npm init -y && npm install playwright-core && npx playwright-core install chromium` (Linux: also `npx playwright-core install-deps chromium` with sudo) | `node browser-test.js` (13/13 checks) |
| Chrome extension | Load unpacked from `extension/chrome` | Showing the "works on any website" part |
| Firefox extension | `about:debugging` → Load Temporary Add-on → `extension/firefox/manifest.json` | Same on Firefox |

> ⏳ **Internet needed only once** (npm install / cloning). The demo itself runs **fully offline** — strong SIH selling point, and your fallback if venue Wi-Fi dies.

---

## 5. Team roles (6 members)

| Role | Member | Responsibilities |
|---|---|---|
| **Lead / Demo driver** | A | Owns the presenter laptop, runs the live demo, tells the story |
| **Vision/engine engineer** | B | Deep knowledge of the pipeline (extractor → YuNet → redaction → audit); answers technical questions; fixes on the spot |
| **Backend/planner engineer** | C | Knows `server.js` + `planner.js` + LLM mode env vars; handles "what if the planner fails" questions |
| **Extension engineer** | D | Owns `extension/` folders; can demo loading the extension live in Chrome |
| **Evaluation & testing** | E | Owns `harness/eval.js`, `browser-test.js`, `report.md`; can re-run metrics live on the spot |
| **Presenter 2 / Backup** | F | Second laptop with everything installed (hot standby); also handles slides/Q&A notes |

**Night-before checklist (all 6):**
- [ ] `node -v` works (v18+)
- [ ] `node server/app/server.js` starts, hub page opens
- [ ] Banking demo completes on YOUR laptop (run the green button once)
- [ ] `cd harness && node eval.js` runs (for members E + B)
- [ ] Demo video recorded on a phone as backup
- [ ] Repo pushed / USB copy made (2 independent copies)

---

## 6. Files to know before the demo

```
privacy-vision-agent/
├── server/
│   ├── app/server.js          # Node server: static + /api/agent + /api/privacy-audit
│   ├── app/planner.js         # offline fallback planner (or LLM mode via env vars)
│   └── static/
│       ├── index.html         # hub page (start here)
│       ├── launcher.js        # the green "▶ Start Agent" button (bottom-left)
│       ├── demo-panel.html    # full agent UI panel (stats, redaction previews)
│       ├── demo/{banking,flight,login,face}.html
│       ├── eval.html          # LIVE SIH scorecard in the browser
│       ├── js/engine/*.js     # the whole client engine (8 files)
│       ├── js/ort.all.min.js  # ONNX Runtime Web (vendored, no CDN)
│       ├── ort/*.wasm         # WASM runtime (vendored)
│       └── models/yunet.onnx  # YuNet face detector (232 KB)
├── extension/chrome|firefox/  # browser extensions
├── harness/                   # eval.js + fixtures + browser-test.js → report.md
├── scripts/dev.sh             # one-command: server / eval / build extensions
└── docs/README.md             # full technical documentation
```

### Likely judge questions + answers

| Question | Answer |
|---|---|
| "What model do you use for vision?" | YuNet 2023mar face detector (OpenCV Zoo, 232 KB) via ONNX Runtime Web — WebGPU first, WASM fallback. Plus DOM-based PII classification with confidence tiers and regex text scan. |
| "How do you guarantee privacy?" | 3 layers: (1) redaction before encoding with pixel/byte audit, (2) values never leave the client (labels only), (3) a Privacy Gateway scrubs every fetch/XHR. Server logs metadata only — shown live. |
| "What about LLMs?" | The server planner is deterministic offline (no cost, no internet). Set `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` to switch to an OpenAI-compatible LLM/VLM that reads the sanitized payload. |
| "Lightweight browsers?" | No server-side vision: ~232 KB model + 11 MB wasm (cached once), payload ≤ 300 KB, face inference ~20 ms WASM / faster WebGPU. Everything measured in M4. |
| "What if WebGPU is unavailable?" | Automatic WASM fallback (that's what we demo; the Node harness uses WASM too — 19–21 ms). |
| "Can it work on any website?" | Yes — the extension (`extension/chrome`) injects the same engine on any page; demo'd live via Load unpacked. |
| "How is redaction verified?" | Pixel-level proof in the harness: 100% of pixels inside ground-truth boxes changed, 0.0000% outside (leakage), plus box precision/recall 1.0. |

---

## 7. Evaluation metrics recap (so you can explain the score)

| Metric | Weight | What we score | Our score |
|---|---|---|---|
| M1 Visual context accuracy | 25% | Category accuracy + redaction box recall on a synthetic form screen | 100.00 |
| M2 PII detection P/R | 20% | 0.6·text F1 + 0.4·field F1 (13 text fixtures + 3 form fixtures) | 100.00 |
| M3 Redaction precision | 20% | Box precision + pixels changed inside GT (0.95 target); 0 leakage outside | 100.00 |
| M4 Resource utilization | 20% | Model ≤1 MB, payload ≤300 KB, DOM ≤50 ms, face ≤600 ms, total ≤1500 ms | 91.8 |
| M5 End-to-end latency | 15% | Full agent round-trip vs 8 s budget (~35–40 ms actual) | 99.5 |
| **Overall** | | | **98.30 / 100** |

Re-run anytime: `cd harness && node eval.js` (Node) or open `/eval.html` (in-browser).

---

## 8. Emergency runbook (if things go wrong ON STAGE)

| Problem | Fix |
|---|---|
| Server won't start (port busy) | `PORT=9000 node server/app/server.js`, use port 9000 |
| Demo page blank | Check server terminal; refresh page; restart server |
| Green button does nothing | The panel iframe may not have loaded — click 📊 then ▶ inside the panel; or reload the page |
| WebGPU errors in console | Fine — WASM fallback kicks in automatically (that's by design) |
| Laptop dies / demo breaks | Switch to backup laptop (member F) — everything is pre-installed; or play the recorded video |
| No Wi-Fi at venue | Doesn't matter — the whole demo is offline except optional LLM mode |
| Judge asks for a specific task | Use the **task input box** in the panel (📊 → task field) or `demo-panel.html?task=<your task>` |
