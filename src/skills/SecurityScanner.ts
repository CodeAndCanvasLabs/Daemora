/**
 * SecurityScanner — detects prompt injection and exfiltration patterns
 * in skill content and memory content. Shared by:
 *   - SkillLoader (warns on load)
 *   - skill_manage (rolls back writes)
 *   - DeclarativeMemoryStore (rejects writes)
 *
 * Ported from hermes tools/memory_tool.py threat list + skills_guard.
 * Patterns are conservative: false positives are preferred to false
 * negatives because skill/memory content goes into the system prompt.
 */

const INVISIBLE_CHARS = [
  "\u200B", "\u200C", "\u200D", "\u200E", "\u200F",
  "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
  "\u2060", "\u2061", "\u2062", "\u2063", "\u2064",
  "\uFEFF",
];

interface ThreatPattern {
  readonly re: RegExp;
  readonly id: string;
}

const THREAT_PATTERNS: readonly ThreatPattern[] = [
  // Prompt injection
  { re: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { re: /disregard\s+(your|all|above|prior)/i, id: "prompt_injection" },
  { re: /forget\s+(your|all|prior|previous)\s+instructions/i, id: "prompt_injection" },
  { re: /new\s+instructions\s*:/i, id: "prompt_injection" },
  { re: /system\s+prompt\s*:/i, id: "role_hijack" },
  { re: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { re: /<\s*system\s*>/i, id: "role_hijack" },
  { re: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  // Exfiltration via curl/wget with secrets
  { re: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { re: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget" },
  // Persistence via shell rc / ssh keys
  { re: /authorized_keys/i, id: "ssh_backdoor" },
  { re: /\$HOME\/\.ssh|~\/\.ssh/i, id: "ssh_access" },
  { re: /\.bashrc|\.zshrc|\.profile/i, id: "shell_rc_write" },
];

export interface ScanResult {
  readonly blocked: boolean;
  readonly reason: string | null;
  readonly pattern: string | null;
}

export function scanContent(content: string): ScanResult {
  for (const ch of INVISIBLE_CHARS) {
    if (content.includes(ch)) {
      return { blocked: true, reason: "content contains invisible unicode", pattern: "invisible_unicode" };
    }
  }
  for (const p of THREAT_PATTERNS) {
    if (p.re.test(content)) {
      return { blocked: true, reason: `matches threat pattern '${p.id}'`, pattern: p.id };
    }
  }
  return { blocked: false, reason: null, pattern: null };
}
