const screens = new Map([
    [
        '',
        `Mnemonik is the memory and continuity layer for AI coding agents: it keeps
them grounded while they work, through long tasks and context compression,
and across sessions, tools, machines, agents, and teams. It quietly carries
forward the codebase's history, decisions, conventions, and accumulated
experience, giving every agent the context to act as part of an ongoing body
of work rather than as an intelligence encountering it for the first time.

Usage: mnemonik <command> [options]

Commands
  install                     Set up Mnemonik on this machine.
  status                      Show whether Mnemonik is working here.
  add <folder>                Start indexing a project folder.
  remove <folder>             Stop indexing a project folder.
  connect <editor>            Sign an editor in to Mnemonik.
  project <subcommand>        Manage the project in a folder.
  update                      Update Mnemonik on this machine.
  repair                      Re-apply the installation on this machine.
  doctor                      Check this machine and explain any problem.
  uninstall                   Remove Mnemonik from this machine.
  auth <subcommand>           Sign in, sign out, or see what is signed in.
  logout                      Sign this machine out.

Run mnemonik <command> --help for that command's arguments and options.

Example
  mnemonik install

Global options
  --json                      Print machine-readable output and never ask.
  --non-interactive           Never ask; fail instead when an answer is needed.
  --no-browser                Print sign-in links instead of opening a browser.
  --help                      Show help for a command. Changes nothing.
  --version                   Print the installed version.

Exit codes
  0  done        1  failed        2  wrong usage
  3  something on this machine or your account needs attention
  130  cancelled
`,
    ],
    [
        'install',
        `Set up Mnemonik on this machine: sign in, connect your editors, choose the
project folders to index, and start background indexing. Asks before each
step unless you pass the consent options below.

Usage: mnemonik install [options]

Options
  --hosts <list>              Editors to connect: claude-code, codex, cursor.
                              Default: every editor found on this machine.
  --components <list>         Set up only these parts: hooks, mcp, scanner.
                              Default: all three.
  --scan-roots <list>         Project folders to index, comma separated.
  --exclusions <list>         Folders inside those to skip, comma separated.
  --without-scanner           Connect editors only; do not index anything.
  --accept-indexing           Agree to index the folders in --scan-roots.
  --accept-limited            Agree to a limited setup with no indexing.
  --apply                     Make the changes. Required with --non-interactive.
  --dry-run                   Show what would happen and change nothing.
  --no-browser                Print the sign-in link instead of opening it.

With --non-interactive or --json, pass --apply, --scan-roots and either
--accept-indexing or --accept-limited, or the command stops with exit 3.

Example
  mnemonik install --non-interactive --apply --accept-indexing \\
    --scan-roots ~/projects/app,~/projects/site
`,
    ],
    [
        'status',
        `Show whether Mnemonik is installed and working on this machine, which
editors are connected, and which folders are indexed. Works signed out.
When signed in, it updates this machine's status in your account so the
console shows it.

Usage: mnemonik status [--json]

Example
  mnemonik status
`,
    ],
    [
        'add',
        `Start indexing a project folder. Connects the folder to a project in your
account (creating one if the folder has none), writes a .mnemonik.json file
in it, and adds it to background indexing. Asks first unless you pass the
options below. The folder must be a project's top folder, not a folder
inside one.

Usage: mnemonik add <folder> [options]

Arguments
  <folder>                    The project folder. Required.

Options
  --accept-indexing           Agree to index this folder without being asked.
  --apply                     Make the change. Required with --non-interactive.

Example
  mnemonik add ~/projects/app
`,
    ],
    [
        'remove',
        `Stop indexing a project folder. The project and its memories stay in your
account; only this machine stops sending it. Asks first.

Usage: mnemonik remove <folder> [--apply]

Arguments
  <folder>                    The project folder. Required.

Options
  --apply                     Stop without being asked. Required with
                              --non-interactive or --json.
  --accept-indexing           Accept the updated indexing terms for the folders
                              that stay. Only when remove asks for it.

Example
  mnemonik remove ~/projects/old-site
`,
    ],
    [
        'connect',
        `Sign an editor in to Mnemonik. For Codex, prints one link; open it in any
browser, approve, and Codex on this machine is signed in, including over
SSH. For Claude Code and Cursor, prints the steps to sign in inside the
editor.

Usage: mnemonik connect <editor>

Arguments
  <editor>                    claude-code, codex, or cursor. Required.

Example
  mnemonik connect codex
`,
    ],
    [
        'project',
        `Manage the project a folder belongs to. A folder is a project when it has a
.mnemonik.json file; add, install and project init create one.

Usage: mnemonik project <subcommand> [options]

Subcommands
  status [path]               Show which project this folder belongs to.
  init [path]                 Make this folder a new project in your account.
  link <project-id> [path]    Make this folder belong to an existing project.
  setup [path]                Connect this folder, using a matching project
                              or creating one.
  delete [id or name]         Delete a project and everything in it.
  ensure                      For agents: connect this folder, creating a
                              project if needed, and print the result.

Run mnemonik project <subcommand> --help for details.

Example
  mnemonik project status
`,
    ],
    [
        'project status',
        `Show which project this folder belongs to, from its .mnemonik.json file and
your account. Changes nothing.

Usage: mnemonik project status [path]

Arguments
  [path]                      The folder to check. Default: current folder.

Example
  mnemonik project status
`,
    ],
    [
        'project init',
        `Make this folder a new project in your account and write its .mnemonik.json
file. Use it when a folder was never connected. Asks first unless you pass
--apply.

Usage: mnemonik project init [path] [options]

Arguments
  [path]                      The project folder. Default: current folder.

Options
  --apply                     Make the change. Required with --non-interactive.
  --owner <account-id>        Create the project under another account you
                              belong to.

Example
  mnemonik project init --apply
`,
    ],
    [
        'project link',
        `Make this folder belong to an existing project, for example after cloning a
repository on a new machine. Rewrites the folder's .mnemonik.json file.

Usage: mnemonik project link <project-id> [path] [options]

Arguments
  <project-id>                The project to link to. Required.
  [path]                      The folder. Default: current folder.

Options
  --apply                     Make the change. Required with --non-interactive.
  --replace                   Replace a .mnemonik.json that names another
                              project.
  --confirm-mismatch          Link even if the folder's Git remote is not the
                              one the project was set up with.

Example
  mnemonik project link <project-id> ~/projects/app --apply
`,
    ],
    [
        'project setup',
        `Show what connecting this folder to a project would do, then do it: use an
existing project that matches, or create one. install and add run this for
you; use it directly when a folder was never connected. Asks first.

Usage: mnemonik project setup [path] [options]

Arguments
  [path]                      The folder. Default: the current folder.

Options
  --owner <team-or-user>      Create the project under this owner.
  --apply                     Make the changes. Required with
                              --non-interactive or --json.

Example
  mnemonik project setup ~/projects/app
`,
    ],
    [
        'project delete',
        `Delete a project: its memories, code index and summaries, for everyone.
This cannot be undone. Only the project's owner can delete it. The folder
and its .mnemonik.json file stay on disk; the folder leaves background
indexing on this machine. Asks you to type the project's name unless you
pass --confirm.

Usage: mnemonik project delete [id or name] [options]

Arguments
  [id or name]                The project to delete. Default: the project
                              this folder belongs to.

Options
  --confirm "<name>"          Skip the question by giving the project's name.
                              Required with --non-interactive or --json.

Example
  mnemonik project delete "Old Site" --confirm "Old Site"
`,
    ],
    [
        'project ensure',
        `For agents. Connect the current folder to a project, creating one in your
account if the folder has none, and print the result as JSON. Never asks.

Usage: mnemonik project ensure

Example
  mnemonik project ensure
`,
    ],
    [
        'update',
        `Update Mnemonik on this machine: the mnemonik command, the editor hooks, and
background indexing if it is installed. Restarts background indexing when
its software changes. Safe to run while an editor is open.

Usage: mnemonik update [options]

Options
  --host <editor>             Update one editor's hooks only: claude-code,
                              codex, cursor.
  --component scanner         Update background indexing only.
  --automatic                 Print nothing. Used by scheduled updates.

Example
  mnemonik update
`,
    ],
    [
        'repair',
        `Re-apply the installation recorded on this machine: the mnemonik command and
each editor's connection and hooks. Use it when status or doctor reports
something missing.

Usage: mnemonik repair [options]

Options
  --host <editor>             Repair one editor only: claude-code, codex, cursor.
  --component <name>          Repair one part only: hooks, mcp.
  --apply                     Also switch Codex's hooks back on if Codex has
                              them turned off. Only when repair asks for it.

Example
  mnemonik repair
`,
    ],
    [
        'doctor',
        `Check this machine and explain any problem in plain words: Node version,
file permissions, the installed files, the editor connections and
background indexing. Changes nothing and sends nothing.

Usage: mnemonik doctor [--json]

Example
  mnemonik doctor
`,
    ],
    [
        'uninstall',
        `Remove Mnemonik from this machine: editor connections and hooks, background
indexing, and the mnemonik command. Your account, your projects' memories
and your consent records are kept; sign in again on any machine to
continue. Asks first unless you pass --confirm.

Usage: mnemonik uninstall [options]

Options
  --host <editor>             Disconnect one editor only.
  --component scanner         Remove background indexing only.
  --confirm                   Skip the question. Required with --non-interactive.

Example
  mnemonik uninstall --confirm
`,
    ],
    [
        'auth',
        `Sign this machine in or out, and see which editors are signed in.

Usage: mnemonik auth <subcommand> [options]

Subcommands
  login                       Sign this machine in to your account.
  status [--host <editor>]    Show what is signed in and since when.
  logout [--host <editor>]    Sign out this machine, or one editor.

Run mnemonik auth <subcommand> --help for details.

Example
  mnemonik auth status
`,
    ],
    [
        'auth login',
        `Sign this machine in to your Mnemonik account. Prints a link and a code;
approve in any browser. Already signed in? Shows who.

Usage: mnemonik auth login [options]

Options
  --no-browser                Print the link instead of opening it.
  --reopen-install            Continue an installation this account started
                              and did not finish.

Example
  mnemonik auth login --no-browser
`,
    ],
    [
        'auth status',
        `Show what is signed in from this machine: the account, and each editor's
sign-in with when it was created and last used. Changes nothing.

Usage: mnemonik auth status [--host <editor>]

Options
  --host <editor>             One editor only: claude-code, codex, cursor.

Example
  mnemonik auth status
`,
    ],
    [
        'auth logout',
        `Sign out. With no options, signs this machine's mnemonik command out and
leaves editors as they are. With --host, signs one editor out of your
account so it must sign in again. Asks first unless you pass --confirm.

Usage: mnemonik auth logout [--host <editor>] [--confirm]

Options
  --host <editor>             Sign out one editor: claude-code, codex, cursor.
  --component scanner         Revoke background indexing's access to your
                              account. Indexing stops on its next upload.
  --confirm                   Skip the question.

Example
  mnemonik auth logout --host codex --confirm
`,
    ],
    [
        'logout',
        `Sign this machine's mnemonik command out. Editors stay signed in. Same as
mnemonik auth logout with no options.

Usage: mnemonik logout

Example
  mnemonik logout
`,
    ],
    [
        'scanner',
        `Control background indexing on this machine. Most people never need these;
install, status, update and repair handle indexing for you.

Usage: mnemonik scanner <subcommand> [options]

Subcommands
  status                      Show whether indexing is running and what it covers.
  start                       Start indexing if it is stopped.
  stop                        Stop indexing until the next start or restart.
  pause                       Pause indexing while it stays running.
  resume                      Resume paused indexing.
  enable                      Set indexing up again from scratch.
  uninstall                   Remove background indexing from this machine.
  export-preview --out <file> Write what indexing would send, for you to read.

Run mnemonik scanner <subcommand> --help for details.

Example
  mnemonik scanner status
`,
    ],
    [
        'scanner enable',
        `Set background indexing up from scratch: choose folders, record your
consent, and install and start the indexing service. install does this for
you; use enable only after uninstall.

Usage: mnemonik scanner enable [options]

Options
  --scan-roots <list>         Project folders to index, comma separated.
  --exclusions <list>         Folders inside those to skip.
  --accept-indexing           Agree to index those folders.
  --apply                     Make the changes.

With --non-interactive or --json, all three of --scan-roots,
--accept-indexing and --apply are required.

Example
  mnemonik scanner enable --scan-roots ~/projects --accept-indexing --apply
`,
    ],
    [
        'scanner start',
        `Start background indexing if it is stopped. Says so if it is already
running.

Usage: mnemonik scanner start [--json]

Example
  mnemonik scanner start
`,
    ],
    [
        'scanner stop',
        `Stop background indexing. It starts again when this machine restarts.

Usage: mnemonik scanner stop [--json]

Example
  mnemonik scanner stop
`,
    ],
    [
        'scanner pause',
        `Pause indexing while the service keeps running. Nothing is sent until you
run resume.

Usage: mnemonik scanner pause [--json]

Example
  mnemonik scanner pause
`,
    ],
    [
        'scanner resume',
        `Resume paused indexing.

Usage: mnemonik scanner resume [--json]

Example
  mnemonik scanner resume
`,
    ],
    [
        'scanner status',
        `Show whether background indexing is running, which folders it covers, and
when each was last sent. Changes nothing.

Usage: mnemonik scanner status [--json]

Example
  mnemonik scanner status
`,
    ],
    [
        'scanner uninstall',
        `Stop background indexing and remove it from this machine. Your consent and
cloud data are kept; run mnemonik scanner enable to set it up again.

Usage: mnemonik scanner uninstall [--json]

Example
  mnemonik scanner uninstall
`,
    ],
    [
        'scanner export-preview',
        `Write to a file exactly what background indexing would send for its
folders, so you can read it before anything leaves this machine. Sends
nothing.

Usage: mnemonik scanner export-preview --out <file>

Options
  --out <file>                Where to write the preview. Required.

Example
  mnemonik scanner export-preview --out ~/mnemonik-preview.json
`,
    ],
    [
        'roots',
        `Older names for add and remove, plus a list of the indexed folders.

Usage: mnemonik roots <subcommand> [folder]

Subcommands
  add <folder>                Same as mnemonik add <folder>.
  remove <folder>             Same as mnemonik remove <folder>.
  list                        Show the folders being indexed. Changes nothing.

Options
  --accept-indexing           Accept the updated indexing terms for the folders
                              that stay. Only when remove asks for it.

Example
  mnemonik roots list
`,
    ],
    [
        'data delete',
        `Delete everything background indexing has sent for one project from your
account, and confirm the count is zero. The project and its memories stay.
Asks first.

Usage: mnemonik data delete --project <id> [--confirm]

Options
  --project <id>              The project. Required.
  --confirm                   Delete without being asked. Required with
                              --non-interactive or --json.

Example
  mnemonik data delete --project <project-id>
`,
    ],
    [
        'diagnostics',
        `Prepare and send a diagnostics bundle when support asks for one. preview
writes the bundle to a file for you to read first; send uploads it.

Usage: mnemonik diagnostics preview [--out <file>]
       mnemonik diagnostics send <bundle-id>

Options
  --out <file>                Where preview writes the bundle.

Arguments
  <bundle-id>                 The id preview printed, once you have read
                              the file and want support to have it.

Example
  mnemonik diagnostics preview
`,
    ],
    [
        'identity migrate',
        `Bring older .mnemonik.json files up to the current format. Reports by
default and changes nothing; --backup saves copies; --apply rewrites them;
--verify checks the result; --rollback restores a saved run.

Usage: mnemonik identity migrate [paths...] [options]

Arguments
  [paths...]                  Extra folders to check, on top of the projects
                              your editors already know about. Only with
                              --report and --backup.

Options
  --report                    List what would change. The default.
  --backup                    Save a copy of each file before changing it.
  --apply                     Rewrite the files.
  --verify                    Check that rewritten files are correct.
  --rollback <run-id>         Restore the copies saved by an earlier --backup.

Example
  mnemonik identity migrate --report
`,
    ],
]);
const groupsWithSubcommandHelp = new Set(['auth', 'project', 'scanner']);
const sharedGroupScreens = new Map([
    ['diagnostics', new Set(['preview', 'send'])],
    ['roots', new Set(['add', 'remove', 'list'])],
]);
export function helpScreen(positionals) {
    if (!positionals.length)
        return screens.get('');
    const [command, subcommand] = positionals;
    if (groupsWithSubcommandHelp.has(command ?? '') && subcommand)
        return screens.get(`${command} ${subcommand}`);
    const sharedSubcommands = sharedGroupScreens.get(command ?? '');
    if (sharedSubcommands && subcommand)
        return sharedSubcommands.has(subcommand) ? screens.get(command ?? '') : undefined;
    if ((command === 'data' || command === 'identity') && subcommand)
        return screens.get(`${command} ${subcommand}`);
    return screens.get(command ?? '');
}
//# sourceMappingURL=help.js.map