# Auto-derived from the test.step() labels in the matching .spec.js file.
# Do not hand-edit — edit the test.step() calls there and re-derive instead
# (enrich.js does this automatically; run "npm run features:sync" after
# hand-editing a spec's steps directly).

Feature: Login (admin-fonctionnel)

  Scenario: logs in successfully with valid credentials
    Given the user is on the login page
    When they submit valid admin-fonctionnel credentials
    Then they log in as the FunctionalAdmin role and land on the admin console home page
    And the user logs out

  Scenario: shows an error with wrong credentials
    Given the user is on the login page
    When they submit an incorrect password
    Then an error message is shown and the user stays on the login page
