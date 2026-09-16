import { homedir } from 'node:os';
import { posix, win32, type PlatformPath } from 'node:path';

type Platform = NodeJS.Platform;

function pathsFor(platform: Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

/** Local state and credential locations that Mnemonik must never scan. */
export function protectedLocalPaths(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  const path = pathsFor(platform);
  const localAppData = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
  const state =
    env.MNEMONIK_STATE_DIR ||
    (platform === 'win32'
      ? win32.join(localAppData, 'Mnemonik')
      : platform === 'darwin'
        ? posix.join(home, 'Library', 'Application Support', 'Mnemonik')
        : posix.join(env.XDG_STATE_HOME || posix.join(home, '.local', 'state'), 'mnemonik'));
  const common = [
    state,
    path.join(home, '.mnemonik'),
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.codex', 'auth.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.grok', 'mcp_credentials.json'),
  ];
  const osPaths =
    platform === 'darwin'
      ? [path.join(home, 'Library', 'Keychains')]
      : platform === 'win32'
        ? [
            win32.join(appData, 'Microsoft', 'Credentials'),
            win32.join(localAppData, 'Microsoft', 'Credentials'),
            win32.join(appData, 'Microsoft', 'Protect'),
          ]
        : [
            path.join(home, '.local', 'share', 'keyrings'),
            path.join(home, '.gnupg'),
            path.join(home, '.ssh'),
            path.join(home, '.aws'),
            path.join(home, '.config', 'gcloud'),
            path.join(home, '.docker', 'config.json'),
            path.join(home, '.npmrc'),
            path.join(home, '.netrc'),
            path.join(home, '.pypirc'),
          ];
  return [...new Set([...common, ...osPaths])];
}

function comparable(value: string, platform: Platform): string {
  const path = pathsFor(platform);
  const normalized = path.resolve(value);
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

/** True when candidate is the protected path itself or lies below it. */
export function isProtectedLocalPath(
  candidate: string,
  protectedPaths: readonly string[] = protectedLocalPaths(),
  platform: Platform = process.platform
): boolean {
  const path = pathsFor(platform);
  const target = comparable(candidate, platform);
  return protectedPaths.some((protectedPath) => {
    const parent = comparable(protectedPath, platform);
    const relative = path.relative(parent, target);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  });
}

/** Protected paths equal to or below root, for consent auto-exclusions. */
export function protectedPathsWithinRoot(
  root: string,
  protectedPaths: readonly string[] = protectedLocalPaths(),
  platform: Platform = process.platform
): string[] {
  return protectedPaths.filter((candidate) => isProtectedLocalPath(candidate, [root], platform));
}
