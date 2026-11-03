# Fonts

Self-hosted, so the app makes no external request (works offline and under the strict CSP).

- `atkinson-next-*.woff2`: Atkinson Hyperlegible Next (variable, weights 200 to 800), used for all text.
- `atkinson-mono-*.woff2`: Atkinson Hyperlegible Mono (variable, weights 200 to 800), used only for identifiers that are
  compared character by character (invoice and PO numbers, bank accounts, hashes).

Designed by the Braille Institute of America; both families are licensed under the SIL Open Font License 1.1
(https://openfontlicense.org), which permits redistribution with the app. Files are the `latin` and `latin-ext`
subsets served by Google Fonts. They are declared in `src/app/globals.css`.
