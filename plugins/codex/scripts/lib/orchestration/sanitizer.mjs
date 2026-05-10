const COMMAND_PREFIX_PATTERN = /^\/?(?:codex:)?([a-z][a-z0-9-]*)(?:\s+|$)/i;

const DEFAULT_COMMANDS = new Set([
  "adversarial-review",
  "cancel",
  "codex-inline",
  "debate",
  "mode",
  "pair",
  "parallel",
  "rescue",
  "result",
  "review",
  "setup",
  "status"
]);

function trimHorizontal(value) {
  return String(value ?? "").replace(/^[\t ]+|[\t ]+$/g, "");
}

export function sanitizeCommandPrompt(prompt, options = {}) {
  const knownCommands = options.knownCommands ?? DEFAULT_COMMANDS;
  let text = String(prompt ?? "").replace(/\r\n/g, "\n");
  let changed = false;

  for (let index = 0; index < 12; index += 1) {
    const trimmed = text.replace(/^[\t \n]+/, "");
    const leadingWhitespaceRemoved = trimmed.length !== text.length;
    const match = trimmed.match(COMMAND_PREFIX_PATTERN);
    if (!match || !knownCommands.has(match[1].toLowerCase())) {
      text = leadingWhitespaceRemoved ? trimmed : text;
      break;
    }
    text = trimmed.slice(match[0].length);
    changed = true;
  }

  return {
    text: trimHorizontal(text).replace(/[ \t]+\n/g, "\n"),
    changed
  };
}
