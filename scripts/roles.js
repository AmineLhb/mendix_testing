/**
 * Maps a role name to the env vars that hold that role's credentials.
 *
 * The list of which roles exist is per-project data now (see
 * projectPaths().roles / readProjectRoles() in scripts/project.js) — two
 * different Mendix apps can have completely different roles. What stays
 * fixed here is only the *naming convention*: given a role name, which env
 * vars hold its username/password. That convention is a pure function of
 * the name, so there's no separate name->vars table to keep in sync by hand
 * every time a project defines a new role.
 *
 * "collaborateur" is special-cased to the original unsuffixed
 * MENDIX_TEST_USERNAME/MENDIX_TEST_PASSWORD — every test generated before
 * roles became per-project data already reads those exact names. Every
 * other role (old or newly created) gets
 * MENDIX_TEST_USERNAME_<ROLE>/MENDIX_TEST_PASSWORD_<ROLE>.
 */
const ROLE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function isValidRoleName(role) {
  return typeof role === "string" && ROLE_NAME_RE.test(role);
}

export function resolveRole(role) {
  if (!isValidRoleName(role)) {
    throw new Error(
      `Invalid role name "${role}" — must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`
    );
  }
  if (role === "collaborateur") {
    return { usernameVar: "MENDIX_TEST_USERNAME", passwordVar: "MENDIX_TEST_PASSWORD" };
  }
  const suffix = role.toUpperCase().replace(/-/g, "_");
  return { usernameVar: `MENDIX_TEST_USERNAME_${suffix}`, passwordVar: `MENDIX_TEST_PASSWORD_${suffix}` };
}
