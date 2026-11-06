# Dayflow 2.0 — Phase 1 patch

This patch is designed for the existing `Hyellafiya/Dayflow` repository.

## Included
- `package.json` — repairs the malformed JSON and preserves the existing Node/Express/Supabase dependencies.
- `public/styles.css` — premium responsive dark workspace visual system.
- `fix-app-entry.patch` — changes the HTML script entry from the missing `app.bundle.js` to the existing `app.js`.

## Apply safely
1. Create/use branch `rebuild/dayflow-v2` from `main`.
2. Replace the repository's `package.json` with this version.
3. Replace `public/styles.css` with this version.
4. In `public/index.html`, change the script source at the bottom from `/app.bundle.js` to `/app.js` (the included patch shows the exact one-line edit).
5. Keep `public/app.js`, `src/`, and `supabase/` unchanged for this first visual pass.
6. Commit and deploy the branch.

## Important
- No Supabase tables or records are changed.
- No API keys are included.
- Existing backend and authentication code are preserved.
- The current `/api/tasks/:id/run` and `/api/email/send` routes still return HTTP 501. The execution and email-delivery engines are later phases, not included in this UI foundation.
