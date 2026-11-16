// What each agent sends the hook, and how each one is told to stop a prompt.
//
// All three pass the prompt as `prompt` in the JSON on stdin and accept a
// JSON decision on stdout with exit 0. They differ in the decision word and
// in extra fields, and an extra field one agent does not know can make it
// treat the hook as failed and let the prompt through (Codex does this), so
// each gets exactly its own documented shape.
//
//   Claude Code  UserPromptSubmit  {"decision":"block","reason"}  + suppressOriginalPrompt
//                https://code.claude.com/docs/en/hooks
//   Codex        UserPromptSubmit  {"decision":"block","reason"}
//                https://learn.chatgpt.com/docs/hooks
//   Gemini CLI   BeforeAgent       {"decision":"deny","reason"}
//                https://geminicli.com/docs/hooks/reference/

export const AGENTS = ['claude', 'codex', 'gemini'] as const;
export type Agent = (typeof AGENTS)[number];

export function isAgent(v: string | undefined): v is Agent {
  return (AGENTS as readonly string[]).includes(v ?? '');
}

export const AGENT_NAMES: Readonly<Record<Agent, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

/** The hook event each agent fires before a prompt is sent. */
export const PROMPT_EVENT: Readonly<Record<Agent, string>> = {
  claude: 'UserPromptSubmit',
  codex: 'UserPromptSubmit',
  gemini: 'BeforeAgent',
};

/** The prompt from the hook's stdin JSON. Throws if the input is not one. */
export function readPrompt(stdin: string): string {
  const input: unknown = JSON.parse(stdin);
  if (typeof input !== 'object' || input === null || !('prompt' in input)) {
    throw new Error('hook input has no "prompt" field');
  }
  const { prompt } = input as { prompt: unknown };
  if (typeof prompt !== 'string') throw new Error('hook input "prompt" is not a string');
  return prompt;
}

/** stdout that stops the prompt. Exit code 0 in every case. */
export function blockOutput(agent: Agent, reason: string): string {
  switch (agent) {
    case 'claude':
      // Without suppressOriginalPrompt, Claude Code ends the block message with
      // "Original prompt:" and the full text: the values we just stopped.
      return JSON.stringify({
        decision: 'block',
        reason,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
      });
    case 'codex':
      return JSON.stringify({ decision: 'block', reason });
    case 'gemini':
      // deny (not continue:false) also drops the message from Gemini's history.
      return JSON.stringify({ decision: 'deny', reason });
  }
}
