type ReadinessMessage = { sentence: string; nextStep: string };

// Codex hooks are trusted in Codex settings and Codex never asks, so this
// never says "allow the hooks" or promises a prompt.
export const CODEX_TRUST_MESSAGE = {
  sentence: 'Codex has not trusted the Mnemonik hooks yet.',
  nextStep: 'Open Codex settings, trust the Mnemonik hooks, then quit and reopen Codex.',
} satisfies ReadinessMessage;

const readinessMessages: Array<[RegExp, ReadinessMessage]> = [
  [
    /^discovery_failed$/u,
    {
      sentence: 'Mnemonik could not be reached.',
      nextStep: 'Check your internet connection, then try again.',
    },
  ],
  [
    // The server answered, so the connection is fine and the fault is ours.
    /^discovery_unavailable$/u,
    {
      sentence: 'Mnemonik is not available right now.',
      nextStep: 'Try again in a few minutes.',
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
      sentence: 'Your editor is waiting for permission to use Mnemonik.',
      nextStep: 'Open the editor, approve Mnemonik, then start a new session.',
    },
  ],
  [
    /restart_pending|needs? (?:a )?restart/iu,
    {
      sentence: 'An editor needs to restart before Mnemonik can work.',
      nextStep: 'Quit and reopen the editor, then start a new session.',
    },
  ],
  [
    /project_identity_choice_pending|project_setup_required|project identity|pending project setup/iu,
    {
      sentence: 'A project on this machine still needs to be connected.',
      nextStep: 'Run mnemonik status in the project and follow the project setup step.',
    },
  ],
  [
    /scanner_not_verified|background_indexing_not_verified|scanner_paused|dev_release_source/iu,
    {
      sentence: 'The scanner has not checked in yet.',
      nextStep: 'Run mnemonik status on this machine after the scanner starts.',
    },
  ],
  [
    /hook_not_verified|hooks? (?:still )?needs? verification|could not be inspected/iu,
    {
      sentence: 'Mnemonik has not received context from an editor hook yet.',
      nextStep: 'Start a new editor session, then run mnemonik status.',
    },
  ],
  [
    /hooks_missing|hook (?:declaration|credential family) is missing|hooks are not installed/iu,
    {
      sentence: 'The Mnemonik hooks are not installed correctly for an editor.',
      nextStep: 'Run mnemonik repair on this machine, then restart the editor.',
    },
  ],
  [
    /host_grant_unbound|credential_revoked/iu,
    {
      sentence: 'An editor is signed out of Mnemonik on this machine.',
      nextStep: 'Sign in to Mnemonik from that editor to restore context.',
    },
  ],
  [
    /host_not_connected|signed in, not connected yet/iu,
    {
      sentence: 'An editor is signed in but has not used Mnemonik yet.',
      nextStep: 'Open the editor and start a session in a connected project.',
    },
  ],
  [
    /scanner_omitted|scanner (?:was |coverage was )?(?:deliberately )?(?:omitted|skipped)/iu,
    {
      sentence: 'The scanner is not watching projects on this machine.',
      nextStep: 'Run mnemonik scanner enable to choose the projects to watch.',
    },
  ],
  [
    /project_uncovered|outside approved scanner roots/iu,
    {
      sentence: 'A connected project is outside the folders watched by the scanner.',
      nextStep: 'Run mnemonik scanner enable and add that project.',
    },
  ],
  [
    /host_skipped/iu,
    {
      sentence: 'An editor on this machine is not connected to Mnemonik.',
      nextStep: 'Open that editor and sign in to Mnemonik.',
    },
  ],
  [
    /windows_task_creation_failed|windows.*task/iu,
    {
      sentence: 'Windows could not start the scanner in the background.',
      nextStep:
        'Run mnemonik scanner enable again from a terminal with permission to create tasks.',
    },
  ],
  [
    /post_commit_upload_failed|status could not be uploaded/iu,
    {
      sentence: 'Setup finished on this machine, but its status did not reach Mnemonik.',
      nextStep: 'Run mnemonik doctor, then run mnemonik status again.',
    },
  ],
  [
    /indexing_failed|indexing failed/iu,
    {
      sentence: 'The scanner could not index one or more projects.',
      nextStep: 'Run mnemonik doctor on this machine and follow the scanner repair step.',
    },
  ],
  [
    /indexing_stalled|not_reporting|indexing stalled/iu,
    {
      sentence: 'The scanner stopped making progress.',
      nextStep: 'Run mnemonik doctor on this machine and restart the scanner when prompted.',
    },
  ],
  [
    /selected_component_failed|failed|unreachable/iu,
    {
      sentence: 'Part of Mnemonik did not finish setting up.',
      nextStep: 'Run mnemonik doctor on this machine and follow the first repair step.',
    },
  ],
  [
    /login_pending|sign.?in|grants? could not be verified|access has not been verified/iu,
    {
      sentence: 'A Mnemonik sign-in has not finished on this machine.',
      nextStep: 'Finish signing in from the editor, then run mnemonik status.',
    },
  ],
];

export const genericReadinessMessage: ReadinessMessage = {
  sentence: 'This machine needs attention before Mnemonik can work fully.',
  nextStep: 'Run mnemonik doctor on this machine and follow the first repair step.',
};

export function messageFor(reason: string, actions: readonly string[] = []): ReadinessMessage {
  if (
    /^(?:The mnemonik command|No editor connections|.+ (?:hooks|connection)) .+\.$/u.test(reason)
  ) {
    const prefix = reason.startsWith('The mnemonik command')
      ? 'Run npx '
      : reason.startsWith('Claude Code connection is turned off')
        ? 'In Claude Code'
        : reason.startsWith('Codex connection is turned off')
          ? 'Open ~/.codex'
          : reason.startsWith('Cursor connection is turned off')
            ? 'Open Cursor '
            : 'Run mnemonik install ';
    return {
      sentence: reason,
      nextStep:
        actions.find((action) => action.startsWith(prefix)) ?? genericReadinessMessage.nextStep,
    };
  }
  return (
    readinessMessages.find(([pattern]) => pattern.test(reason))?.[1] ?? genericReadinessMessage
  );
}

/** Keep internal diagnostics in JSON and logs; human errors use the approved status copy. */
export function humanReason(reason: string): string {
  if (reason === 'lock_held')
    return 'Another mnemonik command holds the state lock; retry in a moment.';
  if (
    /^(?:filesystem_root|home_directory|temporary_directory|mnemonik_state_directory|user_data_directory|host_config_directory|broad_workspace_parent|non_git_selection_required)$/u.test(
      reason
    )
  )
    return 'That folder cannot be used. Choose another folder.';
  const message = messageFor(reason);
  return `${message.sentence}\n${message.nextStep}`;
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
  select_non_git: 'Confirm this folder is not a Git repository',
  rerun_with_apply: 'Run the command again with --apply',
  provide_project_uuid: 'Supply the project ID from the Mnemonik web console',
  confirm_mismatch: 'Confirm the repository mismatch with --confirm-mismatch',
};

export function humanProjectAction(action: string): string {
  return projectActionLabels[action] ?? (action.includes('_') ? humanReason(action) : action);
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
