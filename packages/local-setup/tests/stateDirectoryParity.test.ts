/**
 * @mnemonik/shared keeps its own copy of the state folder rule
 * (`mnemonikStateDirectory`, used by the hook flight recorder and the
 * protected-path list) because it cannot import this package. The two must
 * give the same answer, or the hooks would write where the CLI never reads.
 */
import { expect, it } from 'vitest';
import { mnemonikStateDirectory } from '@mnemonik/shared';
import { stateDirectory } from '../src/storage.js';

const home = '/home/ada';
const cases: Array<[NodeJS.Platform, NodeJS.ProcessEnv, string]> = [
  ['linux', {}, home],
  ['linux', { XDG_STATE_HOME: '/var/state/ada' }, home],
  ['linux', { XDG_STATE_HOME: '' }, home],
  ['linux', { MNEMONIK_STATE_DIR: '/srv/mnemonik', XDG_STATE_HOME: '/x' }, home],
  ['darwin', {}, '/Users/ada'],
  ['darwin', { XDG_STATE_HOME: '/ignored' }, '/Users/ada'],
  ['win32', {}, 'C:\\Users\\Ada'],
  ['win32', { LOCALAPPDATA: 'D:\\Profiles\\Ada\\Local' }, 'C:\\Users\\Ada'],
  ['win32', { MNEMONIK_STATE_DIR: 'E:\\state' }, 'C:\\Users\\Ada'],
];

it.each(cases)('agrees with shared on %s %j', (platform, env, homeDir) => {
  expect(mnemonikStateDirectory(platform, env, homeDir)).toBe(
    stateDirectory(platform, env, homeDir)
  );
});
