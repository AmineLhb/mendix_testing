# Auto-derived from the test.step() labels in the matching .spec.js file.
# Do not hand-edit — edit the test.step() calls there and re-derive instead
# (enrich.js does this automatically; run "npm run features:sync" after
# hand-editing a spec's steps directly).

Feature: create-visit

  Scenario: visit app and validate form
    Given the user is on the login page
    When they log in with valid credentials
    Then they land on the visit list page
    When they open the add-visit form
    And they select the visit type
    And they fill in the reason for the visit
    When they submit and confirm the visit
    Then the visit is created with the correct details
    And the app returns to the visit list page
    And the user logs out
