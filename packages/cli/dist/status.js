import { cliCredentialStatus } from './auth/credentials.js';
import { bindInstalledHostGrants, grantHost } from './auth/status.js';
import { readOwnership } from './install/ownership.js';
import { apiOrigin } from '@mnemonik/shared';
import { scannerReceipt } from './scanner/control.js';
import { stateDirectory } from '@mnemonik/local-setup';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { devReadiness } from './runtime/releaseSource.js';
import { pendingProjectSetup } from '@mnemonik/shared/hook-runtime';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { describeReadiness, reduceReadiness, serializeReadiness as baseReadiness, } from '@mnemonik/shared';
import { Output } from './output.js';
import { runProjectCommand, } from './project.js';
import { hostOrder } from './install/adapters.js';
import { hookStatusConditions, hostNotConnectedCondition, hostStillConnectingCondition, } from './install/hosts.js';
import { launcherStatus } from './launcher.js';
const contains = (parent, child) => {
    const path = relative(resolve(parent), resolve(child));
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};
function scannerConditions(installationConditions, projectRoot, scanner) {
    const unverified = installationConditions.find((condition) => condition.kind === 'scanner_not_verified');
    if (unverified)
        return [unverified];
    if (installationConditions.some((condition) => condition.kind === 'scanner_omitted'))
        return [
            {
                kind: 'scanner_omitted',
                reason: 'Scanner was deliberately omitted for this installation.',
                action: 'Run mnemonik scanner enable to add this project.',
            },
        ];
    if (!scanner)
        return [];
    const excluded = scanner.exclusions.some((path) => contains(path, projectRoot));
    if (excluded)
        return [
            {
                kind: 'scanner_omitted',
                reason: 'Scanner coverage was deliberately omitted for this project.',
                action: 'Run mnemonik scanner enable to add this project.',
            },
        ];
    if (scanner.roots.some((root) => contains(root, projectRoot)))
        return [];
    return [
        {
            kind: 'project_uncovered',
            reason: `${projectRoot} is outside approved scanner roots.`,
            action: `mnemonik roots add ${projectRoot}`,
        },
    ];
}
function projectConditions(input) {
    const project = input.projectStatus;
    if (!project)
        return [];
    const conditions = [];
    if (project.reachability === 'unreachable')
        conditions.push({
            kind: 'selected_component_failed',
            reason: 'The recorded project root is unreachable.',
            action: `mnemonik project status ${project.resolvedRoot}`,
        });
    else if (project.identity !== 'ok')
        conditions.push({
            kind: 'project_identity_choice_pending',
            reason: `Project identity is ${project.identity}.`,
            action: `mnemonik project init ${project.resolvedRoot}`,
        });
    else if (!project.server)
        conditions.push({
            kind: 'login_pending',
            reason: 'Project access has not been verified.',
            action: 'Run mnemonik install to sign in.',
        });
    else if (project.server !== 'access')
        conditions.push({
            kind: 'project_identity_choice_pending',
            reason: `Project access is ${project.server}.`,
            action: `mnemonik project status ${project.resolvedRoot}`,
        });
    conditions.push(...scannerConditions(input.installationConditions, project.resolvedRoot, input.scannerStatus), ...(input.projectHookConditions ?? []));
    return conditions;
}
export function buildStatusDocument(input) {
    const scannerNotVerified = input.scannerStatus
        ? []
        : [
            {
                kind: 'scanner_not_verified',
                component: 'scanner',
                reason: 'scanner_not_verified',
                action: 'run mnemonik status after the scanner service starts',
            },
        ];
    const hooksNotVerified = input.projectHookConditions
        ? []
        : (input.configuredHosts ?? ['host']).map((host) => ({
            kind: 'hook_not_verified',
            component: host,
            reason: 'hook_not_verified',
            action: `run mnemonik status after the ${host} hook starts`,
        }));
    const installationConditions = [
        ...input.installationConditions,
        ...scannerNotVerified,
        ...hooksNotVerified,
    ];
    const project = input.projectStatus;
    const conditions = projectConditions({
        ...input,
        installationConditions,
        projectHookConditions: input.projectHookConditions ?? hooksNotVerified,
    });
    const scannerOmitted = installationConditions.some((condition) => condition.kind === 'scanner_omitted');
    return serializeReadiness({
        ...input.details,
        installation: { conditions: installationConditions },
        ...(project
            ? {
                projects: [
                    {
                        projectId: project.projectId,
                        displayName: basename(project.resolvedRoot),
                        repositoryMatch: project.identity,
                        identityFile: null,
                        summary: { conditions },
                        action: conditions.find((condition) => condition.action)?.action ?? null,
                    },
                ],
            }
            : {}),
        scanner: input.scannerStatus
            ? {
                roots: input.scannerStatus.roots,
                heartbeatAt: input.scannerHeartbeat?.at ?? null,
                version: input.scannerHeartbeat?.version ?? null,
                readiness: scannerOmitted
                    ? reduceReadiness([
                        { kind: 'scanner_omitted', reason: 'Limited Mode was acknowledged.' },
                    ])
                    : null,
                acceptedDisclosureVersion: input.scannerHeartbeat?.disclosureVersion ?? null,
            }
            : null,
        limitedMode: scannerOmitted
            ? {
                acknowledgement: 'Limited Mode was acknowledged.',
                enableScannerAction: 'npx -y @mnemonik/cli@latest scanner enable',
            }
            : null,
        generatedAt: input.generatedAt,
    });
}
export function renderStatusSummaries(document, output) {
    if (document.cliCredential)
        output.line(`CLI credential: store=${document.cliCredential.store ?? 'unknown'} present=${document.cliCredential.present}${document.cliCredential.diagnostics.length ? ` (${document.cliCredential.diagnostics.join(', ')})` : ''}`);
    if (document.cliCredential?.detail)
        output.line(document.cliCredential.detail);
    if (document.launcher)
        output.line(`Launcher: ${document.launcher.ownership === 'ours' ? 'present and ours' : document.launcher.ownership === 'not_ours' ? 'present and not ours' : 'missing'}; ${document.launcher.path}; directory ${document.launcher.onPath ? 'on' : 'off'} current PATH. ${document.launcher.action}`);
    output.line(`Installation: ${describeReadiness(document.installation)}`);
    for (const grant of document.devicesAndGrants ?? [])
        if (grant.resource === `${apiOrigin()}/mcp`)
            output.line(`${grant.client}: ${grant.device ?? 'host_grant_unbound'}`);
    const project = document.projects?.[0];
    if (project)
        output.line(`This project: ${describeReadiness(project.summary)}`);
}
export function statusExitCode(document) {
    const states = [document.installation, ...(document.projects ?? []).map((row) => row.summary)];
    if (states.some((summary) => summary.state === 'FAILED'))
        return 1;
    return states.some((summary) => summary.state !== 'READY') ? 3 : 0;
}
export async function readProjectStatus(input) {
    let text = '';
    const writer = { write: (chunk) => (text += chunk) };
    await runProjectCommand({
        command: 'status',
        json: true,
        nonInteractive: true,
        apply: false,
        nonGit: false,
        confirmMismatch: false,
        replace: false,
    }, { ...input, output: new Output(writer) });
    return JSON.parse(text);
}
export async function collectStatusDocument(input) {
    const statusStateDir = input.stateDir ?? stateDirectory(process.platform, process.env, input.home);
    let scannerStatus = await input.scannerStatus?.();
    let scannerHeartbeat;
    let scannerReason;
    if (!input.scannerStatus) {
        const receipt = await scannerReceipt(statusStateDir);
        const state = JSON.parse(await readFile(join(statusStateDir, 'scanner/state.json'), 'utf8').catch(() => 'null'));
        const snapshot = receipt?.snapshot;
        const heartbeat = snapshot?.heartbeat.lastSuccess;
        if (snapshot?.devReleaseSource || state?.devReleaseSource)
            scannerReason = { kind: 'scanner_not_verified', reason: 'dev_release_source' };
        if (snapshot?.lifecycle.reason === 'credential_revoked')
            scannerReason = {
                kind: 'login_pending',
                reason: 'credential_revoked',
                action: 'mnemonik scanner enable',
            };
        else if (snapshot?.lifecycle.state === 'paused')
            scannerReason = {
                kind: 'scanner_not_verified',
                reason: 'scanner_paused',
                action: 'mnemonik scanner resume',
            };
        let alive = false;
        if (snapshot?.lifecycle.pid)
            try {
                process.kill(snapshot.lifecycle.pid, 0);
                alive = true;
            }
            catch {
                /* stale receipt */
            }
        if (state &&
            alive &&
            (snapshot?.lifecycle.state === 'running' || snapshot?.lifecycle.state === 'starting') &&
            heartbeat &&
            Date.now() - heartbeat < 360000) {
            scannerStatus = {
                roots: state.config.roots,
                exclusions: state.config.exclusions ?? [],
                repositories: [],
            };
            scannerHeartbeat = {
                at: new Date(heartbeat).toISOString(),
                version: snapshot.version,
                disclosureVersion: state.consent?.disclosureVersion ?? null,
            };
        }
    }
    const installationConditions = [
        ...(input.installationConditions ?? []),
        ...(scannerReason ? [scannerReason] : []),
        ...(input.preflight.status === 'ready'
            ? []
            : [
                {
                    kind: 'host_trust_pending',
                    reason: 'Preflight needs attention before installation can continue.',
                    action: 'Resolve the preflight checks and run mnemonik doctor again.',
                },
            ]),
        ...(scannerStatus?.repositories
            .filter((repository) => !repository.selected)
            .map((repository) => ({
            kind: 'scanner_omitted',
            component: repository.path,
            reason: `${repository.path} was omitted from scanner coverage.`,
            action: 'Run mnemonik scanner enable to change coverage.',
        })) ?? []),
    ];
    const owned = await readOwnership(statusStateDir);
    const details = { ...input.details };
    const targets = owned.targets.filter((target) => target.component === 'mcp');
    if (targets.length && input.grants) {
        try {
            const listing = await input.grants.list();
            await bindInstalledHostGrants(listing, targets
                .filter((target) => !target.grant || target.grant.account === listing.account)
                .map((target) => target.host), input.grants);
            details.devicesAndGrants = listing.grants
                .filter((g) => grantHost(g) &&
                (g.activatedAt ||
                    (listing.deviceInstallationId &&
                        g.deviceInstallationId === listing.deviceInstallationId)) &&
                g.scopes.includes('mcp:use') &&
                g.resource === `${apiOrigin()}/mcp`)
                .map((g) => ({
                id: g.id,
                client: grantHost(g) ?? g.clientId,
                device: listing.deviceInstallationId && g.deviceInstallationId === listing.deviceInstallationId
                    ? g.activatedAt
                        ? 'connected to this machine'
                        : 'signed in, not connected yet'
                    : 'host_grant_unbound',
                platform: null,
                scopes: g.scopes,
                resource: g.resource,
                createdAt: g.createdAt,
                lastUsedAt: g.lastUsedAt,
                expiresAt: null,
                incompleteInstallation: !g.deviceInstallationId,
                revokeAction: `mnemonik auth logout --host ${grantHost(g)}`,
            }));
            for (const target of targets) {
                const matchesTarget = (g) => !target.grant || (target.grant.account === listing.account && target.grant.id === g.id);
                const live = listing.grants.find((g) => g.resource === `${apiOrigin()}/mcp` &&
                    g.activatedAt &&
                    g.scopes.includes('mcp:use') &&
                    grantHost(g) === target.host &&
                    matchesTarget(g));
                const notConnected = listing.grants.find((g) => listing.deviceInstallationId &&
                    g.deviceInstallationId === listing.deviceInstallationId &&
                    !g.activatedAt &&
                    g.resource === `${apiOrigin()}/mcp` &&
                    g.scopes.includes('mcp:use') &&
                    grantHost(g) === target.host &&
                    matchesTarget(g));
                const liveHere = listing.deviceInstallationId &&
                    live?.deviceInstallationId === listing.deviceInstallationId;
                if (!liveHere && notConnected) {
                    installationConditions.push(hostNotConnectedCondition(target.host));
                    continue;
                }
                if (!listing.deviceInstallationId ||
                    !live?.deviceInstallationId ||
                    live.deviceInstallationId !== listing.deviceInstallationId)
                    // No recorded grant means install never bound one: the host was skipped or its sign-in
                    // never finished. A recorded grant that no longer resolves was revoked elsewhere.
                    installationConditions.push(listing.deviceInstallationId && !target.grant
                        ? hostStillConnectingCondition(target.host)
                        : {
                            kind: 'host_grant_unbound',
                            component: target.host,
                            reason: `${target.host}: host_grant_unbound`,
                            action: !listing.deviceInstallationId
                                ? 'mnemonik install'
                                : `mnemonik connect ${target.host}`,
                        });
            }
        }
        catch {
            installationConditions.push({
                kind: 'login_pending',
                reason: 'Host grants could not be verified.',
                action: 'mnemonik auth login',
            });
        }
    }
    const projectStatus = input.preflight.project.root ? await readProjectStatus(input) : undefined;
    const pending = await pendingProjectSetup(projectStatus?.resolvedRoot ?? input.cwd).catch(() => []);
    const setupConditions = pending.map((diagnostic) => ({
        kind: 'project_identity_choice_pending',
        reason: 'A local hook reports pending project setup.',
        action: diagnostic.action,
    }));
    installationConditions.unshift(...setupConditions);
    const hosts = (input.configuredHosts ??
        owned.targets.filter((target) => target.component === 'hooks').map((target) => target.host)).filter((host) => hostOrder.includes(host));
    const hookConditions = input.projectHookConditions ??
        (await hookStatusConditions({ stateDir: statusStateDir }, hosts));
    installationConditions.push(...hookConditions);
    const document = buildStatusDocument({
        installationConditions,
        projectStatus,
        scannerStatus,
        scannerHeartbeat,
        projectHookConditions: hookConditions,
        configuredHosts: input.configuredHosts,
        details,
        generatedAt: input.generatedAt,
    });
    return {
        ...document,
        launcher: await launcherStatus({
            stateDir: statusStateDir,
            home: input.home,
            ...input.launcher,
        }),
        cliCredential: await cliCredentialStatus({
            stateDir: statusStateDir,
        }),
    };
}
const serializeReadiness = (input) => devReadiness(baseReadiness(input));
//# sourceMappingURL=status.js.map