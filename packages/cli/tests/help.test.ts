import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { helpScreen } from '../src/help.js';

const cases: Array<[string[], string]> = [
  [[], '2aa0bf6dac65080300d5351e4f5a922e965ee51229038c4df22fcc8985b699df'],
  [['install'], 'b4a2ccea9c6296a7ea62ad5e6f88382532f2ea9fc5083eded04d568bf14bc245'],
  [['status'], 'be93499c3d0c4aaea2ecb909da085c7d1f5d298c19a0478af9b1694c01d2f529'],
  [['add'], '5ce2e2d07d1e44c55ac1f195e1f3273b0b0f18d83fed215ffd52886990d08544'],
  [['remove'], '934e26698e5be6d3e60a900bf3663b11a76f99d4f51bac9080bcdab3f769c087'],
  [['connect'], '1a33eeaf30c4428995f2378258a5d5e8708606d0f30cc1469b18765a2fd25380'],
  [['project'], '550e4cb12dbbcad4224471d7cab14b5b3c44c93243ef2fa7d674420617395507'],
  [['project', 'status'], 'ac91f509f89f40979bdf153762bf6469a757977824513e71c33541f39c204888'],
  [['project', 'init'], '0faf3860f8fb3774377d9d3652720285a3b8c53bd122c221cb3610128f8991cf'],
  [['project', 'link'], 'f301e7f0048618dcdefa9c1b95ab78f179abaaf16766e6741b6b0c978398d30d'],
  [['project', 'setup'], 'c8b7a899717cc36e5ccf0f8c429ee80f848189fdc64741a1228e47f7c274ca98'],
  [['project', 'delete'], '52ada4c76ea7c4ec6f5f7cb5ccf62b65712be2c2a0296128db656cccd6ad29e9'],
  [['project', 'ensure'], '0f118185fa1d51658f384e5d4ae4994b4ee2ea93c7ceda2e03c2373b1eec0da7'],
  [['update'], '5ccdd574df6aa6ffdf5ff4f044b733e1a302f839eeb19867470b6a2f0a222548'],
  [['repair'], 'f87e3bcde4e615cbf88a9d96b7e90768b340d300470fd33430cd03f0bb38d855'],
  [['doctor'], 'a65a56632778466dff6b9b13d2d39398995ad6f9d7c851b0d88f8e7900746209'],
  [['uninstall'], 'cbc6cb48fcc831226682ef40ed61f19491081ae496e1784dfcb60d35175ec847'],
  [['auth'], '1184384f5215de5ed19c15df672385424f27504aef270db6eed2268a0ad6a8bd'],
  [['auth', 'login'], '9422a764f3db2a0e22641b584ef59aa2e0ded0b65c11317d9a8944e950cfec00'],
  [['auth', 'renew'], '0e55b35cd893d792ca29e78576ca8d1b02889ae87e9e8c789015c51f1adef95f'],
  [['auth', 'status'], '611c789026fc2b174599f7995bae7b2e7daf3793ae768c92f9bd22be337d0e7a'],
  [['auth', 'logout'], 'bdb31d62c8671bbf1e24db35e127af9facf27397e6b4a1e6f7f296cd725a1dca'],
  [['logout'], '42829b9975b9b44f4f23e40f7c4c0a7c7b3e18e1be067334b371dd20e6273891'],
  [['scanner'], '9e740af09eb58321ebf476507ddaf44c0706fa31c924556589c20d98c05e0a68'],
  [['scanner', 'enable'], '2a1b59bacde9caf31bfe197eda04ef71e813c7b48b912ef979bbcaa522bee5bf'],
  [['scanner', 'start'], 'e54e48d455b327b126344d5793aab4519b2013ec57f9ce268206115f6cf3f016'],
  [['scanner', 'stop'], '1f7aebfdf41f4dd9207ff1e6c2ec5d8eef89bfe439701314fb0f6d80f5ade0e1'],
  [['scanner', 'pause'], '346b9a6c17b71ca375abfba216dcd437e663fc7423b51e9a38ffb1908ddc4ff5'],
  [['scanner', 'resume'], '62c6f17a466ef5984bb8082d3dadfe0ffbe868918fda42f2e0a8378efa45519f'],
  [['scanner', 'status'], '032eae080a634f08a429d5685468a20a58890e274546e7528626405021c9abd0'],
  [['scanner', 'uninstall'], 'f3a42cb95f0d93ce18a99d719dabe3f875c53c85341fe36f91ac193ef018432a'],
  [
    ['scanner', 'export-preview'],
    'b95119b1616a97c049bad67d2554ba0f237d23f1acbb3ffa0e0a35d4918c2d83',
  ],
  [['roots'], 'af842c6f07b45bb67a277c5741bd4ad91a4f07bd22b54258bf9c58b5e95b3d32'],
  [['data', 'delete'], '34b127120cd7d9f5e4271cd8f23c336d8b0d825d56160e1a3ad6c08d8580c8c3'],
  [['diagnostics'], '44dd4ee1a8a5b83fb97b181f6bf91a3598d158b1541e3c4a8ea39e2c4d8889cd'],
  [['identity', 'migrate'], 'ce59e2580bbf0f699c9e67221040a5847dfacbfed3ced51ef0501647643e1df6'],
];

describe('approved help copy', () => {
  it.each(cases)('returns the exact screen for %j', (path, expectedHash) => {
    const screen = helpScreen(path);
    expect(screen).toBeDefined();
    expect(createHash('sha256').update(screen!).digest('hex')).toBe(expectedHash);
  });

  it('returns undefined for an unknown nested command', () => {
    expect(helpScreen(['project', 'frobnicate'])).toBeUndefined();
  });
});
