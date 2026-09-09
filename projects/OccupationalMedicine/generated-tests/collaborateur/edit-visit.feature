# Auto-derived from the test.step() labels in the matching .spec.js file.
# Do not hand-edit — edit the test.step() calls there and re-derive instead
# (enrich.js does this automatically; run "npm run features:sync" after
# hand-editing a spec's steps directly).

Feature: edit-visit

  Scenario: Mendix app end‑to‑end flow
    Given the user is on the login page
    When they log in with valid credentials
    Then they land on the visit list page
    When they open an existing visit for editing
    And they change the reason for the visit
    When they save the changes
    And they validate the changes
    Then the app returns to the visit list page
    And the user logs out
