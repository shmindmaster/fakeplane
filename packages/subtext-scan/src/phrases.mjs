/**
 * Phrasing aimed at a model or an automated reviewer rather than at a human reader.
 *
 * Each rule has an id, a one-line description and a pattern. The patterns are deliberately
 * specific: they run over every visible line too, and a security-awareness document that quotes
 * an attack will still match (as a medium finding, not a high one). A regex list cannot recognise
 * an instruction it has not seen worded before; hidden-text detection does not depend on it.
 */

const AI = String.raw`(?:ai|a\.i\.|llm|large language model|language model|model|assistant|agent|chatbot|bot|gpt|chatgpt|claude|gemini|copilot|automated (?:system|reviewer|screener|grader|agent|assistant|tool|process)|reviewer|screener|grader)`;
const OBJ = String.raw`(?:invoice|claim|payment|application|applicant|candidate|resume|résumé|cv|submission|paper|manuscript|proposal|certificate|packet|package|request|transaction|document|contract|vendor|supplier|refund|student|essay|report|file|ticket|order|product|service|company|business|listing|seller|app|website|site|item|offer|loan|property)`;
const GOOD = String.raw`(?:top|highest|best|strong(?:est)?|excellent|outstanding|approved?|accept(?:ed|able)?|complete|conforming|compliant|valid|legitimate|genuine|safe|benign|clean|eligible|qualified|verified|trusted|low[- ]risk|a\+?|10\/10|5 stars?|hire|pass(?:ed)?)`;

export const PHRASE_RULES = [
  {
    id: 'ignore-instructions',
    description: 'Tells the reader to ignore or override the instructions it was given.',
    pattern: String.raw`\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:(?:previous|prior|above|earlier|preceding|original|system)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules|directions|directives|guidelines|guardrails|context|messages)|(?:all|any|your|the|existing)\s+(?:of\s+)?(?:your\s+|the\s+|my\s+)?(?:instructions|prompts?|rules|directives|guidelines|guardrails))\b`,
  },
  {
    id: 'addresses-ai',
    description: 'Speaks directly to an AI, model or automated reviewer.',
    pattern: String.raw`\b(?:note|message|memo|attention|instructions?|hint|reminder|directive)s?\s*(?:to|for)\s+(?:the\s+|any\s+|all\s+)?${AI}s?\b|\b(?:if|when) you are an?\s+${AI}\b|\b(?:dear|hey|hello|hi)\s+${AI}\b|(?:^|[.!?]\s+)(?:ai|llm|chatgpt|claude|gemini|copilot|(?:ai|llm) (?:assistant|agent|model|reviewer|screener)s?)\s*[:,]\s+(?:please|you|ignore|do|don't|always|never|recommend|rate|rank|approve|tell|say|summari[sz]e|respond|reply|answer|disregard|forget)\b|\b(?:ai|automated|llm)[- ](?:reviewers?|screeners?|graders?|assistants?|agents?)\b(?=[^.\n]{0,40}\b(?:should|must|please|will|is to|are to)\b)`,
  },
  {
    id: 'new-instructions',
    description: 'Introduces replacement or hidden instructions.',
    pattern: String.raw`\b(?:new|updated|real|actual|true|hidden|secret|additional|revised|override)\s+(?:system\s+)?(?:instructions?|prompt|directives?|orders)\s*[:\-–—]|\b(?:begin|start|end)\s+(?:of\s+)?(?:system|hidden|secret)\s+(?:prompt|instructions?)\b|\bfrom now on,?\s+you\b`,
  },
  {
    id: 'role-override',
    description: 'Tries to change the reader’s role or unlock a jailbreak mode.',
    pattern: String.raw`\byou are now (?:an?|the|in|my|no longer|dan|free|unrestricted|unfiltered|jailbroken)\b|\byou are no longer\b|\b(?:developer|god|dan|jailbreak|unrestricted|sudo) mode\b|\bjailbreak(?:en|ed|ing)?\b|\bpretend (?:that )?you (?:are|have no)\b`,
  },
  {
    id: 'reveal-prompt',
    description: 'Asks the reader to reveal its system prompt or instructions.',
    pattern: String.raw`\b(?:reveal|print|show|repeat|output|leak|disclose|recite|dump)\b[^.\n]{0,30}\b(?:system prompt|system message|hidden prompt|initial (?:prompt|instructions)|your (?:instructions|prompt|rules))\b`,
  },
  {
    id: 'chat-markup',
    description: 'Contains chat-template control tokens used to fake a system or assistant turn.',
    pattern: String.raw`<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>|^\s*#{2,}\s*(?:system|instruction)s?\s*:?\s*$`,
    flags: 'im',
  },
  {
    id: 'verdict-steering',
    description: 'Tells the reader what verdict, ranking or approval to give.',
    pattern: String.raw`\b(?:rank|rate|score|grade|recommend|classify|mark|treat|consider|flag|label|list|report)\b[^.\n]{0,15}?\b(?:this|the)\s+${OBJ}\b[^.\n]{0,40}?\b${GOOD}\b|\b(?:approve|accept|greenlight|whitelist|allowlist|auto-approve|release)\b[^.\n]{0,20}?\b(?:this|the)\s+${OBJ}\b[^.\n]{0,20}?\b(?:immediately|automatically|without (?:review|checks?|verification|question))\b|\bapprove (?:the )?release\b|\b(?:waived?|skip(?:ped)?|not required)\b[^.\n]{0,40}\b(?:treat|mark|consider)\s+(?:this|the)\b`,
  },
  {
    id: 'conceal-from-user',
    description: 'Tells the reader to hide something from the user or reviewer.',
    pattern: String.raw`\b(?:do not|don't|never)\s+(?:tell|inform|mention|reveal|disclose|alert|notify|warn|show)\s+(?:this\s+to\s+)?(?:the\s+)?(?:user|human|reviewer|operator|customer|recruiter|hiring manager|anyone)\b|\bwithout (?:telling|informing|notifying|alerting)\s+(?:the\s+)?(?:user|human|reviewer|operator)\b|\b(?:the\s+)?(?:human|user|reader|reviewer)s?\s+(?:will not|won't|cannot|can't|will never)\s+see\s+(?:this|these)\b`,
  },
  {
    id: 'exfiltrate',
    description: 'Asks the reader to send secrets, credentials or conversation data somewhere.',
    pattern: String.raw`\b(?:send|forward|email|e-mail|post|upload|exfiltrate|transmit|leak|copy|include)\b[^.\n]{0,40}\b(?:credentials?|passwords?|api[- ]?keys?|access tokens?|secrets?|conversation|chat history|system prompt|environment variables|\.env|ssh keys?|session cookies?|(?:the\s+)?(?:user'?s?|users'|customer'?s?)\s+(?:data|files|emails?|messages|details))\b[^.\n]{0,60}\b(?:to|at|into)\b[^.\n]{0,20}(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|!\[)`,
  },
  {
    id: 'execute-command',
    description: 'Asks the reader to run a command, script or tool call.',
    pattern: String.raw`\b(?:execute|run|invoke|call)\s+(?:the\s+)?(?:following|this|these)\s+(?:shell\s+)?(?:commands?|code|script|tool calls?|functions?)\b|\b(?:curl|wget)\s+https?:\/\/\S+\s*\|\s*(?:ba)?sh\b`,
  },
].map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, `${rule.flags ?? 'i'}gu`) }));

/** Every phrase rule that matches `text`, with the matched span. */
export function findInstructionPhrases(text) {
  if (!text) return [];
  const hits = [];
  for (const rule of PHRASE_RULES) {
    rule.regex.lastIndex = 0;
    for (const m of text.matchAll(rule.regex)) {
      hits.push({ id: rule.id, match: m[0].trim(), index: m.index });
      if (hits.length > 200) return hits;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
