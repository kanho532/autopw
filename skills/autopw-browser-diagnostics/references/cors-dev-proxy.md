# CORS in development-proxy setups

Use this sequence when a proxied frontend action fails but the backend endpoint succeeds in a direct client.

## Signature

- The click or submission fails in the browser.
- A direct request to the backend succeeds.
- The browser reports a failed actual request, CORS error, or framework-level rejected handler.
- An `OPTIONS` request may appear successful because the development server answered it.

## Verification

1. Capture the browser's actual request URL, method, origin, credentials mode, status, body, and response headers.
2. Reproduce the request safely from page context with the same method and credentials.
3. Identify whether `OPTIONS` was answered by the frontend development server, proxy, gateway, or backend.
4. Read proxy and backend CORS configuration. Compare allowed origins, methods, headers, and credentials with the actual request.
5. Test the smallest change in an isolated environment if implementation is authorized.
6. Re-run the original UI action and confirm the state mutation through the authoritative API or persistence layer.

Do not conclude that CORS is correct from curl success or preflight success alone. Also verify that the backend persists the requested change; transport and persistence failures can share one UI symptom.
