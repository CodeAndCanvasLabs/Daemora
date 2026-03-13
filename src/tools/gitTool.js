/**
 * gitTool - Git operations: clone, status, diff, log, commit, push, pull, branch, checkout, stash.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { mergeLegacyParams } from "../utils/mergeToolParams.js";

const MAX_OUTPUT = 8000;

function run(cmd, cwd) {
  return execSync(cmd, { encoding: "utf-8", cwd, timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export async function gitTool(_params) {
  const action = _params?.action;
  if (!action) return 'Error: action required. Valid: clone, status, diff, log, commit, push, pull, branch, checkout, stash, add, reset, remote';

  const params = mergeLegacyParams(_params);

  const repoPath = params.path ? resolve(params.path) : process.cwd();

  if (action !== "clone") {
    const guard = filesystemGuard.checkRead(repoPath);
    if (!guard.allowed) return `Access denied: ${guard.reason}`;
  }

  try {
    switch (action) {

      case "clone": {
        const { url, dest, branch } = params;
        if (!url) return "Error: url is required for clone.";
        if (!dest) return "Error: dest is required for clone.";
        const destResolved = resolve(dest);
        const parentGuard = filesystemGuard.checkWrite(destResolved);
        if (!parentGuard.allowed) return `Access denied: ${parentGuard.reason}`;
        const branchFlag = branch ? `-b ${branch}` : "";
        return run(`git clone ${branchFlag} "${url}" "${destResolved}"`);
      }

      case "status":
        return run(`git status`, repoPath);

      case "diff": {
        const { staged = false, file = "" } = params;
        const flag = staged ? "--staged" : "";
        const out = run(`git diff ${flag} ${file}`.trim(), repoPath);
        return out.slice(0, MAX_OUTPUT) || "(no changes)";
      }

      case "log": {
        const { n = 20, oneline = true } = params;
        const fmt = oneline ? "--oneline" : `--pretty=format:"%h %an %ar - %s"`;
        return run(`git log ${fmt} -n ${n}`, repoPath);
      }

      case "add": {
        const { files = "." } = params;
        const fileList = Array.isArray(files) ? files.join(" ") : files;
        run(`git add ${fileList}`, repoPath);
        return `Staged: ${fileList}`;
      }

      case "commit": {
        const { message, all = false } = params;
        if (!message) return "Error: message is required for commit.";
        const allFlag = all ? "-a" : "";
        return run(`git commit ${allFlag} -m ${JSON.stringify(message)}`, repoPath);
      }

      case "push": {
        const { remote = "origin", branch: br = "", force = false } = params;
        const forceFlag = force ? "--force-with-lease" : "";
        return run(`git push ${forceFlag} ${remote} ${br}`.trim(), repoPath);
      }

      case "pull": {
        const { remote = "origin", branch: br = "", rebase = false } = params;
        const rebaseFlag = rebase ? "--rebase" : "";
        return run(`git pull ${rebaseFlag} ${remote} ${br}`.trim(), repoPath);
      }

      case "branch": {
        const { name, delete: del, list = false } = params;
        if (list || !name) return run(`git branch -a`, repoPath);
        if (del) return run(`git branch -d "${name}"`, repoPath);
        return run(`git branch "${name}"`, repoPath);
      }

      case "checkout": {
        const { branch: br, file, create = false } = params;
        if (file) return run(`git checkout -- "${file}"`, repoPath);
        if (!br) return "Error: branch is required for checkout.";
        const createFlag = create ? "-b" : "";
        return run(`git checkout ${createFlag} "${br}"`, repoPath);
      }

      case "stash": {
        const { sub = "push", message: msg = "" } = params;
        if (sub === "push") return run(`git stash push ${msg ? `-m ${JSON.stringify(msg)}` : ""}`, repoPath);
        if (sub === "pop")  return run(`git stash pop`, repoPath);
        if (sub === "list") return run(`git stash list`, repoPath);
        if (sub === "drop") return run(`git stash drop`, repoPath);
        return `Unknown stash subcommand: ${sub}`;
      }

      case "reset": {
        const { hard = false, file } = params;
        if (file) return run(`git reset HEAD "${file}"`, repoPath);
        return run(`git reset ${hard ? "--hard" : "--soft"} HEAD~1`, repoPath);
      }

      case "remote":
        return run(`git remote -v`, repoPath);

      default:
        return `Unknown action: "${action}". Valid: clone, status, diff, log, add, commit, push, pull, branch, checkout, stash, reset, remote`;
    }
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || "";
    const stdout = err.stdout?.toString().trim() || "";
    return `Git error: ${stderr || stdout || err.message}`;
  }
}

export const gitToolDescription =
  `gitTool(action: string, paramsJson?: string) - Git operations on a repository.
  Actions:
    clone    - {"url":"https://github.com/...","dest":"./myrepo","branch":"main"}
    status   - {"path":"./myrepo"}
    diff     - {"path":"./myrepo","staged":false,"file":"src/index.js"}
    log      - {"path":"./myrepo","n":20,"oneline":true}
    add      - {"path":"./myrepo","files":["src/index.js","README.md"]}
    commit   - {"path":"./myrepo","message":"fix: bug in auth","all":false}
    push     - {"path":"./myrepo","remote":"origin","branch":"main","force":false}
    pull     - {"path":"./myrepo","remote":"origin","rebase":false}
    branch   - {"path":"./myrepo","name":"feature/x"} or {"list":true}
    checkout - {"path":"./myrepo","branch":"main"} or {"create":true,"branch":"feature/x"}
    stash    - {"path":"./myrepo","sub":"push|pop|list|drop","message":"wip"}
    reset    - {"path":"./myrepo","hard":false}
    remote   - {"path":"./myrepo"}`;
