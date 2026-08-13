---
name: autopw-browser-diagnostics
description: Diagnose trusted web-application failures that differ between Playwright or a real browser and direct API clients, including CORS, rejected event handlers, failed requests, console errors, authentication propagation, and DOM injection evidence. Use when curl/API checks pass but the UI fails, browser-only behavior needs root-cause evidence, or an AutoPW audit finds ambiguous browser errors.
---

# AutoPW Browser Diagnostics

Diagnose the browser-visible mechanism before proposing a fix.

Write diagnostic summaries and any report-ready finding in Simplified Chinese by default. Preserve raw browser errors, requests, identifiers, and code in their original form.

## Core rule

Direct HTTP clients do not reproduce all browser behavior. Browsers enforce origin policy, execute application code, manage cookies and storage, render the DOM, and expose page errors. When UI and API results differ, the page context is authoritative for the browser-visible failure.

## Diagnostic loop

1. Reproduce the exact user action with the plugin-bundled `autopw-playwright` MCP when available, otherwise use the fallback selected by the sibling `autopw-web-audit` skill. If the host cannot invoke sibling skills by name, read `../autopw-web-audit/SKILL.md` and its execution reference directly.
2. Capture console messages, `pageerror`, failed requests, relevant responses, URL, and DOM state.
3. Re-run the exact request from `page.evaluate()` when safe, preserving method, URL, headers, credentials mode, and body.
4. Compare that result with a direct HTTP request and document the difference.
5. Read the frontend call site, proxy configuration, backend route, CORS/auth configuration, and persistence code.
6. Form a falsifiable root-cause hypothesis and run the smallest discriminating check.
7. Verify independent layers separately. One user symptom can contain more than one defect.

## Common browser-only patterns

### CORS and development proxies

An API call may succeed directly while the UI receives a CORS rejection. A permissive development proxy may answer `OPTIONS` even though the backend rejects the actual method or origin. Inspect the real request and response in page context; do not treat a successful preflight or curl response as proof that the UI path works.

Read [cors-dev-proxy.md](references/cors-dev-proxy.md) for the focused verification sequence.

### Unhandled async event errors

Framework warnings around a click handler often wrap a rejected request. Capture the underlying response and page error instead of relying on a truncated framework warning. If required, temporarily wrap `console.warn` or `console.error` in the page before reproduction and retain serialized arguments.

### Authentication propagation

Compare cookies, storage, authorization headers, redirect behavior, same-site policy, and the backend's final authentication decision. Redact tokens from logs and artifacts.

### DOM injection and XSS evidence

Do not rely on modal dialogs in headless execution. Demonstrate injection and execution with a harmless, reversible marker such as a DOM attribute or page-local flag. Never exfiltrate data or use destructive payloads. Distinguish rendered markup from demonstrated script execution.

## Evidence standard

- Back every UI claim with DOM, page-context, console, network, trace, or screenshot evidence.
- Label direct-client evidence as API-only and note which browser controls it bypasses.
- Check backend logs for relevant stack traces without exposing unrelated secrets.
- State when tooling, authentication, or environment limits prevent a conclusion.
- Report the root cause only when the evidence distinguishes it from plausible alternatives.
- Do not require browser evidence for claims that are fully proven by API, logs, persisted state, or static source. Require it when the conclusion depends on actual browser behavior.
- Record the exact browser executor and do not call a host browser or generic automation channel “Playwright”. Distinguish Playwright MCP from Playwright Test.
