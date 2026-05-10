import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPermissionProfile,
  detectPermissionIssue,
  normalizeApprovalMode,
  normalizeSandboxMode,
  validateCommandSafety
} from "../plugins/codex/scripts/lib/orchestration/permissions.mjs";

test("permission profile defaults collaborative runs to safe write mode", () => {
  const profile = buildPermissionProfile({});

  assert.equal(profile.sandboxMode, "workspace-write");
  assert.equal(profile.approvalMode, "on-request");
  assert.equal(profile.allowFileWrites, true);
  assert.equal(profile.fullPower, false);
});

test("permission profile requires explicit full power opt-in", () => {
  assert.throws(
    () =>
      buildPermissionProfile({
        permissions: {
          sandboxMode: "full-access",
          approvalMode: "never"
        }
      }),
    /Full power mode requires explicit opt-in/
  );

  const profile = buildPermissionProfile(
    {},
    {
      fullPower: true
    }
  );
  assert.equal(profile.sandboxMode, "danger-full-access");
  assert.equal(profile.approvalMode, "never");
  assert.equal(profile.fullPower, true);
});

test("permission helpers normalize aliases and detect blocked write output", () => {
  assert.equal(normalizeSandboxMode("full-access"), "danger-full-access");
  assert.equal(normalizeSandboxMode("readonly"), "read-only");
  assert.equal(normalizeApprovalMode("onrequest"), "on-request");

  const issue = detectPermissionIssue(
    "I couldn't create the file because this session is in a read-only sandbox and approvals are disabled.",
    buildPermissionProfile({}, { allowFileWrites: false, sandboxMode: "read-only" })
  );

  assert.equal(issue.readOnly, true);
  assert.equal(issue.approvalBlocked, true);
  assert.match(issue.message, /Switch to workspace-write mode/);
});

test("command safety flags destructive commands outside full power mode", () => {
  assert.equal(validateCommandSafety("npm test").ok, true);
  assert.equal(validateCommandSafety("rm -rf .cache").ok, false);
  assert.equal(validateCommandSafety("rm -rf .cache", { fullPower: true }).ok, true);
});
