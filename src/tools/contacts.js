/**
 * contacts - Read and search contacts.
 * macOS: AppleScript (Contacts app). Google: People API.
 */
import { execSync } from "node:child_process";
import { resolveKey } from "./_env.js";

export async function contacts(_params) {
  const action = _params?.action;
  const paramsJson = _params?.params;
  if (!action) return "Error: action required. Valid: search, list, get";
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  const { provider = "macos" } = params;

  // ── macOS Contacts (AppleScript) ────────────────────────────────────────
  if (provider === "macos") {
    if (process.platform !== "darwin") {
      return "Error: macOS Contacts provider only works on macOS";
    }

    if (action === "search" || action === "list") {
      const query = params.query || "";
      const limit = params.limit || 20;

      const searchFilter = query
        ? `whose (first name contains "${query.replace(/"/g, '\\"')}" or last name contains "${query.replace(/"/g, '\\"')}" or (email addresses is not {} and value of item 1 of email addresses contains "${query.replace(/"/g, '\\"')}"))`
        : "";

      const script = `
        tell application "Contacts"
          set output to ""
          set peopleList to every person ${searchFilter}
          set resultCount to 0
          repeat with aPerson in peopleList
            if resultCount >= ${limit} then exit repeat
            set personName to (first name of aPerson & " " & last name of aPerson)
            set emails to ""
            if (count of email addresses of aPerson) > 0 then
              set emails to value of item 1 of email addresses of aPerson
            end if
            set phones to ""
            if (count of phones of aPerson) > 0 then
              set phones to value of item 1 of phones of aPerson
            end if
            set output to output & personName & " | " & emails & " | " & phones & "\\n"
            set resultCount to resultCount + 1
          end repeat
          return output
        end tell
      `;

      try {
        const out = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { encoding: "utf-8", timeout: 15000 });
        if (!out.trim()) return query ? `No contacts found matching "${query}"` : "No contacts found";
        return `Contacts${query ? ` matching "${query}"` : ""}:\n${out.trim()}`;
      } catch (err) {
        return `Contacts error: ${err.message}. Make sure Contacts app access is granted.`;
      }
    }

    if (action === "get") {
      const { name } = params;
      if (!name) return "Error: name is required";

      const script = `
        tell application "Contacts"
          set aPerson to first person whose (first name & " " & last name) contains "${name.replace(/"/g, '\\"')}"
          set output to "Name: " & first name of aPerson & " " & last name of aPerson & "\\n"
          if (count of email addresses of aPerson) > 0 then
            repeat with anEmail in email addresses of aPerson
              set output to output & "Email (" & label of anEmail & "): " & value of anEmail & "\\n"
            end repeat
          end if
          if (count of phones of aPerson) > 0 then
            repeat with aPhone in phones of aPerson
              set output to output & "Phone (" & label of aPhone & "): " & value of aPhone & "\\n"
            end repeat
          end if
          if organization of aPerson is not missing value then
            set output to output & "Company: " & organization of aPerson & "\\n"
          end if
          return output
        end tell
      `;

      try {
        const out = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { encoding: "utf-8", timeout: 10000 });
        return out.trim() || `No contact found matching "${name}"`;
      } catch (err) {
        return `Contact lookup error: ${err.message}`;
      }
    }
  }

  // ── Google People API ────────────────────────────────────────────────────
  if (provider === "google") {
    const accessToken = resolveKey("GOOGLE_CONTACTS_ACCESS_TOKEN");
    if (!accessToken) return "Error: GOOGLE_CONTACTS_ACCESS_TOKEN env var required";

    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;

    if (action === "list" || action === "search") {
      const query = params.query || "";
      let url;
      if (query) {
        url = `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers`;
      } else {
        url = `https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=${params.limit || 20}`;
      }
      const res = await fetchFn(url, { headers: { "Authorization": `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) return `Google Contacts error: ${data.error?.message}`;
      const people = data.connections || data.results?.map(r => r.person) || [];
      if (!people.length) return "No contacts found";
      return people.map(p => {
        const name = p.names?.[0]?.displayName || "Unknown";
        const email = p.emailAddresses?.[0]?.value || "";
        const phone = p.phoneNumbers?.[0]?.value || "";
        return `${name} | ${email} | ${phone}`;
      }).join("\n");
    }
  }

  return `Unknown action: "${action}" for provider "${provider}". Valid: search, list, get`;
}

export const contactsDescription =
  `contacts(action: string, paramsJson?: object) - Search and read contacts.
  action: "search" | "list" | "get"
  params.provider: "macos" (default, Contacts app) | "google" (People API)
  search/list params: { query?, limit?: 20 }
  get params: { name }
  Env vars: GOOGLE_CONTACTS_ACCESS_TOKEN
  Examples:
    contacts("search", {"query":"John"})
    contacts("list", {"limit":10})
    contacts("get", {"name":"Alice Smith"})
    contacts("search", {"provider":"google","query":"alice"})`;
