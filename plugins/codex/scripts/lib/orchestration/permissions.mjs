const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_APPROVAL_MODES = new Set(["never", "on-request", "on-failure", "untrusted"]);

const READ_ONLY_PATTERNS = [
  /read[- ]only sandbox/i,
  /sandbox is read[- ]only/i,
  /session is in a read[- ]only sandbox/i,
  /cannot.*(?:create|write|edit|modify).*read[- ]only/i,
  /couldn't.*(?:create|write|edit|modify).*read[- ]only/i
];

const APPROVAL_PATTERNS = [
  /approvals? (?:are|is) disabled/i,
  /approval policy.*never/i,
  /without approval/i,
  /permission denied/i,
  /operation not permitted/i,
  /not permitted by sandbox/i
];

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bgit\s+checkout\s+--\b/,
  /\bsudo\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/
];

export function normalizeSandboxMode(value, fallback = "workspace-write") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "full-access" || normalized === "full" || normalized === "danger-full") {
    return "danger-full-access";
  }
  if (normalized === "readonly" || normalized === "read_only") {
    return "read-only";
  }
  if (normalized === "write" || normalized === "workspace") {
    return "workspace-write";
  }
  if (!VALID_SANDBOX_MODES.has(normalized)) {
    throw new Error(`Unsupported sandbox mode "${value}". Use read-only, workspace-write, or full-access.`);
  }
  return normalized;
}

export function normalizeApprovalMode(value, fallback = "on-request") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "onrequest") {
    return "on-request";
  }
  if (normalized === "onfailure") {
    return "on-failure";
  }
  if (!VALID_APPROVAL_MODES.has(normalized)) {
    throw new Error(`Unsupported approval mode "${value}". Use on-request, on-failure, untrusted, or never.`);
  }
  return normalized;
}

export function buildPermissionProfile(config = {}, options = {}) {
  const permissionConfig = config.permissions ?? {};
  const allowFileWrites =
    options.allowFileWrites ??
    permissionConfig.allowFileWrites ??
    permissionConfig.allowWrites ??
    true;
  const requestedFullPower = Boolean(allowFileWrites) && (options.fullPower === true || permissionConfig.fullPower === true);
  const sandboxMode = normalizeSandboxMode(
    options.sandboxMode ?? (requestedFullPower ? "danger-full-access" : permissionConfig.sandboxMode),
    allowFileWrites ? "workspace-write" : "read-only"
  );
  const approvalMode = normalizeApprovalMode(
    options.approvalMode ?? (requestedFullPower ? "never" : permissionConfig.approvalMode),
    sandboxMode === "danger-full-access" ? "never" : "on-request"
  );

  if (sandboxMode === "danger-full-access" && !requestedFullPower) {
    throw new Error("Full power mode requires explicit opt-in with fullPower: true or --full-power.");
  }

  return {
    sandboxMode,
    approvalMode,
    allowFileWrites: Boolean(allowFileWrites) && sandboxMode !== "read-only",
    allowGitOperations: permissionConfig.allowGitOperations !== false,
    fullPower: sandboxMode === "danger-full-access",
    warnings:
      sandboxMode === "danger-full-access"
        ? ["Full power mode disables sandbox restrictions. Use only in trusted repositories."]
        : []
  };
}

export function describePermissionProfile(profile) {
  return [
    `[SYSTEM] Sandbox Mode: ${profile.sandboxMode}`,
    `[SYSTEM] Approval Mode: ${profile.approvalMode}`,
    `[SYSTEM] Write Access: ${profile.allowFileWrites ? "ENABLED" : "DISABLED"}`,
    `[SYSTEM] Git Operations: ${profile.allowGitOperations ? "ENABLED" : "DISABLED"}`
  ];
}

export function detectPermissionIssue(text, profile = null) {
  const body = String(text ?? "");
  const readOnly = READ_ONLY_PATTERNS.some((pattern) => pattern.test(body));
  const approvalBlocked = APPROVAL_PATTERNS.some((pattern) => pattern.test(body));
  if (!readOnly && !approvalBlocked) {
    return null;
  }

  const nextAction = readOnly
    ? "Switch to workspace-write mode to allow edits."
    : "Use approvalMode on-request so Codex can request permission for guarded operations.";

  return {
    readOnly,
    approvalBlocked,
    message: [
      "[SYSTEM] Permission limitation detected.",
      readOnly ? "Codex attempted a write operation while the sandbox was read-only." : null,
      approvalBlocked ? "Codex reported that approval or filesystem permission blocked the operation." : null,
      profile ? `Current sandbox: ${profile.sandboxMode}; approval: ${profile.approvalMode}.` : null,
      nextAction
    ]
      .filter(Boolean)
      .join("\n")
  };
}

export function validateCommandSafety(command, profile = {}) {
  const value = String(command ?? "");
  if (!value.trim()) {
    return { ok: false, reason: "Empty command." };
  }
  if (DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(value))) {
    return {
      ok: profile.fullPower === true,
      reason: "Potentially destructive command requires explicit full power mode."
    };
  }
  return { ok: true, reason: null };
}
