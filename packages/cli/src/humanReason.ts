type ReadinessMessage = { sentence: string; nextStep: string };

// Said only when Codex's own records show the registered hooks untrusted, so
// Codex skips them. Codex re-reads its hooks every turn: nothing to restart.
export const CODEX_TRUST_MESSAGE = {
  sentence: 'Codex is not running the Mnemonik hooks until you trust them.',
  nextStep: 'Run codex, then approve the Mnemonik hooks when it asks.',
} satisfies ReadinessMessage;

// The scanner stopped because its saved consent names an older notice (or
// folders nobody approved). Resume cannot help; enable asks once in the browser.
export const SCANNER_CONSENT_MESSAGE = {
  sentence: 'Background indexing is paused until you approve an updated notice.',
  nextStep: 'Run mnemonik scanner enable.',
} satisfies ReadinessMessage;

// A newer scanner waits for the same approval while the current one keeps indexing.
export const SCANNER_UPDATE_CONSENT_MESSAGE = {
  sentence: 'A scanner update is waiting until you approve an updated notice.',
  nextStep: 'Run mnemonik scanner enable.',
} satisfies ReadinessMessage;

// An earlier install run stopped part-way and holds the install journal, so
// nothing that needs it can proceed until install finishes or removes it.
export const INTERRUPTED_INSTALL =
  /^(?:resolve_interrupted_install_first|Resolve interrupted install first)$/u;
export const INTERRUPTED_INSTALL_MESSAGE = {
  sentence: 'An earlier installation on this computer did not finish.',
  nextStep: 'Run mnemonik install to finish or remove it.',
} satisfies ReadinessMessage;

const readinessMessages: Array<[RegExp, ReadinessMessage]> = [
  [INTERRUPTED_INSTALL, INTERRUPTED_INSTALL_MESSAGE],
  [/scanner_consent_required/u, SCANNER_CONSENT_MESSAGE],
  [/scanner_update_consent_required|release_consent_required/u, SCANNER_UPDATE_CONSENT_MESSAGE],
  [
    /^(?:discovery_failed|unreachable)$/u,
    {
      sentence: 'Mnemonik could not be reached.',
      nextStep: 'Check your internet connection, then try again.',
    },
  ],
  [
    // The server answered, so the connection is fine and the fault is ours.
    /^(?:discovery_unavailable|server_error)$/u,
    {
      sentence: 'Mnemonik is not available right now.',
      nextStep: 'Try again in a few minutes.',
    },
  ],
  [
    /^not_signed_in$/u,
    {
      sentence: 'This computer is not signed in to Mnemonik.',
      nextStep: 'Run mnemonik install to sign in.',
    },
  ],
  [
    // The server no longer accepts this computer's sign-in: expired or revoked.
    /^renew$/u,
    {
      sentence: 'Mnemonik no longer accepts the sign-in on this computer.',
      nextStep: 'Run mnemonik auth renew, then try again.',
    },
  ],
  [
    /^revoke_failed_(?:401|403)$/u,
    {
      sentence: 'Mnemonik could not sign this computer out.',
      nextStep: 'Run mnemonik auth login, then try again.',
    },
  ],
  [/host_trust_pending|trust_pending/iu, CODEX_TRUST_MESSAGE],
  [
    /vendor_policy_pending|vendor policy/iu,
    {
      sentence: 'Your coding tool is waiting for permission to use Mnemonik.',
      nextStep: 'Open the coding tool, approve Mnemonik, then start a new session.',
    },
  ],
  [
    /restart_pending|needs? (?:a )?restart/iu,
    {
      sentence: 'A coding tool needs to restart before Mnemonik can work.',
      nextStep: 'Quit and reopen the coding tool, then start a new session.',
    },
  ],
  [
    /project_identity_choice_pending|project_setup_required|pending project setup/iu,
    {
      sentence: 'A project on this machine still needs to be connected.',
      nextStep: 'Open that project folder and run mnemonik add there.',
    },
  ],
  [
    // A paused scanner is waiting for the person, not for time: waiting a
    // minute changes nothing. Checked before the not-yet-reported pair below.
    /scanner_paused/u,
    {
      sentence: 'Background indexing is paused on this computer.',
      nextStep: 'Run mnemonik scanner resume to start it again.',
    },
  ],
  [
    // The server refused the scanner's own sign-in (revoked or replaced).
    /scanner_signed_out/u,
    {
      sentence: 'Background indexing has lost its sign-in on this computer.',
      nextStep: 'Run mnemonik repair.',
    },
  ],
  [
    // The running scanner reported its own failure (L-155); doctor prints the cause.
    /scanner_failing/u,
    {
      sentence: 'Background indexing is failing on this computer.',
      nextStep: 'Run mnemonik doctor to see why.',
    },
  ],
  [
    /scanner_not_verified|background_indexing_not_verified|dev_release_source/iu,
    {
      sentence: 'The scanner has not checked in yet.',
      nextStep: 'Wait a minute for indexing to start.',
    },
  ],
  [
    /hook_not_verified|hooks? (?:still )?needs? verification|could not be inspected/iu,
    {
      sentence: 'Mnemonik has not received context from a coding tool hook yet.',
      nextStep: 'Start a new session in that coding tool.',
    },
  ],
  [
    /hooks_missing|hook (?:declaration|credential family) is missing|hooks are not installed/iu,
    {
      sentence: 'The Mnemonik hooks are not installed correctly for a coding tool.',
      nextStep: 'Run mnemonik repair on this machine, then restart the coding tool.',
    },
  ],
  [
    /host_grant_unbound|credential_revoked/iu,
    {
      sentence: 'A coding tool is signed out of Mnemonik on this machine.',
      nextStep: 'Sign in to Mnemonik from that coding tool to restore context.',
    },
  ],
  [
    /host_not_connected|signed in, not connected yet/iu,
    {
      sentence: 'A coding tool is signed in but has not used Mnemonik yet.',
      nextStep: 'Open the coding tool and start a session in a connected project.',
    },
  ],
  [
    /scanner_omitted|scanner (?:was |coverage was )?(?:deliberately )?(?:omitted|skipped)/iu,
    {
      sentence: 'The scanner is not watching projects on this machine.',
      nextStep: 'Run mnemonik add <folder> for each project you want indexed.',
    },
  ],
  [
    /project_uncovered|outside approved scanner roots/iu,
    {
      sentence: 'A connected project is outside the folders watched by the scanner.',
      nextStep: "Run mnemonik add <folder> with that project's folder.",
    },
  ],
  [
    /host_skipped/iu,
    {
      sentence: 'A coding tool on this machine is not connected to Mnemonik.',
      nextStep: 'Open that coding tool and sign in to Mnemonik.',
    },
  ],
  [
    /windows_task_creation_failed|windows.*task/iu,
    {
      sentence: 'Windows could not start the scanner in the background.',
      // Install sets up the background task; add needs a scanner already set up.
      nextStep: 'Run mnemonik install again from a terminal with permission to create tasks.',
    },
  ],
  [
    /unknown_version/u,
    {
      sentence: 'This project file was written by a newer Mnemonik.',
      nextStep: 'Run npx -y @mnemonik/cli@latest install to update Mnemonik, then try again.',
    },
  ],
  [
    /weak_permissions/u,
    {
      sentence: 'A Mnemonik credential file can be read by other users on this computer.',
      nextStep: 'Set that file to owner-only access, then run mnemonik status again.',
    },
  ],
  [
    /target_symlink|state_directory_symlink/u,
    {
      sentence: 'A file Mnemonik needs to write is a link to somewhere else.',
      nextStep: 'Replace that link with a real file or folder, then run mnemonik install again.',
    },
  ],
  [
    /journal_/u,
    {
      sentence: 'The record of the last installation cannot be trusted.',
      nextStep: 'Run npx -y @mnemonik/cli@latest install to start a clean installation.',
    },
  ],
  [
    // The bootstrap's word for a copy it cannot trust: a link, a checkout, or a
    // file npm did not put there.
    /^permission$/u,
    {
      sentence: 'This copy of Mnemonik is not the one npm installed.',
      nextStep: 'Run npx -y @mnemonik/cli@latest install to install it again.',
    },
  ],
  [
    /permission_denied/u,
    {
      sentence: 'Mnemonik does not have permission to write a file it needs.',
      nextStep: 'Give yourself write access to that file, then run mnemonik install again.',
    },
  ],
  [
    /target_read_only/u,
    {
      sentence: "A coding tool's settings file cannot be written.",
      nextStep: 'Give yourself write access to that file, then run mnemonik install again.',
    },
  ],
  [
    /digest_mismatch|unsigned/u,
    {
      sentence: 'The installed Mnemonik files do not match what Mnemonik published.',
      nextStep: 'Run npx -y @mnemonik/cli@latest install to replace them.',
    },
  ],
  [
    /manifest_missing/u,
    {
      sentence: 'Mnemonik could not find the files for this version.',
      nextStep: 'Run npx -y @mnemonik/cli@latest install to fetch them again.',
    },
  ],
  [
    /post_commit_upload_failed|status could not be uploaded/iu,
    {
      sentence: 'Setup finished on this machine, but its status did not reach Mnemonik.',
      nextStep: 'Run mnemonik repair to send it again.',
    },
  ],
  [
    /indexing_failed|indexing failed/iu,
    {
      sentence: 'The scanner could not index one or more projects.',
      nextStep: 'Run mnemonik install to set indexing up again.',
    },
  ],
  [
    /indexing_stalled|not_reporting|indexing stalled/iu,
    {
      sentence: 'The scanner stopped making progress.',
      nextStep: 'Run mnemonik install to start it again.',
    },
  ],
];

/** A condition's own action, said as a step rather than as a command on its own. */
const stepFrom = (action: string | undefined): string =>
  !action ? '' : /^[A-Z].*[.!?]$/u.test(action) ? action : `Run ${action}.`;

/** A code with no words still stopped something, so the failure is said plainly. */
const unnamedFailure: ReadinessMessage = {
  sentence: 'Mnemonik stopped before it finished.',
  nextStep: 'Run mnemonik repair.',
};

/** A reason the code wrote for a person already reads as a sentence. */
const writtenForPeople = (reason: string): boolean => /\s/u.test(reason) && /\.$/u.test(reason);

/**
 * The words for one condition. A reason with no table entry keeps its own
 * sentence and its own step, so nothing reaches a person as a reason code.
 */
export function messageFor(
  reason: string,
  actions: readonly string[] = [],
  action?: string
): ReadinessMessage {
  const matched = readinessMessages.find(([pattern]) => pattern.test(reason))?.[1];
  if (matched) return matched;
  // Older summaries carry reasons and actions apart; one action belongs to one reason.
  return writtenForPeople(reason)
    ? { sentence: reason, nextStep: stepFrom(action ?? (actions.length === 1 ? actions[0] : '')) }
    : unnamedFailure;
}

/** Keep internal diagnostics in JSON and logs; human errors use the approved status copy. */
export function humanReason(reason: string): string {
  if (reason === 'lock_held')
    return 'Another mnemonik command holds the state lock; retry in a moment.';
  if (
    /^(?:filesystem_root|home_directory|temporary_directory|mnemonik_state_directory|user_data_directory|host_config_directory|broad_workspace_parent)$/u.test(
      reason
    )
  )
    return 'That folder cannot be used. Choose another folder.';
  const message = messageFor(reason);
  return message.nextStep ? `${message.sentence}\n${message.nextStep}` : message.sentence;
}

// Owner-approved 2026-09-21: stop and retry, with the npm command usable before installation.
export const bootstrapFailureMessage =
  'Installation stopped.\nRun npx -y @mnemonik/cli@latest install to try again.';

/** Older journals mix sentences and reason codes. Preserve their sentences and actionable paths. */
export function humanReport(report: string): string {
  const malformedHost =
    /^(claude-code|codex|cursor): (?:invalid_json|invalid_toml|foreign_schema)\.$/u.exec(
      report
    )?.[1];
  if (malformedHost) {
    const name =
      malformedHost === 'claude-code'
        ? 'Claude Code'
        : malformedHost === 'codex'
          ? 'Codex'
          : 'Cursor';
    return `${name} was skipped because Mnemonik could not use its settings file.`;
  }
  const code =
    /(?:^|[:(]\s*)([a-z][a-z0-9]*(?:_[a-z0-9]+)+|permission|unsigned|E[A-Z]+)(?=$|[.):\s])/u.exec(
      report
    )?.[1];
  return code
    ? humanReason(code)
    : /^[a-z][a-z0-9_]*$/u.test(report)
      ? humanReason(report)
      : report;
}

const projectActionLabels: Record<string, string> = {
  choose_personal_or_team_owner: 'Choose a personal or team account',
  use_parent_identity: 'Use the parent project identity',
  initialize_nested_separately: 'Set up the nested project separately',
  select_main_or_worktree_identity: 'Choose the main checkout or worktree identity',
  link: 'Connect this folder to the project its file names',
  create: 'Create a new project for this folder',
  restore: 'Restore the archived project',
  upgrade: 'Upgrade your plan in the Mnemonik web console',
  ignore: 'Leave this folder out on this machine',
  switch_account: 'Sign in to the account that owns that project',
  ask_owner: "Ask the project's owner to add you",
  account_action: 'Sort the account out in the Mnemonik web console',
  administrator_recovery: 'Ask a Mnemonik administrator to recover that project',
  recover_identity: 'Write a new project file for this folder',
  replace: 'Replace the project this folder names',
  provide_owner: 'Choose a personal or team account',
  rerun_with_apply: 'Run the command again with --apply',
  provide_project_uuid: 'Supply the project ID from the Mnemonik web console',
  confirm_mismatch: 'Confirm the repository mismatch with --confirm-mismatch',
};

export function humanProjectAction(action: string): string {
  return projectActionLabels[action] ?? (action.includes('_') ? humanReason(action) : action);
}

/** The sentence for an action, or nothing when Mnemonik has no plain words for it. */
export function projectActionSentence(action: string): string | undefined {
  return projectActionLabels[action];
}

export function humanIdentityState(state: string): string {
  const labels: Record<string, string> = {
    v0: 'Previous project identity format.',
    v1: 'Current project identity format.',
    absent: 'No project identity found.',
    cursor_match: 'Cursor project identity matches.',
  };
  return labels[state] ?? humanReason(state);
}
