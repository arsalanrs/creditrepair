LendingPad loan officers (user GUIDs for /integrations/list/loans)

  File to edit:  config/lendingpad-users.json
  Format:        [ { "name": "Full Name", "id": "guid" }, ... ]

  View as text:  npm run lo:list   (from repo root)

  The intake form loads this list for the "Loan officer" dropdown.
  Optional override: env LENDINGPAD_USERS_JSON (same JSON array as a string).
